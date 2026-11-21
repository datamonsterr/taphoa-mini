//! Wire v1: bincode 1, fixed-width little-endian numbers, bounded decode and no
//! trailing bytes. Bytes use one byte each and f32 embeddings four bytes each.
//! Route versioning freezes these structs; incompatible changes require /v2/.
use crate::{PointPrompt, Segment};
use bincode::Options;
use serde::{Deserialize, Serialize, de::DeserializeOwned};

pub const CONTENT_TYPE: &str = "application/vnd.taphoa.inference.v1";
pub const BODY_LIMIT: usize = 10 * 1024 * 1024;
pub fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>, String> {
    options().serialize(value).map_err(|e| e.to_string())
}
pub fn decode<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    options().deserialize(bytes).map_err(|e| e.to_string())
}
fn options() -> impl Options {
    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .with_little_endian()
        .with_limit(BODY_LIMIT as u64)
        .reject_trailing_bytes()
}
#[derive(Serialize, Deserialize)]
pub struct ImageRequest {
    pub image: Vec<u8>,
}
#[derive(Serialize, Deserialize)]
pub struct CropsRequest {
    pub crops: Vec<RgbCrop>,
}
#[derive(Serialize, Deserialize)]
pub struct RgbCrop {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<u8>,
}
#[derive(Serialize, Deserialize)]
pub struct EncodingResponse {
    pub handle: String,
    pub width: u32,
    pub height: u32,
}
#[derive(Serialize, Deserialize)]
pub struct PointsRequest {
    pub handle: String,
    pub points: Vec<PointPrompt>,
}
#[derive(Serialize, Deserialize)]
pub struct PointResponse {
    pub segment: Segment,
    pub width: u32,
    pub height: u32,
    /// Bit-packed, row-major binary mask, low bit first, ceil(width*height/8).
    pub mask: Vec<u8>,
}
impl PointResponse {
    pub fn from_segment(value: crate::PointSegment) -> Self {
        let mut mask =
            vec![0; (value.mask.width() as usize * value.mask.height() as usize).div_ceil(8)];
        for (i, p) in value.mask.as_raw().iter().enumerate() {
            if *p != 0 {
                mask[i / 8] |= 1 << (i % 8);
            }
        }
        Self {
            segment: value.segment,
            width: value.mask.width(),
            height: value.mask.height(),
            mask,
        }
    }
    pub fn into_segment(self) -> Result<crate::PointSegment, String> {
        if self.width == 0 || self.height == 0 || self.width > 1024 || self.height > 1024 {
            return Err("invalid mask dimensions".into());
        }
        let n = self.width as usize * self.height as usize;
        if self.mask.len() != n.div_ceil(8) {
            return Err("invalid mask length".into());
        }
        let pixels = (0..n)
            .map(|i| {
                if self.mask[i / 8] & (1 << (i % 8)) != 0 {
                    255
                } else {
                    0
                }
            })
            .collect();
        Ok(crate::PointSegment {
            segment: self.segment,
            mask: image::GrayImage::from_raw(self.width, self.height, pixels)
                .ok_or("invalid mask")?,
        })
    }
}
#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorResponse {
    pub code: String,
    pub message: String,
}
#[derive(Debug, Serialize, Deserialize)]
pub struct Health {
    pub status: String,
    pub provider: String,
    pub loaded: Vec<String>,
    pub version: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary_lengths_and_mask_round_trip_are_bounded() {
        assert_eq!(encode(&vec![1.0f32; 384]).unwrap().len(), 8 + 384 * 4);
        assert!(decode::<ImageRequest>(&[255; 8]).is_err());
        let segment = crate::PointSegment {
            segment: Segment {
                bbox: [0., 0., 2., 2.],
                score: 1.,
                area: 3,
            },
            mask: image::GrayImage::from_raw(2, 2, vec![255, 0, 255, 255]).unwrap(),
        };
        let wire = PointResponse::from_segment(segment);
        assert_eq!(wire.mask, [13]);
        assert_eq!(
            wire.into_segment().unwrap().mask.as_raw(),
            &[255, 0, 255, 255]
        );
        let mut bytes = encode(&ImageRequest { image: vec![1, 2] }).unwrap();
        bytes.push(0);
        assert!(decode::<ImageRequest>(&bytes).is_err());
    }
}

/// A worker client error, or a retryable lack of both worker and local weights.
/// API callers retain its HTTP status instead of turning bad input into a 500.
#[derive(Debug, Clone, thiserror::Error)]
#[error("inference HTTP {status}: {message}")]
pub struct RemoteError {
    pub status: u16,
    pub message: String,
}

/// Preserve Embedder::model()/dim() across processes: differing EMBED_SIDE
/// settings must never mix incompatible reference/query embeddings.
#[derive(Serialize, Deserialize)]
pub struct EmbeddingResponse {
    pub model: String,
    pub dim: usize,
    pub vectors: Vec<Vec<f32>>,
}
