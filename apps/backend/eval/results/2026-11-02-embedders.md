# Embedder challengers (2026-11-02)

GroceryStoreDataset commit `fc80ba90f803d79d0383df52c5a4ac5de99ff6fc`; seed 42, four test images per class, nine buckets, K=8, four ONNX threads. The original baseline observations are reused; see [recognition evaluation](2026-11-02-recognition.md) for splits and methodology. Package membership uses `classes.csv`: coarse classes associated with the `Packages` iconic-image path (Juice, Milk, Oat-Milk, Oatghurt, Sour-Cream, Sour-Milk, Soy-Milk, Soyghurt, Yoghurt). Produce combines Fruit and Vegetables. Metrics below include enrolled queries only. The exact cosine evaluation is not production HNSW and synthetic crops are not representative shop photos.

| Group | Bucket | n | Top-1 | Top-5 |
|---|---|---:|---:|---:|
| all | all | 2340 | 1204/2340 (51.5%) | 1872/2340 (80.0%) |
| all | angle90 | 260 | 144/260 (55.4%) | 219/260 (84.2%) |
| all | far | 260 | 148/260 (56.9%) | 217/260 (83.5%) |
| all | occlusion50 | 260 | 109/260 (41.9%) | 186/260 (71.5%) |
| all | hard | 260 | 91/260 (35.0%) | 146/260 (56.2%) |
| packaged | all | 1008 | 188/1008 (18.7%) | 605/1008 (60.0%) |
| packaged | angle90 | 112 | 21/112 (18.8%) | 72/112 (64.3%) |
| packaged | far | 112 | 28/112 (25.0%) | 74/112 (66.1%) |
| packaged | occlusion50 | 112 | 8/112 (7.1%) | 52/112 (46.4%) |
| packaged | hard | 112 | 14/112 (12.5%) | 25/112 (22.3%) |
| produce | all | 1332 | 1016/1332 (76.3%) | 1267/1332 (95.1%) |
| produce | angle90 | 148 | 123/148 (83.1%) | 147/148 (99.3%) |
| produce | far | 148 | 120/148 (81.1%) | 143/148 (96.6%) |
| produce | occlusion50 | 148 | 101/148 (68.2%) | 134/148 (90.5%) |
| produce | hard | 148 | 77/148 (52.0%) | 121/148 (81.8%) |

Baseline: DINOv2 ViT-S/14 CLS, 384 dimensions, 88,532,934 bytes, SHA-256 `f22797eabf810a75e41de68d378541ebea372122b25c4ce3ef25ff618250c20a`, [Apache-2.0](https://huggingface.co/facebook/dinov2-small), 164.2 ms/crop (four-thread shared-host baseline; not a scan end-to-end latency).

Among known ambiguous queries, 832/1713 (48.6%) have the correct top-ranked class. Of cases with score at least 0.8 that fail only the 0.05 margin, 254/582 (43.6%) are correct. Ambiguous also includes scores below the match threshold; these counts do not establish a safe new threshold.
## Challenger setup

The model cards for [DINOv2 small](https://huggingface.co/facebook/dinov2-small), [DINOv2 base](https://huggingface.co/facebook/dinov2-base) and [SigLIP2 base](https://huggingface.co/google/siglip2-base-patch16-224) list Apache-2.0, which permits commercial use subject to its terms. Exports use Python 3.11.15, `torch==2.6.0+cpu`, `transformers==4.51.3`, `onnx==1.17.0`, `huggingface-hub==0.30.2`, and `numpy==1.26.4`; the export script pins the model revisions. ONNX uses opset 17 and a dynamic batch. DINO gets ImageNet mean/std; SigLIP gets 0.5/0.5. Letterbox padding uses the rounded model mean. CLS+GeM concatenates CLS with patch-wise GeM at p=3, clamping negative token values to zero, then L2-normalizes the 768-vector. Pooled output is L2-normalized. Models use 224 pixels and four ONNX threads. The generic runner output and gallery keys include model hash and preprocessing/pooling choices.

Run `python3 apps/backend/scripts/export-embedder.py MODEL_ID OUTPUT.onnx` inside the pinned environment, then invoke the release `recognition_eval` example with `--dataset PATH --model PATH --cache PATH --limit 4 --pooling cls|cls-gem|pooled --dim 384|768 --mean R,G,B --std R,G,B`. For CLS+GeM, `--dim` is the per-token dimension, so use 384 for a 768-dimensional result. Summarize its `challenger-result.json` using `python3 apps/backend/scripts/summarize-embedders.py DATASET/classes.csv CACHE/challenger-result.json`. Never store datasets or model weights in git.

## DINOv2 small CLS + GeM

Model SHA-256 `29248fed811ba6738498bfa4f9aaca832a7b5fabb8b91b933e73be7d7ea1a387`, 88,469,737 bytes, 768-dimensional output. Query embed time 156.4 ms/crop on the shared four-thread host.

| Group | Bucket | n | Top-1 | Top-5 |
|---|---|---:|---:|---:|
| all | all | 2340 | 1167/2340 (49.9%) | 1841/2340 (78.7%) |
| all | angle90 | 260 | 139/260 (53.5%) | 219/260 (84.2%) |
| all | far | 260 | 136/260 (52.3%) | 217/260 (83.5%) |
| all | occlusion50 | 260 | 106/260 (40.8%) | 179/260 (68.8%) |
| all | hard | 260 | 87/260 (33.5%) | 142/260 (54.6%) |
| packaged | all | 1008 | 173/1008 (17.2%) | 588/1008 (58.3%) |
| packaged | angle90 | 112 | 19/112 (17.0%) | 72/112 (64.3%) |
| packaged | far | 112 | 25/112 (22.3%) | 76/112 (67.9%) |
| packaged | occlusion50 | 112 | 7/112 (6.2%) | 47/112 (42.0%) |
| packaged | hard | 112 | 12/112 (10.7%) | 27/112 (24.1%) |
| produce | all | 1332 | 994/1332 (74.6%) | 1253/1332 (94.1%) |
| produce | angle90 | 148 | 120/148 (81.1%) | 147/148 (99.3%) |
| produce | far | 148 | 111/148 (75.0%) | 141/148 (95.3%) |
| produce | occlusion50 | 148 | 99/148 (66.9%) | 132/148 (89.2%) |
| produce | hard | 148 | 75/148 (50.7%) | 115/148 (77.7%) |

Among known ambiguous queries, top-1 is correct for 802/1948 (41.2%). Margin alone withholds 524/1233 correct top-ranked answers (42.5%).

## SigLIP2 base pooled

Model SHA-256 `1a9a53cfdf5409f64cd02b9b8b4cea9aad2366576d63acf30cff412cbfcea6db`, 371,803,508 bytes, 768-dimensional output. Query embed time 242.4 ms/crop on the shared four-thread host.

| Group | Bucket | n | Top-1 | Top-5 |
|---|---|---:|---:|---:|
| all | all | 2340 | 1782/2340 (76.2%) | 2171/2340 (92.8%) |
| all | angle90 | 260 | 223/260 (85.8%) | 256/260 (98.5%) |
| all | far | 260 | 220/260 (84.6%) | 254/260 (97.7%) |
| all | occlusion50 | 260 | 129/260 (49.6%) | 198/260 (76.2%) |
| all | hard | 260 | 142/260 (54.6%) | 200/260 (76.9%) |
| packaged | all | 1008 | 678/1008 (67.3%) | 867/1008 (86.0%) |
| packaged | angle90 | 112 | 93/112 (83.0%) | 108/112 (96.4%) |
| packaged | far | 112 | 91/112 (81.2%) | 106/112 (94.6%) |
| packaged | occlusion50 | 112 | 26/112 (23.2%) | 60/112 (53.6%) |
| packaged | hard | 112 | 34/112 (30.4%) | 65/112 (58.0%) |
| produce | all | 1332 | 1104/1332 (82.9%) | 1304/1332 (97.9%) |
| produce | angle90 | 148 | 130/148 (87.8%) | 148/148 (100.0%) |
| produce | far | 148 | 129/148 (87.2%) | 148/148 (100.0%) |
| produce | occlusion50 | 148 | 103/148 (69.6%) | 138/148 (93.2%) |
| produce | hard | 148 | 108/148 (73.0%) | 135/148 (91.2%) |

Among known ambiguous queries, top-1 is correct for 1258/1815 (69.3%). Margin alone withholds 1211/1697 correct top-ranked answers (71.4%).

## DINOv2 base CLS: incomplete

The Apache-2.0 model exported successfully (SHA-256 `6a229092c61f25f5aed56fd275b0acd759128347d0a56fc4adfb011b363b1249`, 346,563,914 bytes; 768 dimensions). The gallery finished, but the resumed evaluation was stopped at the 15-minute limit after 197 of 324 query images. No comparable aggregate, subset, bucket, ambiguity, or crop-latency result was produced. The cached gallery can be reused for a later full run.

## Recommendation

SigLIP2 pooled is the leading measured candidate for a follow-up on independent shop images: it raises aggregate top-1 from 51.5% to 76.2% and packaged top-1 from 18.7% to 67.3%, but neither meets the 90% goal. Do not switch production yet. Its measured query embedding cost increases by 78.2 ms/crop (about 48%) on this shared four-thread host. For a scan this implies approximately 78 ms extra per embedded crop, multiplied by its actual crop and test-time augmentation count; end-to-end scan latency and concurrent 4-vCPU service behavior have not been measured. The 768-dimensional vectors require a vector-column/index migration, a distinct model identity, and full reindexing before adoption. The modest CLS+GeM regression does not justify its 768-dimensional migration.
