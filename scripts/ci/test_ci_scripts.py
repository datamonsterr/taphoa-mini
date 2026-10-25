"""Tests for the CI helper scripts. Run: python3 -m unittest discover -s scripts/ci -v"""

import http.server
import json
import os
import pathlib
import subprocess
import tempfile
import textwrap
import threading
import unittest

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent

JUNIT = textwrap.dedent(
    """\
    <?xml version="1.0" encoding="UTF-8"?>
    <testsuites name="nextest-run" tests="4" failures="1" errors="0" time="1.5">
      <testsuite name="taphoa-api::health" tests="3" disabled="0" errors="0" failures="1">
        <testcase name="ok_one" classname="taphoa-api::health" time="0.10"/>
        <testcase name="ok_two" classname="taphoa-api::health" time="0.90"/>
        <testcase name="boom" classname="taphoa-api::health" time="0.20">
          <failure message="assertion failed">stack</failure>
        </testcase>
      </testsuite>
      <testsuite name="taphoa-recognition" tests="1" disabled="0" errors="0" failures="0">
        <testcase name="skipped_one" classname="taphoa-recognition" time="0.00"><skipped/></testcase>
      </testsuite>
    </testsuites>
    """
)


def run(cmd, env=None, cwd=None):
    full_env = {**os.environ, **(env or {})}
    return subprocess.run(cmd, capture_output=True, text=True, env=full_env, cwd=cwd, check=False)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass


class JunitSummary(unittest.TestCase):
    def test_counts_and_failures(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp, "junit.xml")
            path.write_text(JUNIT)
            out = run(["python3", "-I", str(HERE / "junit_summary.py"), "Unit 1/2", str(path)])
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("### Unit 1/2", out.stdout)
        self.assertIn("| 4 | 2 | 1 | 1 |", out.stdout)  # total, passed, failed, skipped
        self.assertIn("taphoa-api::health::boom", out.stdout)
        self.assertIn("ok_two", out.stdout)  # slowest list

    def test_missing_file_is_not_fatal(self):
        out = run(["python3", "-I", str(HERE / "junit_summary.py"), "Unit", "/nonexistent/junit.xml"])
        self.assertEqual(out.returncode, 0)
        self.assertIn("no JUnit report", out.stdout)


class JobSummary(unittest.TestCase):
    def test_writes_status_and_duration(self):
        out = run(
            ["bash", str(HERE / "job-summary.sh"), "fmt", "formatted"],
            env={"JOB_START": "0", "JOB_STATUS": "success", "GITHUB_STEP_SUMMARY": ""},
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("### fmt", out.stdout)
        self.assertIn("success", out.stdout)
        self.assertIn("formatted", out.stdout)
        self.assertRegex(out.stdout, r"\d+s")


class RunE2e(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def test_requires_backend_url(self):
        out = run(["bash", str(HERE / "run-e2e.sh")], env={"BACKEND_URL": ""})
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("BACKEND_URL", out.stderr)

    def test_missing_suite_falls_back_to_smoke_and_latency(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = run(
                ["bash", str(HERE / "run-e2e.sh")],
                env={"BACKEND_URL": self.url, "E2E_DIR": tmp + "/absent", "LATENCY_SAMPLES": "5"},
            )
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("::notice::", out.stdout)
        self.assertIn("p95", out.stdout)

    def test_suite_requires_clerk_secret_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            pathlib.Path(tmp, "package.json").write_text("{}")
            out = run(
                ["bash", str(HERE / "run-e2e.sh")],
                env={"BACKEND_URL": self.url, "E2E_DIR": tmp, "CLERK_SECRET_KEY": ""},
            )
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("CLERK_SECRET_KEY", out.stderr)
        self.assertNotIn("Running e2e suite", out.stdout)  # failed before starting the suite

    def test_suite_runs_through_pnpm_when_clerk_secret_key_is_set(self):
        with tempfile.TemporaryDirectory() as tmp:
            suite = pathlib.Path(tmp, "suite")
            suite.mkdir()
            suite.joinpath("package.json").write_text(json.dumps({"scripts": {"test:e2e": "x"}}))
            bin_dir = pathlib.Path(tmp, "bin")
            bin_dir.mkdir()
            calls = pathlib.Path(tmp, "pnpm-calls")
            stub = bin_dir / "pnpm"
            stub.write_text(
                f'#!/usr/bin/env bash\necho "$@ url=$BACKEND_URL key_set=${{CLERK_SECRET_KEY:+yes}}" >> {calls}\n'
            )
            stub.chmod(0o755)
            out = run(
                ["bash", str(HERE / "run-e2e.sh")],
                env={
                    "BACKEND_URL": self.url,
                    "E2E_DIR": str(suite),
                    "CLERK_SECRET_KEY": "sk_test_unit_secret",
                    "LATENCY_SAMPLES": "3",
                    "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                },
            )
            recorded = calls.read_text()
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("--filter @taphoa/e2e run test:e2e", recorded)
        self.assertIn(f"url={self.url}", recorded)
        self.assertIn("key_set=yes", recorded)
        self.assertNotIn("sk_test_unit_secret", out.stdout + out.stderr)

    def test_latency_budget_fails(self):
        out = run(
            ["python3", "-I", str(HERE / "latency_check.py"), self.url, "/healthz", "5", "0"],
        )
        self.assertNotEqual(out.returncode, 0)
        out = run(
            ["python3", "-I", str(HERE / "latency_check.py"), self.url, "/healthz", "5", "5000"],
        )
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)


class RailwayEnv(unittest.TestCase):
    def test_build_env_uses_public_proxies_and_bucket(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location("railway_env", HERE / "railway_env.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        env = module.build_env(
            {
                "RAILWAY_TCP_PROXY_DOMAIN": "metro.proxy.rlwy.net",
                "RAILWAY_TCP_PROXY_PORT": "1234",
                "PGUSER": "postgres",
                "PGPASSWORD": "p@ss/word",
                "PGDATABASE": "railway",
            },
            {"RAILWAY_TCP_PROXY_DOMAIN": "r.proxy.rlwy.net", "RAILWAY_TCP_PROXY_PORT": "99", "REDIS_PASSWORD": "rp"},
            {"AWS_ENDPOINT_URL": "https://s3", "AWS_S3_BUCKET_NAME": "b", "RUST_LOG": "info"},
        )
        self.assertEqual(env["DATABASE_URL"], "postgres://postgres:p%40ss%2Fword@metro.proxy.rlwy.net:1234/railway")
        self.assertEqual(env["REDIS_URL"], "redis://default:rp@r.proxy.rlwy.net:99")
        self.assertEqual(env["AWS_S3_BUCKET_NAME"], "b")
        self.assertNotIn("RUST_LOG", env)


class WaitHealthy(unittest.TestCase):
    def test_succeeds_against_healthy_server(self):
        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            out = run(
                ["bash", str(HERE / "wait-healthy.sh"), f"http://127.0.0.1:{server.server_address[1]}"],
                env={"WAIT_ATTEMPTS": "2", "WAIT_INTERVAL": "0"},
            )
        finally:
            server.shutdown()
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)

    def test_fails_when_unreachable(self):
        out = run(
            ["bash", str(HERE / "wait-healthy.sh"), "http://127.0.0.1:9"],
            env={"WAIT_ATTEMPTS": "2", "WAIT_INTERVAL": "0"},
        )
        self.assertNotEqual(out.returncode, 0)


SAMPLE_PNG = (REPO / "apps/backend/tests/fixtures/sample.png").read_bytes()
CLERK_KEY = "sk_test_smoke_secret"
SMOKE_JWT = "jwt-smoke-token"


class SmokeServer:
    """Backend and Clerk Backend API on one loopback server; records every request.

    `forced[(method, path)]` is a list of (status, headers) answers served before the normal one.
    """

    def __init__(self):
        self.requests = []
        self.forced = {}
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def reply(self, status, body=b"", content_type="application/json", headers=None):
                self.send_response(status)
                self.send_header("content-type", content_type)
                self.send_header("content-length", str(len(body)))
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(body)

            def serve(self):
                length = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(length) if length else b""
                headers = {k.lower(): v for k, v in self.headers.items()}
                outer.requests.append((self.command, self.path, headers, body))
                forced = outer.forced.get((self.command, self.path))
                if forced:
                    status, extra = forced.pop(0)
                    return self.reply(status, b'{"errors":[{"code":"forced"}]}', headers=extra)
                return self.route(headers)

            def route(self, headers):
                method, path = self.command, self.path
                clerk_auth = headers.get("authorization") == f"Bearer {CLERK_KEY}"
                user_auth = headers.get("authorization") == f"Bearer {SMOKE_JWT}"
                if (method, path) in (("GET", "/healthz"), ("GET", "/readyz")):
                    return self.reply(200, b"ok", "text/plain")
                if (method, path) == ("POST", "/v1/segment"):
                    return self.reply(200, b'{"detections":[]}')
                if path.startswith("/v1/users") or path.startswith("/v1/sessions"):
                    if not clerk_auth:
                        return self.reply(401, b'{"errors":[{"code":"authentication_invalid"}]}')
                    if (method, path) == ("POST", "/v1/users"):
                        return self.reply(200, b'{"object":"user","id":"user_smoke1"}')
                    if (method, path) == ("POST", "/v1/sessions"):
                        return self.reply(200, b'{"object":"session","id":"sess_smoke1"}')
                    if (method, path) == ("POST", "/v1/sessions/sess_smoke1/tokens"):
                        return self.reply(200, json.dumps({"object": "token", "jwt": SMOKE_JWT}).encode())
                    if (method, path) == ("DELETE", "/v1/users/user_smoke1"):
                        return self.reply(200, b'{"object":"user","id":"user_smoke1","deleted":true}')
                    return self.reply(404)
                if path == "/blob/sample.png":
                    return self.reply(200, SAMPLE_PNG, "image/png")
                if path.startswith("/v1/stores") or path.startswith("/v1/images"):
                    if not user_auth:
                        return self.reply(401, b'{"error":"unauthorized","code":"unauthorized"}')
                    if (method, path) == ("POST", "/v1/stores"):
                        return self.reply(201, b'{"store":{"id":"s1"},"member":{"id":"m1"}}')
                    if (method, path) == ("POST", "/v1/images"):
                        return self.reply(201, b'{"id":"img1"}')
                    if (method, path) == ("GET", "/v1/images/img1"):
                        url = outer.url + "/blob/sample.png"
                        return self.reply(200, json.dumps({"id": "img1", "url": url}).encode())
                return self.reply(404)

            do_GET = do_POST = do_DELETE = serve

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()

    def calls(self):
        return [(method, path) for method, path, _, _ in self.requests]

    def body(self, method, path):
        for m, p, _, body in self.requests:
            if (m, p) == (method, path):
                return json.loads(body)
        raise AssertionError(f"no {method} {path} request")


class BackendSmoke(unittest.TestCase):
    """apps/backend/scripts/e2e.sh: store creation and the image round trip use a Clerk token."""

    script = REPO / "apps/backend/scripts/e2e.sh"

    def setUp(self):
        self.server = SmokeServer()
        self.addCleanup(self.server.close)

    def smoke(self, key=CLERK_KEY, **extra):
        env = {"BASE_URL": self.server.url, "CLERK_API_URL": self.server.url, "CLERK_SECRET_KEY": key}
        env.update(extra)
        return run(["bash", str(self.script)], env=env)

    def test_mints_a_clerk_token_and_deletes_the_user(self):
        out = self.smoke()
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertEqual(
            self.server.calls(),
            [
                ("GET", "/healthz"),
                ("GET", "/readyz"),
                ("POST", "/v1/segment"),
                ("POST", "/v1/users"),
                ("POST", "/v1/sessions"),
                ("POST", "/v1/sessions/sess_smoke1/tokens"),
                ("POST", "/v1/stores"),
                ("POST", "/v1/images"),
                ("GET", "/v1/images/img1"),
                ("GET", "/blob/sample.png"),
                ("DELETE", "/v1/users/user_smoke1"),
            ],
        )
        user = self.server.body("POST", "/v1/users")
        self.assertEqual(len(user["email_address"]), 1)
        self.assertRegex(user["email_address"][0], r"^e2e-smoke-[0-9a-f]+\+clerk_test@example\.com$")
        self.assertIs(user["skip_password_requirement"], True)
        self.assertEqual(self.server.body("POST", "/v1/sessions"), {"user_id": "user_smoke1"})
        self.assertEqual(
            self.server.body("POST", "/v1/sessions/sess_smoke1/tokens"), {"expires_in_seconds": 600}
        )
        self.assertEqual(
            self.server.body("POST", "/v1/stores"), {"store_name": "e2e script", "display_name": "Lead"}
        )

    def test_never_prints_the_secret_key_or_the_token(self):
        out = self.smoke()
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        for secret in (CLERK_KEY, SMOKE_JWT):
            self.assertNotIn(secret, out.stdout + out.stderr)

    def test_without_secret_key_skips_only_the_authenticated_checks(self):
        out = self.smoke(key="")
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("::notice::", out.stdout)
        self.assertIn("CLERK_SECRET_KEY", out.stdout)
        self.assertEqual(
            self.server.calls(), [("GET", "/healthz"), ("GET", "/readyz"), ("POST", "/v1/segment")]
        )

    def test_deletes_the_user_even_when_a_check_fails(self):
        self.server.forced[("POST", "/v1/stores")] = [(500, {})]
        out = self.smoke()
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("/v1/stores", out.stderr)
        self.assertEqual(self.server.calls()[-1], ("DELETE", "/v1/users/user_smoke1"))

    def test_user_creation_failure_fails_without_a_delete(self):
        self.server.forced[("POST", "/v1/users")] = [(422, {})]
        out = self.smoke()
        self.assertNotEqual(out.returncode, 0)
        self.assertNotIn(("DELETE", "/v1/users/user_smoke1"), self.server.calls())
        self.assertNotIn(("POST", "/v1/stores"), self.server.calls())

    def test_rate_limited_clerk_call_is_retried(self):
        self.server.forced[("POST", "/v1/users")] = [(429, {"retry-after": "0"})]
        out = self.smoke()
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertEqual(self.server.calls().count(("POST", "/v1/users")), 2)

    def test_failed_cleanup_only_warns(self):
        self.server.forced[("DELETE", "/v1/users/user_smoke1")] = [(500, {})]
        out = self.smoke()
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("user_smoke1", out.stderr)


DEV_CLERK_KEY = "pk_test_ZnVsbC1tb2NjYXNpbi01NDA3LmNsZXJrLmFjY291bnRzLmRldiQ"

FAKE_BACKEND = """#!/usr/bin/env python3
import http.server, json, os
KEYS = ("JWT_SECRET", "DATABASE_URL", "REDIS_URL")
env = {k: v for k, v in os.environ.items() if k.startswith(("CLERK_", "RATE_LIMIT_")) or k in KEYS}
with open(os.environ["ENV_DUMP"], "w") as out:
    json.dump(env, out)


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass


http.server.HTTPServer(("127.0.0.1", int(os.environ["PORT"])), Handler).serve_forever()
"""


class E2eStack(unittest.TestCase):
    """scripts/e2e/stack.sh hands the backend its settings (docker and the binary are fakes)."""

    script = REPO / "scripts/e2e/stack.sh"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        tmp = pathlib.Path(self.tmp.name)
        (tmp / "bin").mkdir()
        docker = tmp / "bin" / "docker"
        docker.write_text(
            "#!/usr/bin/env bash\n"
            'echo "$*" >> "$DOCKER_CALLS"\n'
            'case "$*" in *pg_database*) printf "%s" "${DB_EXISTS:-}" ;; esac\n'
        )
        docker.chmod(0o755)
        self.backend = tmp / "taphoa-api"
        self.backend.write_text(FAKE_BACKEND)
        self.backend.chmod(0o755)
        self.dump = tmp / "backend-env.json"
        self.docker_calls = tmp / "docker-calls"
        with http.server.HTTPServer(("127.0.0.1", 0), Handler) as probe:
            self.port = probe.server_address[1]

    def launch(self, **extra):
        """Run `stack.sh up` with a minimal environment; return the finished process."""
        env = {
            "PATH": f"{pathlib.Path(self.tmp.name, 'bin')}{os.pathsep}{os.environ['PATH']}",
            "BACKEND_BIN": str(self.backend),
            "E2E_BACKEND_PORT": str(self.port),
            "E2E_SKIP_MODELS": "1",
            "E2E_STATE_DIR": str(pathlib.Path(self.tmp.name, "state")),
            "ENV_DUMP": str(self.dump),
            "DOCKER_CALLS": str(self.docker_calls),
            **extra,
        }
        # Not run(): the host environment must not leak CLERK_* or JWT_SECRET into the backend.
        stack = lambda action: subprocess.run(  # noqa: E731
            ["bash", str(self.script), action], capture_output=True, text=True, env=env, check=False
        )
        self.addCleanup(stack, "down")
        return stack("up")

    def start(self, **extra):
        """Start the stack and return the environment the backend saw."""
        up = self.launch(**extra)
        self.assertEqual(up.returncode, 0, up.stdout + up.stderr)
        return json.loads(self.dump.read_text())

    def docker(self):
        return self.docker_calls.read_text() if self.docker_calls.exists() else ""

    def test_defaults_to_the_dev_instance_without_a_secret_key(self):
        seen = self.start()
        self.assertEqual(seen["CLERK_PUBLISHABLE_KEY"], DEV_CLERK_KEY)
        self.assertNotIn("CLERK_SECRET_KEY", seen)
        self.assertNotIn("JWT_SECRET", seen)

    def test_empty_values_are_not_handed_to_the_backend(self):
        seen = self.start(CLERK_PUBLISHABLE_KEY="", CLERK_SECRET_KEY="")
        self.assertEqual(seen["CLERK_PUBLISHABLE_KEY"], DEV_CLERK_KEY)
        self.assertNotIn("CLERK_SECRET_KEY", seen)

    def test_passes_the_configured_keys_through(self):
        seen = self.start(CLERK_PUBLISHABLE_KEY="pk_test_other", CLERK_SECRET_KEY="sk_test_unit")
        self.assertEqual(seen["CLERK_PUBLISHABLE_KEY"], "pk_test_other")
        self.assertEqual(seen["CLERK_SECRET_KEY"], "sk_test_unit")

    def test_default_database_and_redis_db_keep_ci_behaviour(self):
        seen = self.start()
        self.assertEqual(seen["DATABASE_URL"], "postgres://taphoa:taphoa@127.0.0.1:55532/taphoa")
        self.assertEqual(seen["REDIS_URL"], "redis://127.0.0.1:56579/0")
        self.assertNotIn("CREATE DATABASE", self.docker())
        self.assertNotIn("pg_database", self.docker())

    def test_creates_a_missing_database(self):
        seen = self.start(E2E_DATABASE_NAME="taphoa_x1_t5a")
        self.assertTrue(seen["DATABASE_URL"].endswith("@127.0.0.1:55532/taphoa_x1_t5a"), seen["DATABASE_URL"])
        calls = self.docker()
        self.assertIn("exec -T postgres psql -U taphoa", calls)
        self.assertIn("pg_database", calls)
        self.assertIn('CREATE DATABASE "taphoa_x1_t5a"', calls)

    def test_keeps_an_existing_database(self):
        self.start(E2E_DATABASE_NAME="taphoa_x1_t5a", DB_EXISTS="1")
        self.assertIn("pg_database", self.docker())
        self.assertNotIn("CREATE DATABASE", self.docker())

    def test_rejects_an_unsafe_database_name(self):
        up = self.launch(E2E_DATABASE_NAME='x"; DROP DATABASE taphoa; --')
        self.assertNotEqual(up.returncode, 0)
        self.assertIn("E2E_DATABASE_NAME", up.stderr)
        self.assertNotIn("CREATE DATABASE", self.docker())

    def test_selects_a_redis_database(self):
        seen = self.start(E2E_REDIS_DB="7")
        self.assertEqual(seen["REDIS_URL"], "redis://127.0.0.1:56579/7")

    def test_rejects_a_non_numeric_redis_database(self):
        up = self.launch(E2E_REDIS_DB="seven")
        self.assertNotEqual(up.returncode, 0)
        self.assertIn("E2E_REDIS_DB", up.stderr)

    def test_recovery_limit_is_gone_but_other_limits_stay(self):
        seen = self.start()
        self.assertNotIn("RATE_LIMIT_RECOVER_PER_10MIN", seen)
        self.assertEqual(seen["RATE_LIMIT_STORE_CREATE_PER_HOUR"], "100000")
        self.assertEqual(seen["RATE_LIMIT_JOIN_PER_HOUR"], "100000")


if __name__ == "__main__":
    unittest.main()
