import importlib.util
import json
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("scan_cost", Path(__file__).with_name("scan-cost.py"))
scan_cost = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan_cost)


class ScanCostTests(unittest.TestCase):
    def test_railway_wrapping_duplicates_and_shared_objects(self):
        fields = {"message": "recognition scan complete", "scan_id": "s1", "segment_ms": 1000, "embed_ms": 100, "total_ms": 2000}
        direct = json.dumps({"fields": fields})
        wrapped = json.dumps({"message": direct})
        text = "INFO recognition scan complete scan_id=s2 segment_ms=800 embed_ms=200 total_ms=1500"
        objects = [{"scan_id": s, "object_key": "shared", "bytes": 123} for s in ("s1", "s2")]
        result = scan_cost.summarize("\n".join([direct, wrapped, text]), objects, 4)
        self.assertEqual(result["scans"], 2)
        self.assertEqual(result["storage_bytes"], 123)
        self.assertEqual(result["cpu_seconds_per_scan"], 2)
        self.assertAlmostEqual(result["inference_wall_seconds_per_scan"], 1.05)

    def test_requires_scans_and_complete_inventory(self):
        with self.assertRaises(ValueError):
            scan_cost.summarize("other logs", [])
        log = "recognition scan complete scan_id=s segment_ms=1 embed_ms=2 total_ms=3"
        with self.assertRaises(ValueError):
            scan_cost.summarize(log, [])
        result = scan_cost.summarize(log, [{"scan_id": "s", "object_key": "k", "bytes": 5}])
        self.assertIsNone(result["cpu_seconds_per_scan"])
        with self.assertRaises(ValueError):
            scan_cost.summarize(log, [{"scan_id": "s", "object_key": "k", "bytes": -1}])


if __name__ == "__main__":
    unittest.main()
