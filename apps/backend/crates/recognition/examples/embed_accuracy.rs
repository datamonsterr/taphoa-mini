//! Evaluate held-out labeled crops with the production DINO embedder and cosine search.
//! See scripts/recognition-evidence.md for the manifest and reproducible invocation.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    path::Path,
};
use taphoa_recognition::{DinoEmbedder, Embedder, crop};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Sample {
    product_id: String,
    image: String,
    /// Optional detection bbox [x, y, width, height]; production uses 8% padding.
    bbox: Option<[f32; 4]>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    references: Vec<Sample>,
    queries: Vec<Sample>,
}

fn load(sample: &Sample, root: &Path) -> Result<image::RgbImage> {
    if sample.product_id.trim().is_empty() {
        return Err("product_id must not be empty".into());
    }
    let image = crop::decode_limited(&std::fs::read(root.join(&sample.image))?)?.to_rgb8();
    match sample.bbox {
        Some(bbox) => crop::crop_with_padding(&image, bbox, 0.08)
            .ok_or_else(|| "invalid or empty bbox".into()),
        None => Ok(image),
    }
}

fn fingerprint(image: &image::RgbImage) -> Vec<u8> {
    let mut hash = Sha256::new();
    hash.update(image.width().to_le_bytes());
    hash.update(image.height().to_le_bytes());
    hash.update(image.as_raw());
    hash.finalize().to_vec()
}

fn similarity(a: &[f32], b: &[f32]) -> f32 {
    a.iter().zip(b).map(|(a, b)| a * b).sum()
}

// Max over references and the normalized mean prototype, as in production pgvector search.
fn scores(query: &[f32], references: &BTreeMap<String, Vec<Vec<f32>>>) -> Vec<(String, f32)> {
    let mut scores: Vec<_> = references
        .iter()
        .map(|(id, vectors)| {
            let mut sum = vec![0.0_f64; query.len()];
            for vector in vectors {
                for (mean, value) in sum.iter_mut().zip(vector) {
                    *mean += f64::from(*value);
                }
            }
            let mut prototype: Vec<f32> = sum
                .iter()
                .map(|v| (v / vectors.len() as f64) as f32)
                .collect();
            crop::l2_normalize(&mut prototype);
            let best = vectors
                .iter()
                .map(|v| similarity(query, v))
                .fold(similarity(query, &prototype), f32::max);
            (id.clone(), best)
        })
        .collect();
    scores.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    scores
}

fn correct(scores: &[(String, f32)], expected: &str) -> bool {
    // A tied top score does not establish a correct unique top-1 prediction.
    scores.first().is_some_and(|best| {
        best.0 == expected && scores.get(1).is_none_or(|runner| best.1 - runner.1 > 1e-6)
    })
}

fn sha256_file(path: &Path) -> Result<String> {
    Ok(Sha256::digest(std::fs::read(path)?)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn run() -> Result<bool> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("usage: embed_accuracy <dinov2_small.onnx> <manifest.json>".into());
    }
    let manifest_path = Path::new(&args[2]);
    let manifest: Manifest =
        serde_json::from_slice(&std::fs::read(manifest_path).map_err(|e| {
            format!(
                "missing labeled accuracy manifest {}: {e}",
                manifest_path.display()
            )
        })?)?;
    if manifest.references.is_empty() || manifest.queries.is_empty() {
        return Err("manifest requires nonempty references and held-out queries".into());
    }
    let root = manifest_path.parent().unwrap_or(Path::new("."));
    let mut fingerprints = BTreeMap::new();
    let mut reference_images = Vec::new();
    for reference in &manifest.references {
        let image = load(reference, root)?;
        let fingerprint = fingerprint(&image);
        if fingerprints
            .insert(fingerprint, reference.product_id.clone())
            .is_some()
        {
            return Err("duplicate reference pixels; provide independent reference photos".into());
        }
        reference_images.push(image);
    }
    let mut query_images = Vec::new();
    for query in &manifest.queries {
        if !manifest
            .references
            .iter()
            .any(|r| r.product_id == query.product_id)
        {
            return Err(format!("query product {} has no reference", query.product_id).into());
        }
        let image = load(query, root)?;
        if fingerprints
            .insert(fingerprint(&image), query.product_id.clone())
            .is_some()
        {
            return Err(
                "query pixels duplicate a reference or query; held-out photos required".into(),
            );
        }
        query_images.push(image);
    }
    let embedder = DinoEmbedder::load_with_side(Path::new(&args[1]), 4, 112)?;
    let mut references: BTreeMap<String, Vec<Vec<f32>>> = BTreeMap::new();
    for (reference, vector) in manifest
        .references
        .iter()
        .zip(embedder.embed_crops(&reference_images)?)
    {
        references
            .entry(reference.product_id.clone())
            .or_default()
            .push(vector);
    }
    let mut hits = 0;
    let mut predictions = Vec::new();
    for (query, vector) in manifest
        .queries
        .iter()
        .zip(embedder.embed_crops(&query_images)?)
    {
        let ranked = scores(&vector, &references);
        let hit = correct(&ranked, &query.product_id);
        hits += usize::from(hit);
        predictions.push(serde_json::json!({
            "image": query.image, "expected": query.product_id,
            "predicted": ranked[0].0, "similarity": ranked[0].1, "correct": hit,
        }));
    }
    let accuracy = hits as f64 / manifest.queries.len() as f64;
    let queried_products: BTreeSet<_> = manifest.queries.iter().map(|q| &q.product_id).collect();
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "model": embedder.model(), "side_px": 112,
            "model_sha256": sha256_file(Path::new(&args[1]))?,
            "manifest_sha256": sha256_file(manifest_path)?,
            "products": references.len(), "references": manifest.references.len(),
            "queries": manifest.queries.len(), "queried_products": queried_products.len(), "correct": hits,
            "top1_accuracy_pct": accuracy * 100.0, "target_pct": 90,
            "meets_a1_sample_counts": references.len() >= 50 && queried_products.len() >= 50 && manifest.queries.len() >= 200,
            "predictions": predictions,
        }))?
    );
    Ok(accuracy >= 0.9)
}

fn main() {
    match run() {
        Ok(true) => (),
        Ok(false) => std::process::exit(1),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranks_by_best_reference_and_rejects_top_score_ties() {
        let references = BTreeMap::from([
            ("a".into(), vec![vec![1.0, 0.0], vec![0.0, 1.0]]),
            ("b".into(), vec![vec![-1.0, 0.0]]),
        ]);
        assert!(correct(&scores(&[1.0, 0.0], &references), "a"));
        assert!(!correct(&scores(&[-1.0, 0.0], &references), "a"));
        let tie = vec![("a".into(), 1.0), ("b".into(), 1.0)];
        assert!(!correct(&tie, "a"));
        let ranked = scores(&[0.70710677, 0.70710677], &references);
        assert!(ranked[0].1 > 0.99, "mean prototype participates in search");
    }
}
