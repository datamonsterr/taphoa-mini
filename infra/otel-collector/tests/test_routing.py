"""Exercise the real pinned Collector against local OTLP/HTTP recording sinks."""

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
        cls.http_id = "22" * 8
        cls.agent_id = "33" * 8
        cls.chat_id = "44" * 8
        cls.tool_id = "55" * 8
        spans = []
        for name, span_id, parent, scope in [
            ("http", cls.http_id, None, "taphoa.http"),
            ("agent", cls.agent_id, cls.http_id, "taphoa.assistant"),
            ("chat", cls.chat_id, cls.agent_id, "taphoa.assistant"),
            ("tool", cls.tool_id, cls.agent_id, "taphoa.tools"),
        ]:
            span = {"name": name, "traceId": cls.trace_id, "spanId": span_id,
                    "startTimeUnixNano": "1800000000000000000", "endTimeUnixNano": "1800000000001000000",
                    "attributes": sensitive_attributes()}
            if parent:
                span["parentSpanId"] = parent
            spans.append({"scope": {"name": scope}, "spans": [span]})
        cls.trace_payload = {"resourceSpans": [
            {"resource": {"attributes": sensitive_attributes() + attributes({"deployment.environment.name": "test"})}, "scopeSpans": spans},
            {"resource": {"attributes": sensitive_attributes()}, "scopeSpans": [
                {"scope": {"name": "taphoa.assistant"}, "spans": [dict(copy.deepcopy(spans[1]["spans"][0]), name="unknown-env", spanId="77" * 8)]}
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
            if len(cls.items("/i/v1/traces", "resourceSpans", "scopeSpans", "spans")) == 5 and len(cls.items("/i/v1/logs", "resourceLogs", "scopeLogs", "logRecords")) == 4:
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

    def test_all_spans_reach_posthog_with_parents(self):
        posthog = {s["name"]: s for _, s in self.items("/i/v1/traces", "resourceSpans", "scopeSpans", "spans")}
        self.assertEqual(set(posthog), {"http", "agent", "chat", "tool", "unknown-env"})
        self.assertNotIn("parentSpanId", posthog["http"])
        self.assertEqual(posthog["agent"]["parentSpanId"], self.http_id)
        self.assertEqual(posthog["chat"]["parentSpanId"], self.agent_id)
        self.assertEqual(posthog["tool"]["parentSpanId"], self.agent_id)
        self.assertEqual(posthog["unknown-env"]["parentSpanId"], self.http_id)
        for span in posthog.values():
            self.assertEqual(span["traceId"], self.trace_id)

    def test_logs_reach_posthog(self):
        logs = self.items("/i/v1/logs", "resourceLogs", "scopeLogs", "logRecords")
        self.assertEqual(len(logs), 4)

    def test_only_posthog_receives_requests(self):
        self.assertEqual({path for path, _headers, _body in self.requests}, {"/i/v1/traces", "/i/v1/logs"})

    def test_posthog_headers_and_retry(self):
        self.assertEqual(self.failures, {"/i/v1/traces", "/i/v1/logs"})
        self.assertTrue(self.requests)
        for _path, headers, _body in self.requests:
            headers = {key.lower(): value for key, value in headers.items()}
            self.assertEqual(headers["authorization"], "Bearer posthog-test-token")

    def test_redaction_on_all_pipelines(self):
        for path, resources, scopes, records in (
            ("/i/v1/traces", "resourceSpans", "scopeSpans", "spans"),
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
            ("/i/v1/logs", "resourceLogs", "scopeLogs", "logRecords", {"production", "unknown"}),
        ):
            actual = {values(r["attributes"])["deployment.environment.name"]["stringValue"] for r, _ in self.items(path, resources, scopes, records)}
            self.assertEqual(actual, expected)


if __name__ == "__main__":
    unittest.main()
