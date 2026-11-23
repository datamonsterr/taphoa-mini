"""Tests for the CI helper scripts. Run: python3 -m unittest discover -s scripts/ci -v"""

import datetime
import http.server
import json
import os
import pathlib
import subprocess
import tempfile
import textwrap
import threading
import time
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


class MaestroLint(unittest.TestCase):
    def lint(self, flows):
        return run(["bash", str(HERE / "lint-maestro.sh"), str(flows)])

    def test_accepts_submit_and_tap(self):
        with tempfile.TemporaryDirectory() as tmp:
            pathlib.Path(tmp, "flow.yaml").write_text("- pressKey: Enter\n- tapOn: 'Title'\n")
            out = self.lint(tmp)
        self.assertEqual(out.returncode, 0, out.stderr)

    def test_rejects_nested_keyboard_command(self):
        with tempfile.TemporaryDirectory() as tmp:
            nested = pathlib.Path(tmp, "subflows")
            nested.mkdir()
            (nested / "flow.yaml").write_text("- hideKeyboard\n")
            out = self.lint(tmp)
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("flow.yaml:1", out.stdout)
        self.assertIn("assert the sheet stays open", out.stderr)

    def test_missing_directory_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = self.lint(pathlib.Path(tmp, "missing"))
        self.assertNotEqual(out.returncode, 0)


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

    def test_budget_exceeded_fails_and_prints_slowest_tests(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp, "junit.xml")
            path.write_text(JUNIT)
            out = run(
                ["python3", "-I", str(HERE / "junit_summary.py"), "--budget-seconds", "1", "Integration", str(path)]
            )
        self.assertEqual(out.returncode, 1)
        self.assertIn("Total test time: 1.20s (budget: 1.00s)", out.stdout)
        self.assertIn("ok_two", out.stdout)
        self.assertIn("Test time budget exceeded", out.stdout)

    def test_slowest_tests_are_limited_to_ten(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp, "junit.xml")
            cases = "".join(f'<testcase name="test_{i}" classname="suite" time="{i}"/>' for i in range(12))
            path.write_text(f'<testsuite name="suite">{cases}</testsuite>')
            out = run(["python3", "-I", str(HERE / "junit_summary.py"), "Integration", str(path)])
        self.assertEqual(out.returncode, 0)
        self.assertIn("test_11", out.stdout)
        self.assertIn("test_2", out.stdout)
        self.assertNotIn("test_1`", out.stdout)


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


class SoftFailureSummary(unittest.TestCase):
    LOG = textwrap.dedent(
        """\
        stdout | tests/latency.test.ts
        hot endpoint latency (n=30):
        /v1/me estimated-server p95=40ms client p95=90ms network baseline p50=50ms budget=200ms
        /v1/sync/changes estimated-server p95=218ms client p95=270ms network baseline p50=52ms budget=200ms
        stdout | tests/recognition-latency.test.ts
        scan latency ms: 1800, 1900, 4100 p90=4100 budget=3000
         FAIL  tests/recognition-latency.test.ts > recognition latency > creates a multi scan
        AssertionError: recognition p90 4100ms must be < 3000ms: expected false to be true
        unrelated noise line
        """
    )

    def summarize(self, log, extra_env=None):
        with tempfile.TemporaryDirectory() as tmp:
            log_path = pathlib.Path(tmp, "soft.log")
            log_path.write_text(log)
            summary = pathlib.Path(tmp, "summary.md")
            out = run(
                ["python3", "-I", str(HERE / "soft_failure_summary.py"), str(log_path)],
                env={"GITHUB_STEP_SUMMARY": str(summary), **(extra_env or {})},
            )
            return out, summary.read_text() if summary.exists() else ""

    def test_writes_red_entry_with_failing_statistics(self):
        out, text = self.summarize(self.LOG)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("### :red_circle: Deploy e2e soft group failed", text)
        self.assertIn("/v1/sync/changes estimated-server p95=218ms", text)
        self.assertIn("scan latency ms: 1800, 1900, 4100 p90=4100", text)
        self.assertIn("must be < 3000ms", text)
        self.assertNotIn("unrelated noise", text)

    def test_prints_to_stdout_without_summary_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            log_path = pathlib.Path(tmp, "soft.log")
            log_path.write_text(self.LOG)
            out = run(
                ["python3", "-I", str(HERE / "soft_failure_summary.py"), str(log_path)],
                env={"GITHUB_STEP_SUMMARY": ""},
            )
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn(":red_circle:", out.stdout)

    def test_missing_or_empty_log_still_reports_red(self):
        out, text = self.summarize("")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn(":red_circle:", text)
        self.assertIn("no latency lines captured", text)
        out = run(
            ["python3", "-I", str(HERE / "soft_failure_summary.py"), "/nonexistent/soft.log"],
            env={"GITHUB_STEP_SUMMARY": ""},
        )
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("no latency lines captured", out.stdout)

    def test_caps_the_number_of_lines(self):
        log = "\n".join(f"/v1/x{i} estimated-server p95={i}ms" for i in range(500))
        _, text = self.summarize(log)
        self.assertLess(len(text.splitlines()), 80)


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

    def _run_soft_split(self, soft_fails, strict=False, extra_env=None, soft_output=""):
        """Run with a pnpm stub that fails the soft run (the one without --exclude) on demand."""
        with tempfile.TemporaryDirectory() as tmp:
            suite = pathlib.Path(tmp, "suite")
            suite.mkdir()
            suite.joinpath("package.json").write_text(json.dumps({"scripts": {"test:e2e": "x"}}))
            bin_dir = pathlib.Path(tmp, "bin")
            bin_dir.mkdir()
            calls = pathlib.Path(tmp, "pnpm-calls")
            stub = bin_dir / "pnpm"
            fail = "1" if soft_fails else "0"
            stub.write_text(
                "#!/usr/bin/env bash\n"
                f'echo "$@" >> {calls}\n'
                f'case " $* " in *" --exclude "*) exit 0;; esac\n'
                f"echo '{soft_output}'\n"
                f"exit {fail}\n"
            )
            stub.chmod(0o755)
            out = run(
                ["bash", str(HERE / "run-e2e.sh")],
                env={
                    "BACKEND_URL": self.url,
                    "E2E_DIR": str(suite),
                    "CLERK_SECRET_KEY": "sk_test_unit_secret",
                    "LATENCY_SAMPLES": "3",
                    "E2E_SOFT_STRICT": "1" if strict else "",
                    "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}",
                    **(extra_env or {}),
                },
            )
            return out, calls.read_text().splitlines()

    def test_soft_specs_run_apart_and_a_failure_only_warns(self):
        out, calls = self._run_soft_split(soft_fails=True)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertEqual(len(calls), 2)
        self.assertIn("--exclude tests/latency.test.ts", calls[0])
        self.assertIn("--exclude tests/assistant-live.test.ts", calls[0])
        self.assertIn("--exclude tests/voice.test.ts", calls[0])
        self.assertNotIn("--exclude tests/voice-contract.test.ts", calls[0])
        self.assertNotIn("--exclude", calls[1])
        self.assertIn("tests/recognition-latency.test.ts", calls[1])
        self.assertIn("tests/voice.test.ts", calls[1])
        self.assertIn("::warning title=Deploy e2e::", out.stdout)

    def test_soft_failure_writes_red_job_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            summary = pathlib.Path(tmp, "summary.md")
            out, _ = self._run_soft_split(
                soft_fails=True,
                extra_env={"GITHUB_STEP_SUMMARY": str(summary)},
                soft_output="scan latency ms: 1, 2 p90=4100 budget=3000",
            )
            text = summary.read_text()
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn(":red_circle:", text)
        self.assertIn("p90=4100", text)

    def test_soft_pass_writes_no_red_summary(self):
        with tempfile.TemporaryDirectory() as tmp:
            summary = pathlib.Path(tmp, "summary.md")
            out, _ = self._run_soft_split(
                soft_fails=False, extra_env={"GITHUB_STEP_SUMMARY": str(summary)}
            )
            self.assertFalse(summary.exists() and ":red_circle:" in summary.read_text())
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)

    def test_soft_failure_blocks_with_e2e_soft_strict(self):
        out, _ = self._run_soft_split(soft_fails=True, strict=True)
        self.assertNotEqual(out.returncode, 0)
        self.assertNotIn("::warning title=Deploy e2e::", out.stdout)

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
        if os.environ.get("FAKE_LONG_HISTORY") == "1":
            rows = [{"id": "skipped-" + str(i), "status": "SKIPPED"} for i in range(12)]
            rows.append({"id": "old", "status": "SUCCESS"})
        else:
            rows = [] if os.environ.get("FAKE_NO_RUNNING") == "1" else [{"id": "old", "status": "SUCCESS"}]
        if calls > 0:
            rows.insert(0, {"id": "new", "status": statuses[min(calls - 1, len(statuses) - 1)]})
        if calls > 2 and os.environ.get("FAKE_REDEPLOY"):
            redeploy_statuses = os.environ["FAKE_REDEPLOY"].split(",")
            rows.insert(0, {"id": "redeployed", "status": redeploy_statuses[min(calls - 3, len(redeploy_statuses) - 1)]})
        limit = int(args[args.index("--limit") + 1])
        print(json.dumps(rows[:limit]))
    elif args[:1] == ["up"]:
        pass
    elif args[:1] == ["redeploy"]:
        if os.environ.get("FAKE_REDEPLOY_EXIT"):
            sys.exit(int(os.environ["FAKE_REDEPLOY_EXIT"]))
        print(json.dumps({"id": "redeployed"}))
    elif args[:1] == ["logs"]:
        print("fake build log")
    """
)


FAKE_RAILWAY_PLAN = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import os, sys
    sys.stdout.write(open(os.environ["FAKE_PLAN"]).read())
    sys.stderr.write(os.environ.get("FAKE_STDERR", ""))
    sys.exit(int(os.environ["FAKE_EXIT"]))
    """
)

PLAN_DRIFT = (
    "Plan: 1 to add, 2 to change, 1 to destroy\n"
    "  + Set variable backend.SAM_DECODERS\n"
    "    └ backend.SAM_DECODERS (unset → «hidden»)\n"
    "  ~ Update variable backend.DECISIONS_MODEL\n"
    "    └ backend.DECISIONS_MODEL («hidden» → «hidden»)\n"
    "  - Delete variable backend.RATE_LIMIT_RECOVER_PER_10MIN\n"
    "  ~ Update backend deploy.restartPolicyType\n"
    "  + Set variable otel-collector.POSTHOG_HOST\n"
    "  - Delete bucket images\n"
)


class RailwayDrift(unittest.TestCase):
    def check(self, plan, code, stderr=""):
        with tempfile.TemporaryDirectory() as tmp:
            fake = pathlib.Path(tmp, "railway")
            fake.write_text(FAKE_RAILWAY_PLAN)
            fake.chmod(0o755)
            pathlib.Path(tmp, "plan.txt").write_text(plan)
            return run(
                ["python3", "-I", str(HERE / "railway_drift.py"), "test"],
                env={
                    "PATH": f"{tmp}:{os.environ['PATH']}",
                    "FAKE_PLAN": str(pathlib.Path(tmp, "plan.txt")),
                    "FAKE_EXIT": str(code),
                    "FAKE_STDERR": stderr,
                },
            )

    def test_parse_keeps_only_backend_variables(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location("railway_drift", HERE / "railway_drift.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(
            module.parse_plan(PLAN_DRIFT),
            [
                ("DECISIONS_MODEL", "change"),
                ("RATE_LIMIT_RECOVER_PER_10MIN", "delete"),
                ("SAM_DECODERS", "set"),
            ],
        )

    def test_drift_fails_listing_names_only(self):
        out = self.check(PLAN_DRIFT, 2)
        self.assertEqual(out.returncode, 1, out.stdout + out.stderr)
        for name in ("SAM_DECODERS", "DECISIONS_MODEL", "RATE_LIMIT_RECOVER_PER_10MIN"):
            self.assertIn(name, out.stdout)
        self.assertNotIn("images", out.stdout)
        self.assertNotIn("hidden", out.stdout)

    def test_other_resource_drift_passes(self):
        out = self.check("Plan: 1 to change\n  - Delete bucket images\n  ~ Update redis-volume config.region\n", 2)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("match", out.stdout)

    def test_clean_plan_passes(self):
        out = self.check("No changes.\n", 0)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)

    def test_plan_failure_is_not_a_pass(self):
        out = self.check("", 1, stderr="Unauthorized")
        self.assertEqual(out.returncode, 2)
        self.assertIn("Unauthorized", out.stdout)


class RailwayDeploy(unittest.TestCase):
    def deploy(self, statuses, timeout="5", **extra_env):
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
                    **extra_env,
                },
            )

    def test_success_after_building(self):
        out = self.deploy("BUILDING,DEPLOYING,SUCCESS")
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("new SUCCESS", out.stdout)

    def test_skipped_with_running_success_does_not_redeploy(self):
        out = self.deploy("SKIPPED", FAKE_REDEPLOY_EXIT="9")
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("SKIPPED", out.stdout)
        self.assertNotIn("redeploy", out.stdout + out.stderr)

    def test_skipped_with_old_success_beyond_ten_does_not_redeploy(self):
        out = self.deploy("SKIPPED", FAKE_LONG_HISTORY="1", FAKE_REDEPLOY_EXIT="9")
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("SKIPPED", out.stdout)
        self.assertNotIn("redeploy", out.stdout + out.stderr)

    def test_skipped_without_running_redeploys_to_success(self):
        out = self.deploy("SKIPPED", FAKE_NO_RUNNING="1", FAKE_REDEPLOY="DEPLOYING,SUCCESS")
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("redeployed SUCCESS", out.stdout)

    def test_redeployed_failure_exits_nonzero(self):
        out = self.deploy("SKIPPED", FAKE_NO_RUNNING="1", FAKE_REDEPLOY="DEPLOYING,FAILED")
        self.assertEqual(out.returncode, 1, out.stdout + out.stderr)

    def test_redeploy_command_failure_exits_nonzero(self):
        out = self.deploy("SKIPPED", FAKE_NO_RUNNING="1", FAKE_REDEPLOY_EXIT="7")
        self.assertEqual(out.returncode, 7, out.stdout + out.stderr)

    def test_failed_prints_build_log(self):
        out = self.deploy("BUILDING,FAILED")
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("fake build log", out.stdout)

    def test_times_out_without_terminal_status(self):
        out = self.deploy("BUILDING", timeout="0.2")
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("No terminal deployment status", out.stderr)


FAKE_RAILWAY_SERVICE = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import json, os, pathlib, sys
    args = sys.argv[1:]
    with open(os.environ["FAKE_LOG"], "a") as log:
        log.write(json.dumps(args) + "\\n")
    assert args[args.index("--service") + 1] == "Postgres"
    assert args[args.index("--environment") + 1] == "test"
    if args[:2] == ["deployment", "list"]:
        state = pathlib.Path(os.environ["FAKE_STATE"])
        calls = int(state.read_text()) if state.exists() else 0
        state.write_text(str(calls + 1))
        rows = json.loads(os.environ["FAKE_DEPLOYMENTS"])
        print(json.dumps(rows[min(calls, len(rows) - 1)]))
    elif args[0] == "redeploy":
        assert "--from-source" in args and "--yes" in args and "--json" in args
        print('{"success": true}')  # Image services do not return a deployment id.
        sys.exit(int(os.environ.get("FAKE_REDEPLOY_EXIT", "0")))
    elif args[0] == "down":
        assert "--yes" in args
        print(os.environ.get("FAKE_DOWN_ERROR", ""), file=sys.stderr)
        sys.exit(int(os.environ.get("FAKE_DOWN_EXIT", "0")))
    else:
        sys.exit(99)
    """
)


class RailwayService(unittest.TestCase):
    def service(self, rows, operation="up", timeout="5", **extra):
        with tempfile.TemporaryDirectory() as tmp:
            fake = pathlib.Path(tmp, "railway")
            fake.write_text(FAKE_RAILWAY_SERVICE)
            fake.chmod(0o755)
            log = pathlib.Path(tmp, "calls")
            out = run(
                ["python3", "-I", str(HERE / "railway_service.py"), operation, "Postgres", "test"],
                env={
                    "PATH": f"{tmp}:{os.environ['PATH']}",
                    "FAKE_STATE": str(pathlib.Path(tmp, "state")),
                    "FAKE_LOG": str(log),
                    "FAKE_DEPLOYMENTS": json.dumps(rows),
                    "RAILWAY_POLL_INTERVAL": "0",
                    "RAILWAY_DEPLOY_TIMEOUT": timeout,
                    **extra,
                },
            )
            calls = [json.loads(line) for line in log.read_text().splitlines()]
            return out, calls

    def test_already_running_does_not_redeploy(self):
        out, calls = self.service([[{"id": "skip", "status": "SKIPPED"},
                                    {"id": "old", "status": "SUCCESS"}]])
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertEqual(len(calls), 1)
        self.assertIn("already running", out.stdout)

    def test_starts_from_source_and_waits_for_newest_success(self):
        old = {"id": "old", "status": "FAILED"}
        out, calls = self.service([[old], [old],
                                  [{"id": "new", "status": "DEPLOYING"}, old],
                                  [{"id": "new", "status": "SUCCESS"}, old]])
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("new SUCCESS", out.stdout)
        self.assertEqual(calls[1], ["redeploy", "--service", "Postgres", "--environment",
                                    "test", "--yes", "--from-source", "--json"])
        self.assertEqual(len(calls), 5)

    def test_failed_or_crashed_start_fails(self):
        for status in ("FAILED", "CRASHED", "REMOVED"):
            with self.subTest(status=status):
                out, _ = self.service([[], [{"id": "new", "status": status}]])
                self.assertEqual(out.returncode, 1, out.stdout + out.stderr)
                self.assertIn(status, out.stderr)

    def test_timeout_ignores_stale_success_for_known_id(self):
        out, _ = self.service([[{"id": "old", "status": "REMOVED"}],
                               [{"id": "old", "status": "SUCCESS"}]], timeout="0.2")
        self.assertEqual(out.returncode, 1, out.stdout + out.stderr)
        self.assertIn("did not reach SUCCESS", out.stderr)

    def test_timeout_without_any_new_deployment(self):
        out, _ = self.service([[]], timeout="0.2")
        self.assertEqual(out.returncode, 1, out.stdout + out.stderr)
        self.assertIn("did not reach SUCCESS", out.stderr)

    def test_redeploy_command_failure_propagates(self):
        out, calls = self.service([[]], FAKE_REDEPLOY_EXIT="7")
        self.assertEqual(out.returncode, 7, out.stdout + out.stderr)
        self.assertEqual(len(calls), 2)

    def test_down_with_nothing_running_succeeds(self):
        out, calls = self.service([], operation="down", FAKE_DOWN_EXIT="1",
                                  FAKE_DOWN_ERROR="No active deployment found")
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertEqual(calls[0][0], "down")
        self.assertIn("No deployment to remove", out.stdout)

    def test_down_failure_propagates(self):
        out, _ = self.service([], operation="down", FAKE_DOWN_EXIT="8",
                              FAKE_DOWN_ERROR="permission denied")
        self.assertEqual(out.returncode, 8)
        self.assertIn("permission denied", out.stderr)


class RailwayServicesReadiness(unittest.TestCase):
    def helper(self, **extra):
        with tempfile.TemporaryDirectory() as tmp:
            fake = pathlib.Path(tmp, "fake-client")
            fake.write_text(textwrap.dedent('''\
                #!/usr/bin/env python3
                import json, os, pathlib, sys
                name = pathlib.Path(sys.argv[0]).name
                args = sys.argv[1:]
                with open(os.environ["FAKE_LOG"], "a") as log:
                    log.write(json.dumps([name, *args]) + "\\n")
                if name == "railway":
                    assert args[:2] == ["variable", "list"]
                    service = args[args.index("--service") + 1]
                    variables = {"RAILWAY_TCP_PROXY_DOMAIN": "fake.invalid",
                                 "RAILWAY_TCP_PROXY_PORT": "1234", "PGUSER": "u",
                                 "PGPASSWORD": "p", "PGDATABASE": "railway"}
                    print(json.dumps(variables if service != "backend" else {}))
                elif name == "psql":
                    if args[-1] == "SELECT 1":
                        sys.exit(int(os.environ.get("FAKE_POSTGRES_FAIL", "0")))
                    print("[]")
                elif name == "redis-cli" and args[-1] == "PING":
                    state = pathlib.Path(os.environ["FAKE_STATE"])
                    calls = int(state.read_text()) if state.exists() else 0
                    state.write_text(str(calls + 1))
                    print("LOADING" if calls < int(os.environ.get("FAKE_REDIS_DELAY", "0")) else "PONG")
                elif name == "test-command":
                    assert os.environ["DATABASE_URL"].split("/")[-1].startswith("it_")
                    assert os.environ["REDIS_URL"].endswith("/15")
                    sys.exit(int(os.environ.get("FAKE_COMMAND_EXIT", "0")))
            '''))
            fake.chmod(0o755)
            for name in ("railway", "psql", "redis-cli", "sleep", "test-command"):
                pathlib.Path(tmp, name).symlink_to(fake)
            log = pathlib.Path(tmp, "calls")
            out = run(
                ["bash", str(HERE / "with-railway-test-services.sh"), "test-command"],
                env={"PATH": f"{tmp}:{os.environ['PATH']}", "FAKE_LOG": str(log),
                     "FAKE_STATE": str(pathlib.Path(tmp, "state")), **extra},
            )
            return out, [json.loads(line) for line in log.read_text().splitlines()]

    def test_retries_until_both_public_proxies_are_ready(self):
        out, calls = self.helper(FAKE_REDIS_DELAY="2")
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        probes = [i for i, call in enumerate(calls) if call[0] == "redis-cli" and call[-1] == "PING"]
        create = next(i for i, call in enumerate(calls) if call[0] == "psql" and call[-1].startswith("CREATE DATABASE"))
        self.assertEqual(len(probes), 3)
        self.assertLess(probes[-1], create)
        self.assertIn(["test-command"], calls)
        self.assertTrue(any(call[-1].startswith("DROP DATABASE IF EXISTS") for call in calls))
        self.assertTrue(any(call[-1] == "FLUSHDB" for call in calls))

    def test_unready_proxy_fails_before_maintenance_or_tests(self):
        for env in ({"FAKE_POSTGRES_FAIL": "1"}, {"FAKE_REDIS_DELAY": "99"}):
            with self.subTest(env=env):
                out, calls = self.helper(**env)
                self.assertEqual(out.returncode, 1, out.stdout + out.stderr)
                self.assertIn("did not accept connections", out.stderr)
                self.assertNotIn(["test-command"], calls)
                queries = [call[-1] for call in calls if call[0] == "psql"]
                self.assertEqual(set(queries), {"SELECT 1"})

    def test_command_failure_survives_database_and_redis_cleanup(self):
        out, calls = self.helper(FAKE_COMMAND_EXIT="7")
        self.assertEqual(out.returncode, 7, out.stdout + out.stderr)
        self.assertTrue(any(call[-1].startswith("DROP DATABASE IF EXISTS") for call in calls))
        self.assertEqual(calls[-1][-1], "FLUSHDB")


class RailwayDown(unittest.TestCase):
    def run_down(self, behavior):
        with tempfile.TemporaryDirectory() as tmp:
            fake = pathlib.Path(tmp, "railway")
            fake.write_text(
                "#!/usr/bin/env python3\n"
                "import os, sys\n"
                "assert sys.argv[1:] == ['down', '--service', 'backend', '--environment', 'test', '--yes']\n"
                "behavior = os.environ['FAKE_BEHAVIOR']\n"
                "print('No deployment found' if behavior == 'empty' else 'failed', file=sys.stderr)\n"
                "sys.exit(0 if behavior == 'success' else 1)\n"
            )
            fake.chmod(0o755)
            return run(
                ["python3", "-I", str(HERE / "railway_down.py"), "backend", "test"],
                env={"PATH": f"{tmp}:{os.environ['PATH']}", "FAKE_BEHAVIOR": behavior},
            )

    def test_removes_deployment(self):
        out = self.run_down("success")
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)

    def test_missing_deployment_is_not_an_error(self):
        out = self.run_down("empty")
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("No deployment to remove", out.stdout)

    def test_other_cli_failure_propagates(self):
        out = self.run_down("failure")
        self.assertEqual(out.returncode, 1)
        self.assertIn("failed", out.stderr)


FAKE_GH = textwrap.dedent(
    """\
    #!/usr/bin/env python3
    import json, os, pathlib, sys
    state = pathlib.Path(os.environ["FAKE_STATE"])
    calls = int(state.read_text()) if state.exists() else 0
    path = sys.argv[2]
    runs = json.loads(os.environ["FAKE_RUNS"])  # {"id": {"status": ..., "test": [job statuses per poll]}}
    if "/jobs" in path:
        run_id = path.split("/runs/")[1].split("/")[0]
        seq = runs[run_id]["test"]
        status = seq[min(calls, len(seq) - 1)]
        print(json.dumps({"jobs": [{"name": "test", "status": status}] if status else []}))
    else:
        if "status=in_progress" in path:
            state.write_text(str(calls + 1))
        wanted = path.split("status=")[1]
        print(json.dumps({"workflow_runs": [{"id": int(k)} for k, v in runs.items() if v["status"] == wanted and v.get("workflow", "deploy.yml") in path]}))
    """
)


class WaitTurn(unittest.TestCase):
    def wait(self, runs, timeout="5", shared=False):
        import json

        with tempfile.TemporaryDirectory() as tmp:
            fake = pathlib.Path(tmp, "gh")
            fake.write_text(FAKE_GH)
            fake.chmod(0o755)
            return run(
                ["python3", "-I", str(HERE / "wait_turn.py"), "deploy.yml"]
                + (["test", "railway-integration.yml:test"] if shared else []),
                env={
                    "PATH": f"{tmp}:{os.environ['PATH']}",
                    "FAKE_STATE": str(pathlib.Path(tmp, "state")),
                    "FAKE_RUNS": json.dumps(runs),
                    "GITHUB_REPOSITORY": "o/r",
                    "GITHUB_RUN_ID": "100",
                    "WAIT_TURN_INTERVAL": "0",
                    "WAIT_TURN_TIMEOUT": timeout,
                },
            )

    def test_waits_for_older_test_job_then_continues(self):
        out = self.wait({"90": {"status": "in_progress", "test": ["in_progress", "in_progress", "completed"]}})
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("Waiting for older runs", out.stdout)

    def test_ignores_newer_runs_and_finished_test_jobs(self):
        out = self.wait(
            {
                "120": {"status": "queued", "test": ["in_progress"]},
                "80": {"status": "in_progress", "test": ["completed"]},
            }
        )
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertNotIn("Waiting", out.stdout)

    def test_older_run_without_jobs_blocks_until_timeout(self):
        out = self.wait({"95": {"status": "queued", "test": [None]}}, timeout="0.2")
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("Still waiting on runs [95]", out.stderr)


    def test_shared_queue_waits_for_older_integration_run(self):
        out = self.wait({"90": {"workflow": "railway-integration.yml", "status": "in_progress",
                                "test": ["in_progress"] * 4 + ["completed"]}}, shared=True)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertIn("Waiting for older runs", out.stdout)

    def test_shared_queue_ignores_newer_integration_run(self):
        out = self.wait({"120": {"workflow": "railway-integration.yml", "status": "in_progress",
                                 "test": ["in_progress"]}}, shared=True)
        self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
        self.assertNotIn("Waiting", out.stdout)

    def test_shared_queue_timeout_does_not_grant_ownership(self):
        out = self.wait({"90": {"workflow": "railway-integration.yml", "status": "in_progress",
                                "test": ["in_progress"]}}, shared=True, timeout="0.2")
        self.assertEqual(out.returncode, 1, out.stdout + out.stderr)
        self.assertIn("Still waiting on runs [90]", out.stderr)


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
                    if not user_auth:
                        return self.reply(401, b'{"errors":[{"code":"unauthorized"}]}')
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
                ("POST", "/v1/segment"),
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
KEYS = ("JWT_SECRET", "DATABASE_URL", "REDIS_URL", "TAPHOA_TEST_NOW")
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

    def test_passes_the_business_clock_override_through(self):
        pinned = "2026-01-15T10:00:00+07:00"
        seen = self.start(TAPHOA_TEST_NOW=pinned)
        self.assertEqual(seen["TAPHOA_TEST_NOW"], pinned)

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


class PinClock(unittest.TestCase):
    script = HERE.parent / "e2e" / "pin-clock.sh"

    def pin(self, *args):
        out = run(["bash", str(self.script), *args])
        return out, dict(line.split("=", 1) for line in out.stdout.splitlines())

    def test_pins_store_time_and_offsets_the_emulator_by_the_same_amount(self):
        for pin in ("10:00", "23:58"):
            before = time.time()
            out, seen = self.pin(pin)
            after = time.time()
            self.assertEqual(out.returncode, 0, out.stderr)
            pinned = datetime.datetime.fromisoformat(seen["TAPHOA_TEST_NOW"])
            self.assertEqual(pinned.utcoffset(), datetime.timedelta(hours=7))
            self.assertEqual(pinned.strftime("%H:%M"), pin)
            offset = int(seen["E2E_CLOCK_OFFSET_SECS"])
            # Real time plus the offset is the pin: the emulator and backend start together.
            self.assertLessEqual(abs(before + offset - pinned.timestamp()), after - before + 2)
            # Same store date as now, never another day.
            today = datetime.datetime.fromtimestamp(before, pinned.tzinfo).date()
            self.assertEqual(pinned.date(), today)

    def test_defaults_to_ten_in_the_morning(self):
        out, seen = self.pin()
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn("T10:00:00+07:00", seen["TAPHOA_TEST_NOW"])

    def test_rejects_a_malformed_pin(self):
        for bad in ("25:00", "10", "10:60", "10:00:00"):
            self.assertNotEqual(self.pin(bad)[0].returncode, 0, bad)


class RailwayTestDatabaseMaintenance(unittest.TestCase):
    def helper(self):
        import importlib.util

        spec = importlib.util.spec_from_file_location("it_database", HERE / "it_database.py")
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_selects_only_old_or_legacy_it_databases(self):
        helper = self.helper()
        names = ["it_100000_123_1_2", "it_121600_123_1_2", "it_121601_123_1_2",
                 "it_123_1_2", "it_local_0_42", "it_9999999999_1_1_1", "production", "other_it_1"]
        self.assertEqual(helper.stale_databases(names, now=143201, max_age_hours=6),
                         ["it_100000_123_1_2", "it_121600_123_1_2", "it_123_1_2", "it_local_0_42"])

    def test_size_warning_lists_largest_only_above_limit(self):
        helper = self.helper()
        sizes = [("small", 10), ("it_large", 90), ("medium", 40)]
        self.assertIsNone(helper.size_warning(sizes, 140))
        warning = helper.size_warning(sizes, 139)
        self.assertIn("::warning::", warning)
        self.assertIn("140", warning)
        self.assertLess(warning.index("it_large"), warning.index("medium"))
        self.assertLess(warning.index("medium"), warning.index("small"))

    def test_maintenance_drops_only_stale_then_checks_sizes(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = pathlib.Path(tmp, "psql")
            log = pathlib.Path(tmp, "queries")
            fake.write_text(textwrap.dedent('''\
                #!/usr/bin/env python3
                import json, os, sys
                sql = sys.argv[-1]
                with open(os.environ["QUERY_LOG"], "a") as f:
                    f.write(sql + "\\n")
                if "pg_database_size" in sql:
                    print(json.dumps([["railway", 200], ["it_recent", 100]]))
                elif "json_agg" in sql:
                    print(json.dumps(["railway", "it_legacy", "it_9999999999_1_1_1", 'it_bad"name']))
            '''))
            fake.chmod(0o755)
            out = run(["python3", "-I", str(HERE / "it_database.py")], env={
                "PATH": tmp + os.pathsep + os.environ["PATH"], "DATABASE_URL": "postgres://unused",
                "QUERY_LOG": str(log), "IT_DB_SIZE_LIMIT_BYTES": "250", "IT_DB_MAX_AGE_HOURS": "6",
            })
            queries = log.read_text()
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertIn('DROP DATABASE "it_legacy" WITH (FORCE)', queries)
        self.assertIn('DROP DATABASE "it_bad""name" WITH (FORCE)', queries)
        self.assertNotIn('DROP DATABASE "railway"', queries)
        self.assertNotIn('DROP DATABASE "it_9999999999_1_1_1"', queries)
        self.assertLess(queries.index("DROP DATABASE"), queries.index("pg_database_size"))
        self.assertIn("Dropped stale integration database 'it_legacy'", out.stdout)
        self.assertIn("::warning::Postgres databases total 300 bytes", out.stdout)

    def test_psql_failure_shows_stderr_without_password(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = pathlib.Path(tmp, "psql")
            fake.write_text(textwrap.dedent('''\
                #!/usr/bin/env python3
                import sys
                sys.stderr.write("psql: FATAL: the database system is down\\n")
                sys.exit(2)
            '''))
            fake.chmod(0o755)
            out = run(["python3", "-I", str(HERE / "it_database.py")], env={
                "PATH": tmp + os.pathsep + os.environ["PATH"],
                "DATABASE_URL": "postgres://admin:s3cretpw@db.example:5432/railway",
            })
        self.assertEqual(out.returncode, 1)
        self.assertIn("the database system is down", out.stderr)
        self.assertNotIn("s3cretpw", out.stdout + out.stderr)


if __name__ == "__main__":
    unittest.main()
