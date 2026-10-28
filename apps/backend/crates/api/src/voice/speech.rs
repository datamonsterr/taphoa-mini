//! Speech gate: decide from signal energy whether a clip holds anything like speech, before any
//! model call. Audio-native models invent transcripts from the catalog hint when they get
//! silence or steady noise, so a clip with no sustained energy never reaches them.
//!
//! The clip is decoded (m4a/AAC, WAV, Ogg Vorbis; Opus is not supported and falls through),
//! mixed to mono and cut into 20 ms frames. The gate passes when some stretch of at least
//! 300 ms has frame RMS above [`RMS_THRESHOLD`], allowing brief dips (syllable gaps) of up to
//! [`HANGOVER_FRAMES`] frames inside a stretch. Calibration (full scale = 1.0):
//! silence 0.0000, the pink-noise clip peaks at 0.007 RMS, while the quietest TTS speech clips
//! hold 0.015-0.02 for 440+ ms with the hangover. The threshold is 0.012 (about -38 dBFS).
//! A clip that cannot be decoded is not judged ([`Verdict::Unknown`]) and goes to the model.
use super::audio::Format;
use symphonia::core::{
    codecs::audio::AudioDecoderOptions,
    errors::Error,
    formats::{FormatOptions, TrackType, probe::Hint},
    io::MediaSourceStream,
    meta::MetadataOptions,
};

pub const RMS_THRESHOLD: f32 = 0.012;
pub const FRAME_MS: u32 = 20;
pub const MIN_SPEECH_MS: u32 = 300;
pub const HANGOVER_FRAMES: u32 = 3;
/// More words per second than this is not human speech: a model made the transcript up.
pub const MAX_WORDS_PER_SECOND: f64 = 7.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Speech,
    Silent,
    /// Could not decode: no judgement, the model decides.
    Unknown,
}

/// Longest stretch (ms) of frames above the threshold, bridging dips of up to
/// [`HANGOVER_FRAMES`] frames.
pub fn longest_active_ms(frame_rms: &[f32]) -> u32 {
    let (mut best, mut run, mut gap) = (0u32, 0u32, 0u32);
    for rms in frame_rms {
        if *rms > RMS_THRESHOLD {
            run += 1 + gap;
            gap = 0;
            best = best.max(run);
        } else if run > 0 && gap < HANGOVER_FRAMES {
            gap += 1;
        } else {
            run = 0;
            gap = 0;
        }
    }
    best * FRAME_MS
}

/// RMS per 20 ms frame of mono samples at `rate` Hz (a trailing partial frame is dropped).
pub fn frame_rms(samples: &[f32], rate: u32) -> Vec<f32> {
    let size = (rate * FRAME_MS / 1000).max(1) as usize;
    samples
        .chunks_exact(size)
        .map(|frame| (frame.iter().map(|s| s * s).sum::<f32>() / size as f32).sqrt())
        .collect()
}

/// Decode to mono f32 samples and the sample rate.
fn decode(bytes: &[u8], format: Format) -> Option<(Vec<f32>, u32)> {
    let source = std::io::Cursor::new(bytes.to_vec());
    let stream = MediaSourceStream::new(Box::new(source), Default::default());
    let mut hint = Hint::new();
    hint.with_extension(format.as_str());
    let mut reader = symphonia::default::get_probe()
        .probe(
            &hint,
            stream,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .ok()?;
    let track = reader.default_track(TrackType::Audio)?;
    let track_id = track.id;
    let params = track.codec_params.as_ref()?.audio()?;
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(params, &AudioDecoderOptions::default())
        .ok()?;
    let (mut mono, mut rate, mut buffer) = (Vec::new(), 0u32, Vec::<f32>::new());
    while let Ok(Some(packet)) = reader.next_packet() {
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = decoded.spec();
                rate = spec.rate();
                let channels = spec.channels().count().max(1);
                buffer.resize(decoded.samples_interleaved(), 0.0);
                decoded.copy_to_slice_interleaved(&mut buffer);
                mono.extend(
                    buffer
                        .chunks_exact(channels)
                        .map(|c| c.iter().sum::<f32>() / channels as f32),
                );
            }
            Err(Error::DecodeError(_)) => {}
            Err(_) => return None,
        }
    }
    (rate > 0 && !mono.is_empty()).then_some((mono, rate))
}

/// Judge a clip. CPU-bound (about 10 ms for 30 s of AAC in release); callers on the async
/// runtime use `spawn_blocking`.
pub fn check(bytes: &[u8], format: Format) -> Verdict {
    let Some((samples, rate)) = decode(bytes, format) else {
        return Verdict::Unknown;
    };
    if longest_active_ms(&frame_rms(&samples, rate)) >= MIN_SPEECH_MS {
        Verdict::Speech
    } else {
        Verdict::Silent
    }
}

/// A transcript denser than human speech (words per second of audio) was invented.
pub fn implausible_rate(transcript: &str, audio_seconds: Option<f64>) -> bool {
    let Some(seconds) = audio_seconds.filter(|s| s.is_finite() && *s >= 0.0) else {
        return false;
    };
    let words = transcript.split_whitespace().count() as f64;
    words / seconds.max(1.0) > MAX_WORDS_PER_SECOND
}

#[cfg(test)]
mod tests {
    use super::*;

    const SILENCE: &[u8] = include_bytes!("testdata/39-silence.m4a");
    const NOISE: &[u8] = include_bytes!("testdata/40-noise-only.m4a");
    const QUIET_SPEECH: &[u8] = include_bytes!("testdata/02-single-lavie.m4a");
    const SPEECH: &[u8] = include_bytes!("testdata/08-single-omo.m4a");
    const NOISY_SPEECH: &[u8] = include_bytes!("testdata/49-noise-two-line.m4a");
    const E2E_SILENCE: &[u8] = include_bytes!("testdata/no-speech.m4a");
    const E2E_NOISY_SALE: &[u8] = include_bytes!("testdata/noisy-sale.m4a");

    #[test]
    fn silence_and_steady_noise_are_rejected() {
        for (name, clip) in [("silence", SILENCE), ("noise", NOISE), ("e2e", E2E_SILENCE)] {
            assert_eq!(check(clip, Format::M4a), Verdict::Silent, "{name}");
        }
    }

    #[test]
    fn speech_and_noisy_speech_pass() {
        for (name, clip) in [
            ("quiet", QUIET_SPEECH),
            ("normal", SPEECH),
            ("noisy", NOISY_SPEECH),
            ("e2e noisy", E2E_NOISY_SALE),
        ] {
            assert_eq!(check(clip, Format::M4a), Verdict::Speech, "{name}");
        }
    }

    #[test]
    fn undecodable_audio_is_not_judged() {
        assert_eq!(
            check(&super::super::audio::fixtures::ogg(1.0), Format::Ogg),
            Verdict::Unknown
        );
        assert_eq!(check(b"not audio at all", Format::M4a), Verdict::Unknown);
        assert_eq!(
            check(&super::super::audio::fixtures::m4a(1.0, b"x"), Format::M4a),
            Verdict::Unknown
        );
    }

    #[test]
    fn wav_is_decoded() {
        // Silence of 2 s, then the same with a 440 Hz tone for 1 s.
        let silent = super::super::audio::fixtures::wav(2.0);
        assert_eq!(check(&silent, Format::Wav), Verdict::Silent);
        let mut tone = super::super::audio::fixtures::wav(1.0);
        for (i, pair) in tone[44..].as_chunks_mut::<2>().0.iter_mut().enumerate() {
            let s = ((i as f32 / 16000.0 * 440.0 * std::f32::consts::TAU).sin() * 8000.0) as i16;
            pair.copy_from_slice(&s.to_le_bytes());
        }
        assert_eq!(check(&tone, Format::Wav), Verdict::Speech);
    }

    #[test]
    fn run_logic() {
        let quiet = [0.001_f32; 10];
        let loud = [0.1_f32; 14]; // 280 ms
        assert_eq!(
            longest_active_ms(&[quiet.as_slice(), &loud, &quiet].concat()),
            280
        );
        // A dip of up to 3 frames is bridged: 10 + 3 + 10 frames = 460 ms.
        let bridged = [[0.1_f32; 10].as_slice(), &[0.0; 3], &[0.1; 10]].concat();
        assert_eq!(longest_active_ms(&bridged), 460);
        // A 4-frame gap splits it: best is 10 frames = 200 ms.
        let split = [[0.1_f32; 10].as_slice(), &[0.0; 4], &[0.1; 10]].concat();
        assert_eq!(longest_active_ms(&split), 200);
        assert_eq!(longest_active_ms(&[]), 0);
    }

    #[test]
    fn speed_of_the_gate() {
        let started = std::time::Instant::now();
        for _ in 0..5 {
            assert_eq!(check(SPEECH, Format::M4a), Verdict::Speech);
        }
        // 3 s clips; the budget is 50 ms per 30 s, debug builds get generous headroom.
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn transcript_density() {
        let invented = "Cho mình lấy 2 lon bia Tiger, 1 gói mì Hảo Hảo tôm chua cay, với 1 chai nước suối Lavie nhé";
        assert!(implausible_rate(invented, Some(3.0)));
        assert!(!implausible_rate(
            "hai lon coca với một lon pepsi",
            Some(2.6)
        ));
        assert!(!implausible_rate(invented, Some(6.0)));
        // Unknown duration or a very short clip cannot condemn a transcript by itself.
        assert!(!implausible_rate(invented, None));
        assert!(!implausible_rate("một hai ba bốn năm sáu", Some(0.4)));
    }
}
