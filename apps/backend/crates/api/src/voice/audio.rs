//! Container sniffing and duration from container metadata only (no decoding).
//!
//! The upload is trusted by magic bytes, not by `Content-Type`. Duration comes from the m4a
//! `mvhd` box, the WAV byte rate or the last Ogg granule position. A file whose duration cannot
//! be read is accepted: `VOICE_MAX_BYTES` already bounds it (1 MB is about 4 minutes of the
//! app's 32 kbps AAC), and the model call has its own timeout.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    M4a,
    Wav,
    Ogg,
}
impl Format {
    /// `format` value of the OpenRouter `input_audio` part.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::M4a => "m4a",
            Self::Wav => "wav",
            Self::Ogg => "ogg",
        }
    }
}

pub fn detect(bytes: &[u8]) -> Option<Format> {
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        Some(Format::M4a)
    } else if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE" {
        Some(Format::Wav)
    } else if bytes.starts_with(b"OggS") {
        Some(Format::Ogg)
    } else {
        None
    }
}

pub fn duration_seconds(bytes: &[u8], format: Format) -> Option<f64> {
    let seconds = match format {
        Format::M4a => m4a(bytes),
        Format::Wav => wav(bytes),
        Format::Ogg => ogg(bytes),
    }?;
    (seconds.is_finite() && seconds >= 0.0).then_some(seconds)
}

/// Worst-case size check for clips whose duration cannot be read: assume at least 48 kbps, so
/// `max_seconds` of audio never exceeds `max_seconds * 6000` bytes, plus 16 KB of container.
pub fn exceeds_size_estimate(len: usize, max_seconds: u32) -> bool {
    len as u64 > u64::from(max_seconds) * 48_000 / 8 + 16 * 1024
}

fn be32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}
fn be64(b: &[u8], at: usize) -> Option<u64> {
    Some(u64::from_be_bytes(b.get(at..at + 8)?.try_into().ok()?))
}
fn le32(b: &[u8], at: usize) -> Option<u32> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

/// Find a box of `kind` among sibling boxes in `b`; returns its payload.
fn find_box<'a>(b: &'a [u8], kind: &[u8; 4]) -> Option<&'a [u8]> {
    let mut at = 0usize;
    while at + 8 <= b.len() {
        let size = be32(b, at)? as usize;
        let (header, total) = match size {
            0 => (8, b.len() - at),
            1 => (16, usize::try_from(be64(b, at + 8)?).ok()?),
            n => (8, n),
        };
        if total < header {
            return None;
        }
        let end = at.checked_add(total)?.min(b.len());
        if &b[at + 4..at + 8] == kind {
            return b.get(at + header..end);
        }
        at = at.checked_add(total)?;
    }
    None
}

fn m4a(bytes: &[u8]) -> Option<f64> {
    let moov = find_box(bytes, b"moov")?;
    let mvhd = find_box(moov, b"mvhd")?;
    let (timescale, duration) = match *mvhd.first()? {
        0 => (be32(mvhd, 12)? as f64, be32(mvhd, 16)? as f64),
        1 => (be32(mvhd, 20)? as f64, be64(mvhd, 24)? as f64),
        _ => return None,
    };
    (timescale > 0.0).then(|| duration / timescale)
}

fn wav(bytes: &[u8]) -> Option<f64> {
    let mut at = 12usize;
    let mut byte_rate = None;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = le32(bytes, at + 4)? as usize;
        let body = at + 8;
        if id == b"fmt " {
            byte_rate = le32(bytes, body + 8);
        } else if id == b"data" {
            let available = bytes.len() - body;
            let len = if size > available { available } else { size };
            let rate = byte_rate.filter(|r| *r > 0)?;
            return Some(len as f64 / f64::from(rate));
        }
        at = body.checked_add(size)?.checked_add(size & 1)?;
    }
    None
}

fn ogg(bytes: &[u8]) -> Option<f64> {
    let find = |needle: &[u8]| bytes.windows(needle.len()).position(|w| w == needle);
    let rate = if find(b"OpusHead").is_some() {
        48_000.0
    } else {
        let at = find(b"\x01vorbis")?;
        f64::from(le32(bytes, at + 12)?)
    };
    let last = bytes.windows(4).rposition(|w| w == b"OggS")?;
    let granule = i64::from_le_bytes(bytes.get(last + 6..last + 14)?.try_into().ok()?);
    (granule > 0 && rate > 0.0).then(|| granule as f64 / rate)
}

/// Synthetic containers for tests (also used by the integration tests).
pub mod fixtures {
    fn boxed(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut v = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        v.extend_from_slice(kind);
        v.extend_from_slice(payload);
        v
    }
    /// An m4a shell with `ftyp`, `mdat` and a `moov/mvhd` stating `seconds`; `extra` bytes follow.
    pub fn m4a(seconds: f64, extra: &[u8]) -> Vec<u8> {
        let mut mvhd = vec![0u8; 100];
        mvhd[12..16].copy_from_slice(&1000u32.to_be_bytes());
        mvhd[16..20].copy_from_slice(&((seconds * 1000.0) as u32).to_be_bytes());
        let mut out = boxed(b"ftyp", b"M4A \0\0\0\0M4A mp42isom");
        out.extend(boxed(b"mdat", extra));
        out.extend(boxed(b"moov", &boxed(b"mvhd", &mvhd)));
        out
    }
    /// 16 kHz mono 16-bit PCM silence.
    pub fn wav(seconds: f64) -> Vec<u8> {
        let data_len = (seconds * 32_000.0) as u32;
        let mut v = b"RIFF".to_vec();
        v.extend((36 + data_len).to_le_bytes());
        v.extend(b"WAVEfmt ");
        v.extend(16u32.to_le_bytes());
        v.extend(1u16.to_le_bytes());
        v.extend(1u16.to_le_bytes());
        v.extend(16_000u32.to_le_bytes());
        v.extend(32_000u32.to_le_bytes());
        v.extend(2u16.to_le_bytes());
        v.extend(16u16.to_le_bytes());
        v.extend(b"data");
        v.extend(data_len.to_le_bytes());
        v.extend(std::iter::repeat_n(0u8, data_len as usize));
        v
    }
    /// Two Ogg pages: an Opus head and a last page whose granule position is `seconds` at 48 kHz.
    pub fn ogg(seconds: f64) -> Vec<u8> {
        let page = |granule: i64, body: &[u8]| {
            let mut p = b"OggS\0\x02".to_vec();
            p.extend(granule.to_le_bytes());
            p.extend([0u8; 12]);
            p.push(1);
            p.push(body.len() as u8);
            p.extend(body);
            p
        };
        let mut v = page(0, b"OpusHead\x01\x01\0\0\x80\xbb\0\0\0\0\0");
        v.extend(page((seconds * 48_000.0) as i64, b"data"));
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_containers_by_magic_bytes() {
        assert_eq!(detect(&fixtures::m4a(1.0, b"x")), Some(Format::M4a));
        assert_eq!(detect(&fixtures::wav(0.1)), Some(Format::Wav));
        assert_eq!(detect(&fixtures::ogg(1.0)), Some(Format::Ogg));
        assert_eq!(detect(b"\xff\xd8\xff\xe0 jpeg"), None);
        assert_eq!(detect(b"ID3\x04 mp3 file bytes"), None);
        assert_eq!(detect(b""), None);
    }

    #[test]
    fn reads_duration_from_metadata() {
        let m = duration_seconds(&fixtures::m4a(12.5, &[0; 40]), Format::M4a).unwrap();
        assert!((m - 12.5).abs() < 0.01);
        let w = duration_seconds(&fixtures::wav(2.0), Format::Wav).unwrap();
        assert!((w - 2.0).abs() < 0.01);
        let o = duration_seconds(&fixtures::ogg(7.0), Format::Ogg).unwrap();
        assert!((o - 7.0).abs() < 0.01);
    }

    #[test]
    fn size_estimate_bounds_clips_of_unknown_duration() {
        // 30 s at 48 kbps is 180,000 bytes; 16 KB of slack on top.
        assert!(!exceeds_size_estimate(196_384, 30));
        assert!(exceeds_size_estimate(196_385, 30));
        assert!(!exceeds_size_estimate(0, 30));
    }

    #[test]
    fn unreadable_metadata_gives_none() {
        let mut broken = b"\0\0\0\x14ftypM4A \0\0\0\0M4A ".to_vec();
        broken.extend([0u8; 8]);
        assert_eq!(duration_seconds(&broken, Format::M4a), None);
        assert_eq!(duration_seconds(b"RIFF\0\0\0\0WAVE", Format::Wav), None);
    }
}
