# SigLIP2 production decision (B5)

The pinned FP32 export reproduces the E2 K=8 result: **1782/2340 top-1 (76.2%)**,
2171/2340 top-5 (92.8%). Dynamic INT8 achieves 1337/2340 (57.1%) top-1 and is rejected
because its 19.0171-point loss exceeds the strict <1.5-point limit. Both use seed 42,
four test photos per class, nine synthetic buckets and four ONNX threads. Neither
establishes the C2 90% shop-photo target. Raw
[FP32](2026-11-02-siglip2-fp32.json) and [INT8](2026-11-02-siglip2-int8.json)
query observations are committed.

Production uses `EMBEDDER=siglip2`, pooled 768-d output at 224 px, mean/std 0.5,
model ID `siglip2-b16-224-onnx@1/lb224`. FP32 SHA256:
`1a9a53cfdf5409f64cd02b9b8b4cea9aad2366576d63acf30cff412cbfcea6db`.
The pinned Python 3.11.15 export reproduces that hash. The artifact is the sole ONNX
asset in the public
[versioned prerelease](https://github.com/datamonsterr/taphoa-mini/releases/tag/models-siglip2-b16-224-v1);
weights remain outside git. The quantization recipe and direct dependencies are
pinned under `apps/backend/scripts/`.

Per the revised policy, thresholds maximize coverage at 95% fit precision and the
floor retains at least 95% of enrolled fit queries. The 97% rule is also reported.
All boundary selection uses the fit classes only. SigLIP2's default rule has held
precision 124/149 (83.2%) and coverage 149/1476 (10.1%); its 97% rule has precision 82/89
(92.1%) and coverage 89/1476 (6.0%). The selected floor retains 1145/1188 (96.4%) held
known queries while rejecting 24/288 (8.3%) unknown queries. Duplicate precision is
43/44 (97.7%) on its held gallery half. Match precision remains below the fit target;
this is not a validated production precision guarantee. The same held half is reused
for comparing the revised policy, not a fresh confirmatory evaluation.

The [retrieval spec](../../../../docs/specs/retrieval-v2.md#b5-threshold-calibration)
records all SigLIP2 and DINOv2 defaults, the class split, exact sweep, duplicate
source-photo exclusion, fit/report counts and reproduction commands.
[Machine-readable results](2026-11-02-siglip2-production.json) include source hashes,
classes, duplicate pairs, quantization, all latency samples, image size and startup
RAM; [DINOv2 calibration](2026-11-02-dinov2-production.json) is separate.

The [latency report](../../../../docs/specs/recognition-latency.md) measures FP32
embedding p95 at 258.0/723.2/1192.6 ms for 1/3/5 crops on four threads. This excludes
transport and other scan stages, so it does not prove the C3 8 s device/WAN gate.
The [deployment guide](../../../../docs/deploy.md) records the 354.6 MiB uncompressed
weight delta and local startup RSS of about 1.34 GiB with SAM/OCR/SigLIP2 loaded.
No deployment was performed.
