//! Usage: ORT_DYLIB_PATH=... cargo run --release -p taphoa-recognition --example embed_bench -- \
//!   <dino.onnx> [crops=16] [runs=3]
use std::time::Instant;
use taphoa_recognition::{DinoEmbedder, Embedder};

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let crops: usize = a.get(2).and_then(|v| v.parse().ok()).unwrap_or(16);
    let runs: usize = a.get(3).and_then(|v| v.parse().ok()).unwrap_or(3);
    let t = Instant::now();
    let e = DinoEmbedder::load_with_side(
        a[1].as_ref(),
        0,
        a.get(4).and_then(|v| v.parse().ok()).unwrap_or(224),
    )
    .unwrap();
    println!("load {:?}", t.elapsed());
    let images: Vec<_> = (0..crops)
        .map(|i| {
            image::RgbImage::from_fn(150, 260, |x, y| {
                image::Rgb([(x + i as u32) as u8, y as u8, (i * 9) as u8])
            })
        })
        .collect();
    for _ in 0..runs {
        let t = Instant::now();
        let v = e.embed_crops(&images).unwrap();
        println!("{} crops: {:?} ({} dims)", v.len(), t.elapsed(), v[0].len());
    }
}
