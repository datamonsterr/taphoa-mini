# Recognition resources per scan

Run a controlled checkout-only workload on Railway `test`. Record UTC start/end,
commit/deployment ID, replica ID, model settings, and scan IDs. Warm the models
first; wait for thumbnail uploads before taking the storage inventory. Keep the
raw inputs and output beside the run evidence. No spec measurements are changed
by this tool.

With the CLI linked to the project, export that exact window (substitute times):

```bash
railway logs --environment test --service backend --json \
  --since 2026-10-28T10:00:00Z --until 2026-10-28T10:05:00Z \
  --filter 'recognition scan complete' > scans.jsonl
```

Record the service container's cumulative CPU counter immediately before and
after the workload. Pin the same deployment instance in both calls; a restart
invalidates the delta:

```bash
railway ssh --environment test --service backend \
  --deployment-instance "$INSTANCE_ID" cat /sys/fs/cgroup/cpu.stat > cpu-before.txt
# Run scans here, then wait for their background thumbnail uploads.
railway ssh --environment test --service backend \
  --deployment-instance "$INSTANCE_ID" cat /sys/fs/cgroup/cpu.stat > cpu-after.txt
```

CPU seconds = `(after.usage_usec - before.usage_usec) / 1000000`. This measures all
backend container threads, including overlapping OCR; do not multiply the elapsed
inference timings by thread count. Use one replica and an otherwise idle service,
or subtract an independently measured idle-window CPU baseline and document it.
If cgroup counters are unavailable, integrate Railway's CPU usage in vCPUs over
the same window in seconds. Capture the series and integration method. Database
and Redis CPU are separate services and excluded here.

Export all original and crop keys for the logged scan IDs via a read-only SQL
query (replace the example UUID list):

```sql
WITH run AS (SELECT * FROM scans WHERE id IN ('00000000-0000-0000-0000-000000000000')),
keys AS (
  SELECT id AS scan_id, image_id FROM run
  UNION
  SELECT d.scan_id, d.crop_image_id FROM detections d JOIN run ON run.id=d.scan_id
)
SELECT json_build_object('scan_id', k.scan_id, 'object_key', i.object_key,
                         'bytes', i.byte_size)
FROM keys k JOIN images i ON i.id=k.image_id;
```

Save unaligned, tuples-only output as `objects.jsonl`. `byte_size` is the encoded
object length persisted by the backend. Verify each unique key exists with S3
`HeadObject` using the bucket's configured endpoint and credentials; its
`ContentLength` must match `bytes`. A missing crop object fails the inventory
check; wait for uploads or investigate it. Include all originals and thumbnails,
exclude enrollment references, and deduplicate reused original objects. Avoid
exporting credentials or presigned URLs.

```bash
python3 scripts/metrics/scan-cost.py --logs scans.jsonl --objects objects.jsonl \
  --cpu-seconds 12.345 > resources-per-scan.json
```

The script accepts tracing JSON, Railway-wrapped JSON, or plain key/value logs;
it deduplicates scan IDs and object keys and requires inventory coverage of every
scan. It reports CPU seconds and stored bytes per completed scan alongside stage
**wall** times. Without `--cpu-seconds`, CPU is explicitly null. Verify the SQL
inventory includes every crop: coverage alone cannot detect a missing row within
a scan.

Convert resources to cost using rates from the actual Railway bill: CPU
seconds/scan times CPU price/second, plus bytes/scan times retention seconds times
storage price/byte-second. Add measured RAM byte-seconds, storage requests,
egress, database/Redis allocation and idle amortization for a full server cost.
State retention, currency, rates, and throughput; the script's CPU/storage result
alone is not a complete billed cost per scan.
