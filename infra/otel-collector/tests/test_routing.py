"""Exercise the real pinned Collector against local OTLP/HTTP recording sinks."""

import base64
import copy
import http.server
import json
import pathlib
import shutil
import socket
import subprocess
import threading
import time
import unittest
import urllib.error
import urllib.request
import uuid


ROOT = pathlib.Path(__file__).resolve().parents[1]
IMAGE = "otel/opentelemetry-collector-contrib:0.163.2"
TOKEN = "collector-test-token"
SENSITIVE = (
    "http.request.header.authorization",
    "cookie",
    "http.request.header.cookie",
    "session.Cookie.value",
    "auth.token",
    "auth.secret",
    "token",
    "secret",
)


def attributes(values):
    return [{"key": key, "value": {"stringValue": value}} for key, value in values.items()]


def values(attrs):
    return {item["key"]: item["value"] for item in attrs}


def sensitive_attributes():
    return attributes(dict.fromkeys(SENSITIVE, "must-disappear") | {"safe": "kept"})


class RoutingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not shutil.which("docker"):
            raise unittest.SkipTest("Docker is unavailable: docker executable not found")
        probe = subprocess.run(["docker", "info"], capture_output=True, timeout=30)
        if probe.returncode:
            raise unittest.SkipTest("Docker is unavailable: daemon cannot be reached")
        if not (ROOT / "config.yaml").is_file():
            raise AssertionError("Collector config.yaml must implement the routing contract")
        cls.requests = []
        cls.failures = set()
        cls.lock = threading.Lock()

        class Sink(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                with cls.lock:
                    # A short outage must be retried for each exporter.
                    failed = self.path not in cls.failures
                    cls.failures.add(self.path)
                    if not failed:
                        cls.requests.append((self.path, dict(self.headers), json.loads(body)))
                self.send_response(503 if failed else 200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b"{}")

            def log_message(self, *_args):
                pass

        cls.sink = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Sink)
        cls.addClassCleanup(cls.sink.server_close)
        cls.addClassCleanup(cls.sink.shutdown)
        threading.Thread(target=cls.sink.serve_forever, daemon=True).start()
        # The receiver endpoint deliberately stays the production IPv6 wildcard.
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 4318))
        cls.container = "taphoa-otel-test-" + uuid.uuid4().hex[:12]
        cls.addClassCleanup(cls.stop_collector)
        sink_url = f"http://127.0.0.1:{cls.sink.server_port}"
        command = [
            "docker", "run", "--detach", "--rm", "--network", "host",
            "--name", cls.container, "--mount", f"type=bind,src={ROOT},dst=/config,readonly",
        ]
        for key, value in {
            "COLLECTOR_BEARER_TOKEN": TOKEN,
            "LANGFUSE_OTLP_ENDPOINT": sink_url + "/api/public/otel",
            "LANGFUSE_PUBLIC_KEY": "public",
            "LANGFUSE_SECRET_KEY": "secret",
            "POSTHOG_HOST": sink_url,
            "POSTHOG_PROJECT_TOKEN": "posthog-test-token",
        }.items():
            command.extend(["--env", f"{key}={value}"])
        command.extend([IMAGE, "--config=/config/config.yaml", "--config=/config/tests/override.yaml"])
        subprocess.run(command, check=True, capture_output=True, timeout=180)
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                if cls.send("logs", {}, None) == 401:
                    break
            except urllib.error.URLError:
                pass
            if subprocess.check_output(["docker", "inspect", "-f", "{{.State.Running}}", cls.container], text=True).strip() != "true":
                break
            time.sleep(0.1)
        else:
            raise AssertionError("Collector did not become ready")
        cls.trace_id = "11" * 16
        cls.invoke_id = "22" * 8
        cls.http_id = "33" * 8
        cls.chat_id = "44" * 8
        spans = []
        for name, span_id, parent, operation in [
            ("invoke", cls.invoke_id, cls.http_id, "invoke_agent"),
            ("chat", cls.chat_id, cls.invoke_id, "chat"),
            ("scope-only", "55" * 8, cls.invoke_id, None),
            ("http", cls.http_id, None, None),
            ("genai-other-scope", "66" * 8, cls.invoke_id, "execute_tool"),
        ]:
            span = {"name": name, "traceId": cls.trace_id, "spanId": span_id,
                    "startTimeUnixNano": "1800000000000000000", "endTimeUnixNano": "1800000000001000000",
                    "attributes": sensitive_attributes()}
            if parent:
                span["parentSpanId"] = parent
            if operation:
                span["attributes"] += attributes({"gen_ai.operation.name": operation})
            if name == "scope-only":
                span["attributes"] += attributes({"langfuse.environment": "explicit"})
            scope = "taphoa.assistant" if name in ("invoke", "chat", "scope-only") else "taphoa.http"
            spans.append({"scope": {"name": scope}, "spans": [span]})
        cls.trace_payload = {"resourceSpans": [
            {"resource": {"attributes": sensitive_attributes() + attributes({"deployment.environment.name": "test"})}, "scopeSpans": spans},
            {"resource": {"attributes": sensitive_attributes()}, "scopeSpans": [
                {"scope": {"name": "taphoa.assistant"}, "spans": [dict(copy.deepcopy(spans[0]["spans"][0]), name="unknown-env", spanId="77" * 8)]}
            ]},
        ]}
        cls.log_payload = {"resourceLogs": [
            {"resource": {"attributes": sensitive_attributes() + attributes(env)}, "scopeLogs": [
                {"scope": {"name": "taphoa.logs"}, "logRecords": [
                    {"body": {"stringValue": "account 123456789012 end"}, "attributes": sensitive_attributes()},
                    {"body": {"intValue": "42"}, "attributes": sensitive_attributes()},
                ]}
            ]} for env in ({}, {"deployment.environment.name": "production"})
        ]}
        for signal, payload in (("traces", cls.trace_payload), ("logs", cls.log_payload)):
            if cls.send(signal, payload, TOKEN) != 200:
                raise AssertionError(f"Authenticated {signal} were rejected")
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if len(cls.items("/i/v1/traces", "resourceSpans", "scopeSpans", "spans")) == 6 and len(cls.items("/api/public/otel/v1/traces", "resourceSpans", "scopeSpans", "spans")) == 5 and len(cls.items("/i/v1/logs", "resourceLogs", "scopeLogs", "logRecords")) == 4:
                return
            time.sleep(0.1)
        diagnostics = subprocess.run(["docker", "logs", cls.container], capture_output=True, text=True)
        raise AssertionError(f"Timed out waiting for exports: {cls.requests}\n{diagnostics.stderr}")

    @classmethod
    def stop_collector(cls):
        subprocess.run(["docker", "rm", "--force", cls.container], capture_output=True, timeout=30)

    @staticmethod
    def send(signal, payload, token):
        headers = {"Content-Type": "application/json"}
        if token is not None:
            headers["Authorization"] = "Bearer " + token
        request = urllib.request.Request("http://127.0.0.1:4318/v1/" + signal, json.dumps(payload).encode(), headers)
        try:
            with urllib.request.urlopen(request, timeout=5) as response:
                return response.status
        except urllib.error.HTTPError as error:
            with error:
                return error.code

    @classmethod
    def items(cls, path, resources, scopes, records):
        with cls.lock:
            return [(resource["resource"], record)
                    for route, _headers, body in cls.requests if route == path
                    for resource in body.get(resources, [])
                    for scope in resource.get(scopes, [])
                    for record in scope.get(records, [])]

    def test_bearer_authentication(self):
        for signal in ("traces", "logs"):
            self.assertEqual(self.send(signal, {}, None), 401)
            self.assertEqual(self.send(signal, {}, "wrong"), 401)
            self.assertEqual(self.send(signal, {}, TOKEN), 200)

    def test_routing_and_langfuse_roots(self):
        posthog = {s["name"]: s for _, s in self.items("/i/v1/traces", "resourceSpans", "scopeSpans", "spans")}
        langfuse = {s["name"]: s for _, s in self.items("/api/public/otel/v1/traces", "resourceSpans", "scopeSpans", "spans")}
        self.assertEqual(set(posthog), {"invoke", "chat", "scope-only", "http", "genai-other-scope", "unknown-env"})
        self.assertEqual(set(langfuse), set(posthog) - {"http"})
        self.assertIn(langfuse["invoke"].get("parentSpanId", ""), ("", "0000000000000000"))
        self.assertEqual(langfuse["chat"]["parentSpanId"], self.invoke_id)
        self.assertEqual(posthog["invoke"]["parentSpanId"], self.http_id)
        self.assertEqual(langfuse["invoke"]["traceId"], posthog["invoke"]["traceId"])
        for name, span in langfuse.items():
            expected = "explicit" if name == "scope-only" else "unknown" if name == "unknown-env" else "test"
            self.assertEqual(values(span["attributes"])["langfuse.environment"], {"stringValue": expected})

    def test_vendor_headers_and_retry(self):
        expected = {"/api/public/otel/v1/traces", "/i/v1/traces", "/i/v1/logs"}
        self.assertEqual(self.failures, expected)
        for path, headers, _body in self.requests:
            headers = {key.lower(): value for key, value in headers.items()}
            if path.startswith("/api"):
                self.assertEqual(headers["authorization"], "Basic " + base64.b64encode(b"public:secret").decode())
                self.assertEqual(headers["x-langfuse-ingestion-version"], "4")
            else:
                self.assertEqual(headers["authorization"], "Bearer posthog-test-token")

    def test_redaction_on_all_pipelines(self):
        for path, resources, scopes, records in (
            ("/i/v1/traces", "resourceSpans", "scopeSpans", "spans"),
            ("/api/public/otel/v1/traces", "resourceSpans", "scopeSpans", "spans"),
            ("/i/v1/logs", "resourceLogs", "scopeLogs", "logRecords"),
        ):
            for resource, record in self.items(path, resources, scopes, records):
                for attrs in (resource["attributes"], record["attributes"]):
                    actual = values(attrs)
                    self.assertFalse(set(SENSITIVE) & actual.keys())
                    self.assertEqual(actual["safe"], {"stringValue": "kept"})
                if records == "logRecords":
                    if "stringValue" in record["body"]:
                        self.assertEqual(record["body"]["stringValue"], "account [REDACTED] end")
                    else:
                        self.assertEqual(record["body"], {"intValue": "42"})

    def test_resource_defaults(self):
        for path, resources, scopes, records, expected in (
            ("/i/v1/traces", "resourceSpans", "scopeSpans", "spans", {"test", "unknown"}),
            ("/api/public/otel/v1/traces", "resourceSpans", "scopeSpans", "spans", {"test", "unknown"}),
            ("/i/v1/logs", "resourceLogs", "scopeLogs", "logRecords", {"production", "unknown"}),
        ):
            actual = {values(r["attributes"])["deployment.environment.name"]["stringValue"] for r, _ in self.items(path, resources, scopes, records)}
            self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
