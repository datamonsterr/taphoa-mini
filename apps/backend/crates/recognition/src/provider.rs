//! Session policy shared by every recognition model. CUDA is opt-in at runtime;
//! the `cuda` feature with `load-dynamic` adds no link-time CUDA dependency.
use ort::{ep, session::builder::SessionBuilder};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    Cpu,
    Cuda { memory_bytes: usize },
}
impl Provider {
    pub fn parse(provider: Option<&str>, memory_mb: Option<&str>) -> Result<Self, String> {
        match provider.unwrap_or("cpu") {
            "cpu" => Ok(Self::Cpu),
            "cuda" => {
                let mb = memory_mb
                    .unwrap_or("3072")
                    .parse::<usize>()
                    .map_err(|_| "INFERENCE_GPU_MEM_MB must be a positive integer")?;
                let memory_bytes = mb
                    .checked_mul(1024 * 1024)
                    .filter(|b| *b > 0)
                    .ok_or("INFERENCE_GPU_MEM_MB is zero or too large")?;
                Ok(Self::Cuda { memory_bytes })
            }
            _ => Err("INFERENCE_PROVIDER must be cpu or cuda".into()),
        }
    }
    pub fn from_env() -> Result<Self, String> {
        Self::parse(
            std::env::var("INFERENCE_PROVIDER").ok().as_deref(),
            std::env::var("INFERENCE_GPU_MEM_MB").ok().as_deref(),
        )
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Cpu => "cpu",
            Self::Cuda { .. } => "cuda",
        }
    }
    pub fn threads(self, cpu_threads: usize) -> usize {
        match self {
            Self::Cpu => cpu_threads,
            Self::Cuda { .. } => 1,
        }
    }
    pub(crate) fn configure(self, builder: SessionBuilder) -> Result<SessionBuilder, String> {
        match self {
            Self::Cpu => Ok(builder),
            Self::Cuda { memory_bytes } => builder
                .with_execution_providers([ep::CUDA::default()
                    .with_device_id(0)
                    .with_conv_algorithm_search(ep::cuda::ConvAlgorithmSearch::Heuristic)
                    .with_memory_limit(memory_bytes)
                    .with_arena_extend_strategy(ep::ArenaExtendStrategy::SameAsRequested)
                    .build()
                    .error_on_failure()])
                .map_err(|e| {
                    format!("INFERENCE_PROVIDER=cuda: CUDA provider registration failed: {e}")
                }),
        }
    }
}

/// Set the primary CUDA context's host-wait policy before ORT creates sessions.
/// Keeping the library alive avoids unloading cudart while ORT holds CUDA state.
/// No CUDA library is opened on the default CPU path.
pub(crate) fn blocking_sync() -> Result<(), String> {
    static RUNTIME: std::sync::OnceLock<Result<libloading::Library, String>> =
        std::sync::OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            // SAFETY: NVIDIA's stable CUDA runtime ABI: cudaSetDeviceFlags(unsigned int)
            // returns cudaError_t (an integer). The library stays loaded for the process.
            unsafe {
                let library =
                    libloading::Library::new("libcudart.so.12").map_err(|e| e.to_string())?;
                let set_flags = library
                    .get::<unsafe extern "C" fn(u32) -> i32>(b"cudaSetDeviceFlags\0")
                    .map_err(|e| e.to_string())?;
                let code = set_flags(4); // cudaDeviceScheduleBlockingSync
                if code != 0 {
                    return Err(format!("cudaSetDeviceFlags(BlockingSync) returned {code}"));
                }
                Ok(library)
            }
        })
        .as_ref()
        .map(|_| ())
        .map_err(|e| format!("INFERENCE_PROVIDER=cuda: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn settings_are_strict_and_cpu_needs_no_cuda() {
        assert_eq!(Provider::parse(None, None).unwrap(), Provider::Cpu);
        let cuda = Provider::parse(Some("cuda"), None).unwrap();
        assert_eq!(
            cuda,
            Provider::Cuda {
                memory_bytes: 3072 * 1024 * 1024
            }
        );
        assert_eq!(cuda.threads(8), 1);
        assert_eq!(Provider::Cpu.threads(4), 4);
        for value in ["0", "-1", "x", "18446744073709551615"] {
            assert!(Provider::parse(Some("cuda"), Some(value)).is_err());
        }
        assert!(Provider::parse(Some("auto"), None).is_err());
    }
}
