"""Tests for the CI helper scripts. Run: python3 -m unittest discover -s scripts/ci -v"""

import http.server
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


FAKE_RAILWAY = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import json, os, pathlib, sys
    state = pathlib.Path(os.environ["FAKE_STATE"])
    calls = int(state.read_text()) if state.exists() else 0
    args = sys.argv[1:]
    if args[:2] == ["deployment", "list"]:
        state.write_text(str(calls + 1))
        statuses = os.environ["FAKE_STATUSES"].split(",")
        rows = [{"id": "old", "status": "SUCCESS"}]
        if calls > 0:
            rows.insert(0, {"id": "new", "status": statuses[min(calls - 1, len(statuses) - 1)]})
        print(json.dumps(rows))
    elif args[:1] == ["logs"]:
        print("fake build log")
    """
)


class RailwayDeploy(unittest.TestCase):
    def deploy(self, statuses, timeout="5"):
        with tempfile.TemporaryDirectory() as tmp:
            fake = pathlib.Path(tmp, "railway")
            fake.write_text(FAKE_RAILWAY)
            fake.chmod(0o755)
            return run(
                ["python3", "-I", str(HERE / "railway_deploy.py"), "backend", "test"],
                env={
                    "PATH": f"{tmp}:{os.environ['PATH']}",
                    "FAKE_STATE": str(pathlib.Path(tmp, "state")),
                    "FAKE_STATUSES": statuses,
                    "RAILWAY_POLL_INTERVAL": "0",
                    "RAILWAY_DEPLOY_TIMEOUT": timeout,
                },
            )

    def test_success_after_building(self):
        out = self.deploy("BUILDING,DEPLOYING,SUCCESS")
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("new SUCCESS", out.stdout)

    def test_skipped_returns_instead_of_hanging(self):
        out = self.deploy("SKIPPED")
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("SKIPPED", out.stdout)

    def test_failed_prints_build_log(self):
        out = self.deploy("BUILDING,FAILED")
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("fake build log", out.stdout)

    def test_times_out_without_terminal_status(self):
        out = self.deploy("BUILDING", timeout="0.2")
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("No terminal deployment status", out.stderr)


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


if __name__ == "__main__":
    unittest.main()
