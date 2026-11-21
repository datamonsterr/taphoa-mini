#!/usr/bin/env python3
"""Measure a local release API on four cores with real models and Compose Postgres.

Requires Python cryptography, taskset, existing model files and ONNX Runtime. Uses a
cached local signing key/JWKS server; no Clerk account or remote credentials needed.
Creates one disposable store in DATABASE_URL. Set storage variables from .env.example
for --latency. Run inside ~/.cache/taphoa-mini/heavy; build separately with -j 4.
"""
import argparse
import base64
import http.server
import json
import math
import os
from pathlib import Path
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa

BACKEND = Path(__file__).resolve().parents[1]


def b64(value):
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode()


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def multipart(path, fields):
    boundary = uuid.uuid4().hex
    body = bytearray()
    for name, value in fields.items():
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="fixture.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'.encode())
    body.extend(path.read_bytes())
    body.extend(f"\r\n--{boundary}--\r\n".encode())
    return bytes(body), {"Content-Type": f"multipart/form-data; boundary={boundary}"}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    parser.add_argument("--baseline", action="store_true", help="eager binary: skip warm/unload")
    parser.add_argument("--latency", type=int, default=0, metavar="RUNS")
    parser.add_argument("--idle", type=int, default=15)
    parser.add_argument("--output", type=Path, default=Path("/tmp/model-lifecycle.json"))
    parser.add_argument("--compare", type=Path, metavar="BASELINE", help="alternate baseline/new processes twice; >=20 warm samples per variant")
    args = parser.parse_args()
    if args.compare:
        samples = {"baseline": [], "new": []}
        runs = math.ceil(max(20, args.latency) / 2)
        for index, (name, binary) in enumerate([("baseline", args.compare), ("new", args.binary)] * 2):
            output = args.output.with_name(f"{args.output.stem}-{name}-{index}.json")
            command = [sys.executable, str(Path(__file__).resolve()), str(binary.resolve()), "--latency", str(runs), "--idle", str(args.idle), "--output", str(output)]
            if name == "baseline":
                command.append("--baseline")
            subprocess.run(command, check=True)
            samples[name].append(json.loads(output.read_text()))
        for name, processes in samples.items():
            print(name, "process samples:", json.dumps(processes, indent=2))
            for endpoint in ("scans", "segment", "receipts"):
                values = sorted(value for process in processes for value in process["latency"][endpoint]["wall_ms"])
                ocr_values = sorted(value for process in processes for value in process["latency"][endpoint]["ocr_ms"])
                percentile = lambda data, p: data[math.ceil(len(data) * p) - 1]
                print(f"{name} {endpoint}: n={len(values)} p50={percentile(values, .5)}ms p95={percentile(values, .95)}ms")
                if ocr_values:
                    print(f"{name} receipt OCR: p50={percentile(ocr_values, .5)}ms p95={percentile(ocr_values, .95)}ms")
        args.output.write_text(json.dumps(samples, indent=2) + "\n")
        return
    cache = Path.home() / ".cache/taphoa-mini/model-lifecycle-key.pem"
    cache.parent.mkdir(parents=True, exist_ok=True)
    if not cache.exists():
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        # Cache setup across processes, with private permissions from creation.
        with os.fdopen(os.open(cache, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb") as out:
            out.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    key = serialization.load_pem_private_key(cache.read_bytes(), password=None)
    pub = key.public_key().public_numbers()
    number = lambda n: b64(n.to_bytes((n.bit_length() + 7) // 8, "big"))
    jwks = json.dumps({"keys": [{"kty": "RSA", "alg": "RS256", "use": "sig", "kid": "local", "n": number(pub.n), "e": number(pub.e)}]}).encode()

    class Jwks(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(jwks)

        def log_message(self, *unused):
            pass

    jwks_server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Jwks)
    threading.Thread(target=jwks_server.serve_forever, daemon=True).start()
    issuer = "https://local-lifecycle.clerk.accounts.dev"
    now = int(time.time())
    claims = {"sub": f"user_{uuid.uuid4().hex}", "sid": f"sess_{uuid.uuid4().hex}", "iss": issuer, "exp": now + 3600, "nbf": now - 60}
    signing = f'{b64(json.dumps({"alg": "RS256", "kid": "local"}).encode())}.{b64(json.dumps(claims).encode())}'
    token = signing + "." + b64(key.sign(signing.encode(), padding.PKCS1v15(), hashes.SHA256()))
    env = os.environ.copy()
    env.update(PORT=str(free_port()), CLERK_ISSUER=issuer, CLERK_JWKS_URL=f"http://127.0.0.1:{jwks_server.server_port}/jwks", CLERK_AUTHORIZED_PARTIES="", CLERK_SECRET_KEY="", RUST_LOG="taphoa_api=info", LOG_FORMAT="json", SAM_THREADS="4", SAM_DECODERS="4", OCR_THREADS="4", MODEL_IDLE_UNLOAD_SECS=str(args.idle), RATE_LIMIT_RECEIPT_PER_MINUTE="1000", RATE_LIMIT_RECEIPT_STORE_PER_DAY="1000")
    model_dir = Path(env.get("MODEL_DIR", BACKEND / "models"))
    for name, filename in {"SAM_ENCODER_PATH": "mobile_sam_image_encoder.onnx", "SAM_DECODER_PATH": "sam_mask_decoder_multi.onnx", "DINO_MODEL_PATH": "dinov2_small.onnx", "OCR_DET_PATH": "ocr_det.onnx", "OCR_ENCODER_PATH": "ocr_vietocr_encoder.onnx", "OCR_DECODER_PATH": "ocr_vietocr_decoder.onnx", "OCR_VOCAB_PATH": "ocr_vietocr.json"}.items():
        env.setdefault(name, str(model_dir / filename))
    env.setdefault("DATABASE_URL", "postgres://taphoa:taphoa@127.0.0.1:55432/taphoa")
    if args.latency:
        for name, value in {"AWS_ENDPOINT_URL": "http://127.0.0.1:9000", "AWS_ACCESS_KEY_ID": "taphoa-local", "AWS_SECRET_ACCESS_KEY": "taphoa-local-secret", "AWS_S3_BUCKET_NAME": "images", "AWS_DEFAULT_REGION": "us-east-1", "S3_FORCE_PATH_STYLE": "true", "S3_CREATE_BUCKET": "true"}.items():
            env.setdefault(name, value)
    url = f'http://127.0.0.1:{env["PORT"]}' 

    def request(path, body=None, headers=None):
        auth = {"Authorization": f"Bearer {token}"}
        auth.update(headers or {})
        if isinstance(body, dict):
            body = json.dumps(body).encode()
            auth["Content-Type"] = "application/json"
        req = urllib.request.Request(url + path, data=body, headers=auth)
        with urllib.request.urlopen(req, timeout=150) as response:
            return json.load(response)

    log_path = args.output.with_suffix(".log")
    with log_path.open("w+") as log:
        started = time.monotonic()
        process = subprocess.Popen(["taskset", "-c", "0-3", str(args.binary.resolve())], cwd=BACKEND, env=env, stdout=log, stderr=log)
        try:
            while True:
                if process.poll() is not None:
                    raise RuntimeError(f"API exited: {log_path.read_text()}")
                try:
                    request("/healthz")
                    break
                except (OSError, urllib.error.URLError):
                    if time.monotonic() - started > 120:
                        raise RuntimeError("health deadline exceeded")
                    time.sleep(0.01)
            rss = lambda: int(next(line.split()[1] for line in Path(f"/proc/{process.pid}/status").read_text().splitlines() if line.startswith("VmRSS:")))
            results = {"shared_host_load_1m": os.getloadavg()[0], "health_ms": round((time.monotonic() - started) * 1000, 1), "start_rss_kib": rss()}
            request("/v1/stores", {"store_name": "Lifecycle measurement", "display_name": "Local"})
            if not args.baseline:
                start = time.monotonic()
                results["warm"] = request("/v1/recognition/warm", b"")
                results["warm_ms"] = round((time.monotonic() - start) * 1000, 1)
                results["warm_again"] = request("/v1/recognition/warm", b"")
            results["loaded_rss_kib"] = rss()
            print(json.dumps(results), flush=True)
            if args.latency:
                shelf = BACKEND / "tests/fixtures/shelf-1600.jpg"
                receipt = BACKEND / "crates/recognition/tests/fixtures/receipts/receipt-1.jpg"
                scan_body, scan_headers = multipart(shelf, {"mode": "multi", "purpose": "checkout"})
                segment_body, segment_headers = multipart(shelf, {})
                receipt_body, receipt_headers = multipart(receipt, {"mode": "multi", "purpose": "checkout"})
                receipt_scan = request("/v1/recognition/scans", receipt_body, receipt_headers)
                results["latency"] = {}
                for endpoint, body, headers in [("scans", scan_body, scan_headers), ("segment", segment_body, segment_headers), ("receipts", {"image_id": receipt_scan["image"]["id"]}, {})]:
                    samples = []
                    ocr_samples = []
                    for n in range(args.latency + 1):
                        path = {"scans": "/v1/recognition/scans", "segment": "/v1/segment", "receipts": "/v1/receipts"}[endpoint]
                        start = time.monotonic()
                        response = request(path, body, dict(headers, **{"Idempotency-Key": str(uuid.uuid4())}))
                        elapsed = round((time.monotonic() - start) * 1000, 1)
                        if n:
                            samples.append(elapsed)
                            if endpoint == "receipts":
                                ocr_samples.append(response["timings"]["ocr"])
                    results["latency"][endpoint] = {"wall_ms": samples, "ocr_ms": ocr_samples}
                    print(endpoint, results["latency"][endpoint], flush=True)
            results["post_inference_rss_kib"] = rss()
            if not args.baseline and args.idle:
                # Wait for every family to be unloaded, then another 30 seconds.
                deadline = time.monotonic() + args.idle * 3 + 120
                def all_unloaded():
                    states = {}
                    for line in log_path.read_text().splitlines():
                        try:
                            fields = json.loads(line).get("fields", {})
                        except json.JSONDecodeError:
                            continue
                        if fields.get("message") in ("model loaded", "model unloaded"):
                            states[fields["family"]] = fields["message"]
                    return len(states) == 3 and all(value == "model unloaded" for value in states.values())
                while not all_unloaded():
                    if time.monotonic() > deadline:
                        raise RuntimeError("not all model families unloaded")
                    time.sleep(0.1)
                time.sleep(30)
                results["unloaded_30s_rss_kib"] = rss()
                results["unloaded_shared_host_load_1m"] = os.getloadavg()[0]
            if args.baseline:
                time.sleep(30)
                results["retained_30s_rss_kib"] = rss()
                results["retained_shared_host_load_1m"] = os.getloadavg()[0]
            args.output.write_text(json.dumps(results, indent=2) + "\n")
            print(json.dumps(results, indent=2), flush=True)
        finally:
            process.terminate()
            process.wait(timeout=30)
            jwks_server.shutdown()


if __name__ == "__main__":
    main()
