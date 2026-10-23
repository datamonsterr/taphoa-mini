//! Usage: ORT_DYLIB_PATH=... cargo run --release -p taphoa-recognition --example bench -- \
//!   <encoder.onnx> <decoder.onnx> <image> [runs] [points_per_side]
use std::time::Instant;
use taphoa_recognition::{SamOptions, SamSegmenter};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let runs: usize = a.get(4).and_then(|v| v.parse().ok()).unwrap_or(5);
    let mut options = SamOptions::default();
    if let Some(p) = a.get(5).and_then(|v| v.parse().ok()) {
        options.points_per_side = p;
    }
    let bytes = std::fs::read(&a[3]).unwrap();
    let t = Instant::now();
    let sam = SamSegmenter::load(a[1].as_ref(), a[2].as_ref(), options).unwrap();
    println!("load {:?}", t.elapsed());
    let mut times = Vec::new();
    for i in 0..runs {
        let t = Instant::now();
        let (s, tm) = sam.segment_with_timings(&bytes).unwrap();
        println!("  {tm:?}");
        let e = t.elapsed();
        println!("run {i}: {:?} ({} segments)", e, s.len());
        times.push(e.as_secs_f64());
    }
    times.sort_by(f64::total_cmp);
    println!(
        "median {:.3}s max {:.3}s",
        times[times.len() / 2],
        times[times.len() - 1]
    );
}
