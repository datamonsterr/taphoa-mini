#[path = "recognition_eval/transforms.rs"]
mod transforms;

use image::{RgbImage, imageops::FilterType};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    error::Error,
    path::{Path, PathBuf},
    time::Instant,
};
use taphoa_api::{
    recognition::classify::{MatchClass, RecognitionConfig, classify},
    vector::{VectorHit, voting_scores},
};
use taphoa_recognition::{DinoEmbedder, Embedder, crop};
use uuid::Uuid;

type Result<T> = std::result::Result<T, Box<dyn Error>>;
const SEED: u64 = 42;
const BUCKETS: [&str; 9] = [
    "near",
    "angle45",
    "angle90",
    "angle180",
    "mid",
    "far",
    "occlusion30",
    "occlusion50",
    "hard",
];

#[derive(Clone)]
struct Sample {
    path: PathBuf,
    class: u32,
}
#[derive(Serialize, Deserialize)]
struct Gallery {
    entries: BTreeMap<u32, Vec<Vec<f32>>>,
    #[serde(skip)]
    prototypes: BTreeMap<u32, Vec<f32>>,
    #[serde(skip)]
    norms: BTreeMap<u32, Vec<f64>>,
    #[serde(skip)]
    prototype_norms: BTreeMap<u32, f64>,
}
impl Gallery {
    fn new(entries: BTreeMap<u32, Vec<Vec<f32>>>) -> Self {
        let prototypes: BTreeMap<u32, Vec<f32>> = entries
            .iter()
            .map(|(id, vectors)| {
                let mut sums = vec![0.0_f64; vectors[0].len()];
                for vector in vectors {
                    for (sum, value) in sums.iter_mut().zip(vector) {
                        *sum += f64::from(*value);
                    }
                }
                let mut mean: Vec<f32> = sums
                    .iter()
                    .map(|x| (x / vectors.len() as f64) as f32)
                    .collect();
                crop::l2_normalize(&mut mean);
                (*id, mean)
            })
            .collect();
        let norms = entries
            .iter()
            .map(|(id, vectors)| (*id, vectors.iter().map(|v| norm(v)).collect()))
            .collect();
        let prototype_norms = prototypes.iter().map(|(id, v)| (*id, norm(v))).collect();
        Self {
            entries,
            prototypes,
            norms,
            prototype_norms,
        }
    }
}
#[derive(Serialize)]
struct Row {
    truth: u32,
    bucket: String,
    unknown: bool,
    scores: Vec<(u32, f32)>,
    embed_ms: f64,
}

fn samples(root: &Path, split: &str) -> Result<Vec<Sample>> {
    let text = std::fs::read_to_string(root.join(format!("{split}.txt")))?;
    text.lines()
        .map(|line| {
            let mut parts = line.split(',').map(str::trim);
            let path = parts.next().ok_or("missing path")?;
            let class = parts.next().ok_or("missing class")?.parse()?;
            Ok(Sample {
                path: root.join(path),
                class,
            })
        })
        .collect()
}
fn read(sample: &Sample) -> Result<RgbImage> {
    Ok(crop::decode_limited(&std::fs::read(&sample.path)?)?.to_rgb8())
}
fn hash64(data: &[u8]) -> u64 {
    let digest = Sha256::digest(data);
    u64::from_le_bytes(digest[..8].try_into().unwrap())
}
fn chosen(samples: &[Sample], class: u32, n: usize) -> Vec<&Sample> {
    let mut items: Vec<_> = samples.iter().filter(|x| x.class == class).collect();
    items.sort_by_key(|x| {
        hash64(format!("{SEED}:{}", x.path.file_name().unwrap().to_string_lossy()).as_bytes())
    });
    items.truncate(n);
    items
}
fn embed(embedder: &DinoEmbedder, image: &RgbImage, legacy: bool) -> Result<Vec<f32>> {
    let input = if legacy {
        image::imageops::resize(image, 112, 112, FilterType::CatmullRom)
    } else {
        image.clone()
    };
    Ok(embedder.embed_crops(&[input])?.remove(0))
}
fn gallery(
    cache: &Path,
    model_hash: &str,
    embedder: &DinoEmbedder,
    train: &[Sample],
    enrolled: &BTreeSet<u32>,
    (legacy, k): (bool, usize),
    source: Option<&Gallery>,
) -> Result<Gallery> {
    let source_hash = hex::encode(Sha256::digest(
        [
            include_bytes!("../../recognition/src/crop.rs").as_slice(),
            include_bytes!("../../recognition/src/embed.rs").as_slice(),
            include_bytes!("recognition_eval.rs").as_slice(),
            include_bytes!("recognition_eval/transforms.rs").as_slice(),
        ]
        .concat(),
    ));
    let name = format!(
        "gallery-{}-{}-k{k}-seed{SEED}-{model_hash}-{source_hash}.json",
        if legacy { "legacy112" } else { "v2-224" },
        env!("CARGO_PKG_VERSION")
    );
    let path = cache.join(name);
    let mut entries = if path.exists() {
        serde_json::from_slice::<Gallery>(&std::fs::read(&path)?)?.entries
    } else {
        BTreeMap::new()
    };
    if let Some(source) = source {
        for (id, vectors) in &source.entries {
            entries.insert(*id, vectors[..k * 7].to_vec());
        }
    }
    for class in enrolled {
        if entries.contains_key(class) {
            continue;
        }
        let selected = chosen(train, *class, k);
        if selected.len() != k {
            return Err(format!("class {class} has fewer than {k} train images").into());
        }
        let mut vectors = Vec::new();
        for sample in selected {
            let image = read(sample)?;
            let views = crop::index_augmentations(&image, !legacy);
            let imgs: Vec<_> = views
                .into_iter()
                .map(|(_, v)| {
                    if legacy {
                        image::imageops::resize(&v, 112, 112, FilterType::CatmullRom)
                    } else {
                        v
                    }
                })
                .collect();
            vectors.extend(embedder.embed_crops(&imgs)?);
        }
        entries.insert(*class, vectors);
        let temp = path.with_extension("tmp");
        std::fs::write(
            &temp,
            serde_json::to_vec(&serde_json::json!({"entries": entries}))?,
        )?;
        std::fs::rename(temp, &path)?;
        eprintln!(
            "gallery {} K={k}: class {class}/{}",
            if legacy { "legacy" } else { "v2" },
            enrolled.len()
        );
    }
    let gallery = Gallery::new(entries);
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, serde_json::to_vec(&gallery)?)?;
    std::fs::rename(temp, path)?;
    Ok(gallery)
}
fn norm(v: &[f32]) -> f64 {
    v.iter().map(|x| f64::from(*x).powi(2)).sum::<f64>().sqrt()
}
fn similarity(a: &[f32], b: &[f32], a_norm: f64, b_norm: f64) -> f32 {
    let dot: f64 = a
        .iter()
        .zip(b)
        .map(|(a, b)| f64::from(*a) * f64::from(*b))
        .sum();
    (dot / (a_norm * b_norm)).clamp(-1.0, 1.0) as f32
}
fn scores(query: &[f32], gallery: &Gallery, legacy: bool) -> Vec<(u32, f32)> {
    let mut refs = Vec::new();
    let mut prototypes = Vec::new();
    let query_norm = norm(query);
    for (id, vectors) in &gallery.entries {
        let uid = Uuid::from_u128(u128::from(*id) + 1);
        for (v, v_norm) in vectors.iter().zip(&gallery.norms[id]) {
            refs.push(VectorHit {
                product_id: uid,
                similarity: similarity(query, v, query_norm, *v_norm),
            });
        }
        prototypes.push(VectorHit {
            product_id: uid,
            similarity: similarity(
                query,
                &gallery.prototypes[id],
                query_norm,
                gallery.prototype_norms[id],
            ),
        });
    }
    if legacy {
        let mut values: BTreeMap<u32, f32> = BTreeMap::new();
        for hit in refs.into_iter().chain(prototypes) {
            let id = (hit.product_id.as_u128() - 1) as u32;
            values
                .entry(id)
                .and_modify(|score| *score = score.max(hit.similarity))
                .or_insert(hit.similarity);
        }
        let mut v: Vec<_> = values.into_iter().collect();
        v.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
        v.truncate(5);
        v
    } else {
        voting_scores(refs, prototypes, 5)
            .into_iter()
            .map(|h| ((h.product_id.as_u128() - 1) as u32, h.similarity))
            .collect()
    }
}
fn transform(sample: &Sample, bucket: &str, background: &Sample) -> Result<RgbImage> {
    let mut image = read(sample)?;
    let seed = hash64(
        format!(
            "{SEED}:{}:{bucket}",
            sample.path.file_name().unwrap().to_string_lossy()
        )
        .as_bytes(),
    );
    image = match bucket {
        "angle45" | "hard" => transforms::rotate(&image, 45),
        "angle90" => transforms::rotate(&image, 90),
        "angle180" => transforms::rotate(&image, 180),
        _ => image,
    };
    image = match bucket {
        "occlusion30" | "hard" => transforms::erase(&image, 0.3, seed),
        "occlusion50" => transforms::erase(&image, 0.5, seed),
        _ => image,
    };
    if matches!(bucket, "mid" | "far" | "hard") {
        let (scene, bbox) = transforms::paste(
            &image,
            &read(background)?,
            if bucket == "far" { 0.12 } else { 0.30 },
            seed,
            seed ^ 12345,
        );
        image = crop::crop_with_padding(&scene, bbox, 0.08).ok_or("invalid pasted box")?;
    }
    Ok(image)
}
fn interval(success: usize, n: usize) -> String {
    if n == 0 {
        return "n/a".to_string();
    }
    let n = n as f64;
    let p = success as f64 / n;
    let z = 1.959963984540054_f64;
    let d = 1.0 + z * z / n;
    let c = (p + z * z / (2.0 * n)) / d;
    let h = z * (p * (1.0 - p) / n + z * z / (4.0 * n * n)).sqrt() / d;
    format!(
        "{:.1}% [{:.1}, {:.1}]",
        100.0 * p,
        100.0 * (c - h),
        100.0 * (c + h)
    )
}
type Sweep = (f32, f32, usize, usize);
fn report(rows: &[Row], config: &RecognitionConfig) -> (String, Option<Sweep>, serde_json::Value) {
    let mut md = String::from(
        "| Bucket | Known n | Top-1 (95% CI) | Top-5 (95% CI) | Matched precision (95% CI) | Ambiguous (95% CI) | Unknown n | Unknown precision (95% CI) | Unknown recall (95% CI) | Embed ms/crop |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n",
    );
    let mut metrics = serde_json::Map::new();
    for bucket in BUCKETS.into_iter().chain(std::iter::once("all")) {
        let set: Vec<_> = rows
            .iter()
            .filter(|r| bucket == "all" || r.bucket == bucket)
            .collect();
        let known = set.iter().filter(|r| !r.unknown).count();
        let unknown = set.len() - known;
        let mut top1 = 0;
        let mut top5 = 0;
        let mut matches = 0;
        let mut match_ok = 0;
        let mut amb = 0;
        let mut rejected = 0;
        let mut unknown_rej = 0;
        for r in &set {
            if !r.unknown {
                top1 += usize::from(r.scores.first().is_some_and(|x| x.0 == r.truth));
                top5 += usize::from(r.scores.iter().any(|x| x.0 == r.truth));
            }
            let c = classify(
                r.scores.first().map(|x| x.1),
                r.scores.get(1).map(|x| x.1),
                config.match_threshold,
                config.match_margin,
                config.match_floor,
            );
            if c == MatchClass::Matched {
                matches += 1;
                match_ok +=
                    usize::from(!r.unknown && r.scores.first().is_some_and(|x| x.0 == r.truth));
            }
            if c == MatchClass::Ambiguous {
                amb += 1;
            }
            if c == MatchClass::Unknown {
                rejected += 1;
                unknown_rej += usize::from(r.unknown);
            }
        }
        let ms = set.iter().map(|r| r.embed_ms).sum::<f64>() / set.len().max(1) as f64;
        metrics.insert(bucket.to_string(), serde_json::json!({
            "known_n": known, "unknown_n": unknown,
            "top1": {"correct": top1, "n": known, "wilson95": interval(top1, known)},
            "top5": {"correct": top5, "n": known, "wilson95": interval(top5, known)},
            "matched_precision": {"correct": match_ok, "n": matches, "wilson95": interval(match_ok, matches)},
            "ambiguous": {"count": amb, "n": set.len(), "wilson95": interval(amb, set.len())},
            "unknown_precision": {"correct": unknown_rej, "n": rejected, "wilson95": interval(unknown_rej, rejected)},
            "unknown_recall": {"correct": unknown_rej, "n": unknown, "wilson95": interval(unknown_rej, unknown)},
            "embed_ms_per_crop": ms
        }));
        md.push_str(&format!("| {bucket} | {known} | {} | {} | {} ({match_ok}/{matches}) | {} | {unknown} | {} ({unknown_rej}/{rejected}) | {} | {ms:.1} |\n",interval(top1,known),interval(top5,known),interval(match_ok,matches),interval(amb,set.len()),interval(unknown_rej,rejected),interval(unknown_rej,unknown)));
    }
    // Every distinct score and margin is a decision boundary. Scan these exact
    // boundaries so the recommended pair maximizes coverage without grid error.
    let mut points: Vec<(f32, f32, bool)> = rows
        .iter()
        .filter_map(|r| {
            let top = r.scores.first()?.1;
            if top < config.match_floor {
                return None;
            }
            let gap = r
                .scores
                .get(1)
                .map_or(1.0, |runner| top - runner.1)
                .clamp(0.0, 1.0);
            Some((top.min(1.0), gap, !r.unknown && r.scores[0].0 == r.truth))
        })
        .collect();
    points.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut margins: Vec<f32> = points
        .iter()
        .map(|p| p.1)
        .chain(std::iter::once(0.0))
        .collect();
    margins.sort_by(f32::total_cmp);
    margins.dedup_by(|a, b| *a == *b);
    let mut counts = vec![(0_usize, 0_usize); margins.len()];
    let mut best: Option<Sweep> = None;
    let mut i = 0;
    while i < points.len() {
        let threshold = points[i].0;
        while i < points.len() && points[i].0 == threshold {
            let index = margins
                .binary_search_by(|m| m.total_cmp(&points[i].1))
                .unwrap();
            counts[index].0 += 1;
            counts[index].1 += usize::from(points[i].2);
            i += 1;
        }
        let (mut matched, mut correct) = (0, 0);
        for index in (0..margins.len()).rev() {
            matched += counts[index].0;
            correct += counts[index].1;
            if matched > 0 && correct * 100 >= 98 * matched && best.is_none_or(|b| matched > b.2) {
                best = Some((threshold, margins[index], matched, correct));
            }
        }
    }
    (md, best, serde_json::Value::Object(metrics))
}
fn main() -> Result<()> {
    let started = Instant::now();
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 5 {
        return Err("usage: recognition_eval DATASET MODEL CACHE MAX_TEST_PER_CLASS".into());
    }
    let root = Path::new(&args[1]);
    let model = Path::new(&args[2]);
    let cache = Path::new(&args[3]);
    let limit: usize = args[4].parse()?;
    if limit == 0 {
        return Err("sample cap must be positive".into());
    }
    std::fs::create_dir_all(cache)?;
    let model_hash = hex::encode(Sha256::digest(std::fs::read(model)?));
    let train = samples(root, "train")?;
    let test = samples(root, "test")?;
    let classes: BTreeSet<_> = train.iter().map(|s| s.class).collect();
    let held = transforms::split_classes(&classes.iter().copied().collect::<Vec<_>>(), SEED);
    let enrolled: BTreeSet<_> = classes.difference(&held).copied().collect();
    let selected: Vec<_> = classes
        .iter()
        .flat_map(|c| chosen(&test, *c, limit))
        .collect();
    let config = RecognitionConfig::from_env()?;
    let v2 = DinoEmbedder::load_with_side(model, 4, 224)?;
    let legacy = DinoEmbedder::load_with_side(model, 4, 112)?;
    let configs = [
        ("legacy-k3", true, 3),
        ("v2-k3", false, 3),
        ("v2-k8", false, 8),
        ("v2-k16", false, 16),
    ];
    let legacy_gallery = gallery(
        cache,
        &model_hash,
        &legacy,
        &train,
        &enrolled,
        (true, 3),
        None,
    )?;
    let v16 = gallery(
        cache,
        &model_hash,
        &v2,
        &train,
        &enrolled,
        (false, 16),
        None,
    )?;
    let v3 = gallery(
        cache,
        &model_hash,
        &v2,
        &train,
        &enrolled,
        (false, 3),
        Some(&v16),
    )?;
    let v8 = gallery(
        cache,
        &model_hash,
        &v2,
        &train,
        &enrolled,
        (false, 8),
        Some(&v16),
    )?;
    let galleries = [legacy_gallery, v3, v8, v16];
    let mut all: Vec<Vec<Row>> = (0..configs.len()).map(|_| Vec::new()).collect();
    for (idx, sample) in selected.iter().enumerate() {
        let bg = test
            .iter()
            .filter(|s| s.class != sample.class)
            .min_by_key(|s| {
                hash64(
                    format!(
                        "{SEED}:{}:{}",
                        sample.path.file_name().unwrap().to_string_lossy(),
                        s.path.file_name().unwrap().to_string_lossy()
                    )
                    .as_bytes(),
                )
            })
            .ok_or("no different background")?;
        for bucket in BUCKETS {
            let image = transform(sample, bucket, bg)?;
            for is_legacy in [true, false] {
                let now = Instant::now();
                let vector = embed(if is_legacy { &legacy } else { &v2 }, &image, is_legacy)?;
                let elapsed = now.elapsed().as_secs_f64() * 1000.0;
                for (i, (_, l, _)) in configs.iter().enumerate() {
                    if *l == is_legacy {
                        all[i].push(Row {
                            truth: sample.class,
                            bucket: bucket.into(),
                            unknown: held.contains(&sample.class),
                            scores: scores(&vector, &galleries[i], is_legacy),
                            embed_ms: elapsed,
                        });
                    }
                }
            }
        }
        eprintln!("query {}/{}", idx + 1, selected.len());
    }
    let elapsed_seconds = started.elapsed().as_secs_f64();
    let mut markdown = format!(
        "# GroceryStoreDataset recognition evaluation\n\nDataset commit `fc80ba90f803d79d0383df52c5a4ac5de99ff6fc`, archive SHA-256 `1e985fb2f13163de9b2b61fa5fc911f9a9d1bc082249135506a7274c7ccd59d5`. Model SHA-256 `{model_hash}`. Seed {SEED}, {limit} test images maximum per class, 4 ONNX threads, {elapsed_seconds:.1} s through embedding and scoring. Held-out class IDs: {held:?}. Defaults: threshold {}, margin {}, floor {}. Wilson 95% intervals are per observation (correlated bucket transforms share source images). Search requests top_k=5. Neighbor retrieval is an exact in-memory cosine scan; production uses approximate HNSW, which may differ. Threshold and margin sweep uses exact observed decision boundaries and is in-sample; validate recommendations on independent store images.\n\n",
        config.match_threshold, config.match_margin, config.match_floor
    );
    let mut outputs = serde_json::Map::new();
    for (i, (name, _, _)) in configs.iter().enumerate() {
        let (table, best, metrics) = report(&all[i], &config);
        outputs.insert((*name).to_string(), serde_json::json!({"metrics": metrics, "sweep": best.map(|(threshold,margin,matched,correct)| serde_json::json!({"threshold":threshold,"margin":margin,"matched":matched,"correct":correct,"total":all[i].len()})), "observations": all[i]}));
        markdown.push_str(&format!("## {name}\n\n{table}\n"));
        match best {Some((t,m,n,ok))=>markdown.push_str(&format!("Sweep recommendation: threshold {t:.8}, margin {m:.8}; matched precision {ok}/{n}, coverage {n}/{}.\n\n", all[i].len())),None=>markdown.push_str("No non-empty sweep point reaches 98% matched precision.\n\n")};
    }
    println!("{markdown}");
    std::fs::write(
        cache.join("result.json"),
        serde_json::to_vec_pretty(
            &serde_json::json!({"dataset_commit":"fc80ba90f803d79d0383df52c5a4ac5de99ff6fc", "model_sha256":model_hash,"elapsed_seconds":elapsed_seconds,"seed":SEED,"max_test_per_class":limit,"held_out_classes":held,"match_threshold":config.match_threshold,"match_margin":config.match_margin,"match_floor":config.match_floor,"configurations":outputs}),
        )?,
    )?;
    Ok(())
}
