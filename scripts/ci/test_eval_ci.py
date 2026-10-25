"""Tests for the assistant evaluation CI helpers (epic X7): eval-ci.sh and eval_guard.py.
Run: python3 -m unittest discover -s scripts/ci -v"""

import importlib.util
import json
import os
import pathlib
import stat
import subprocess
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
EVAL_CI = HERE / "eval-ci.sh"


def load_guard():
    spec = importlib.util.spec_from_file_location("eval_guard", HERE / "eval_guard.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def run(cmd, env=None):
    full_env = {**os.environ, **(env or {})}
    return subprocess.run(cmd, capture_output=True, text=True, env=full_env, check=False)


class Mode(unittest.TestCase):
    def mode(self, assistant_present, **env):
        with tempfile.TemporaryDirectory() as tmp:
            assistant = pathlib.Path(tmp, "assistant")
            if assistant_present:
                assistant.mkdir()
            out = pathlib.Path(tmp, "output")
            result = run(
                ["bash", str(EVAL_CI), "mode"],
                env={"EVAL_ASSISTANT_DIR": str(assistant), "GITHUB_OUTPUT": str(out), **env},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            return out.read_text().strip()

    def test_live_needs_assistant_and_secrets(self):
        self.assertEqual(self.mode(True, EVAL_HAVE_SECRETS="true", EVAL_FORK_PR=""), "mode=live")

    def test_stub_without_the_assistant(self):
        self.assertEqual(self.mode(False, EVAL_HAVE_SECRETS="true"), "mode=stub")

    def test_stub_for_fork_pull_requests(self):
        self.assertEqual(self.mode(True, EVAL_HAVE_SECRETS="true", EVAL_FORK_PR="true"), "mode=stub")

    def test_stub_without_secrets(self):
        self.assertEqual(self.mode(True, EVAL_HAVE_SECRETS="false"), "mode=stub")
        self.assertEqual(self.mode(True, EVAL_HAVE_SECRETS=""), "mode=stub")


class Summary(unittest.TestCase):
    def summary(self, files, **env):
        with tempfile.TemporaryDirectory() as tmp:
            results = pathlib.Path(tmp, "results")
            results.mkdir()
            for name, text in files.items():
                results.joinpath(name).write_text(text, encoding="utf-8")
            out = pathlib.Path(tmp, "summary.md")
            result = run(["bash", str(EVAL_CI), "summary", str(results)], env={"GITHUB_STEP_SUMMARY": str(out), **env})
            self.assertEqual(result.returncode, 0, result.stderr)
            return out.read_bytes().decode("utf-8")

    def test_appends_every_markdown_file(self):
        text = self.summary({"a.md": "# one\n", "b.md": "# two\n", "skip.txt": "not-markdown"})
        self.assertIn("# one", text)
        self.assertIn("# two", text)
        self.assertNotIn("not-markdown", text)

    def test_missing_directory_is_not_fatal(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = pathlib.Path(tmp, "summary.md")
            result = run(["bash", str(EVAL_CI), "summary", tmp + "/absent"], env={"GITHUB_STEP_SUMMARY": str(out)})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("No results file", out.read_text())

    def test_oversized_file_is_cut_on_a_character_boundary(self):
        text = self.summary({"big.md": "ạ" * 600000})  # 3 bytes each, 1.8 MB
        self.assertLess(len(text.encode("utf-8")), 1024 * 1024)
        self.assertIn("Cut at the step summary limit", text)


class StackCommands(unittest.TestCase):
    def test_up_requires_the_openrouter_key(self):
        env = {k: v for k, v in os.environ.items() if k != "OPENROUTER_API_KEY"}
        result = subprocess.run(["bash", str(EVAL_CI), "up"], capture_output=True, text=True, env=env, check=False)
        self.assertEqual(result.returncode, 1)
        self.assertIn("OPENROUTER_API_KEY", result.stderr)

    def test_up_requires_the_binaries(self):
        result = run(
            ["bash", str(EVAL_CI), "up"],
            env={"OPENROUTER_API_KEY": "x", "BACKEND_BIN": "/nonexistent/api", "SEED_BIN": "/nonexistent/seed"},
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("binary not executable", result.stderr)

    def test_unknown_command_is_a_usage_error(self):
        self.assertEqual(run(["bash", str(EVAL_CI), "bogus"]).returncode, 2)


def run_record(run_id, title="eval full", started="2026-10-25T00:31:00Z", status="completed", conclusion="success"):
    return {
        "id": run_id,
        "display_title": title,
        "run_started_at": started,
        "created_at": started,
        "status": status,
        "conclusion": conclusion,
    }


class Guard(unittest.TestCase):
    guard = load_guard()
    TODAY = "2026-10-25"

    def jobs(self, conclusion="success"):
        return lambda run_id: [{"name": "guard", "conclusion": "success"}, {"name": "run", "conclusion": conclusion}]

    def decide(self, runs, *, event="workflow_dispatch", set_name="full", compare="", force=False, assistant=True, run_id=100, jobs=None):
        return self.guard.decide(
            event, set_name, compare, force, assistant, lambda: runs, jobs or self.jobs(), self.TODAY, run_id
        )

    def test_scheduled_run_waits_for_the_assistant(self):
        run, reason = self.decide([], event="schedule", assistant=False)
        self.assertFalse(run)
        self.assertIn("not on main", reason)

    def test_manual_run_without_the_assistant_still_runs(self):
        self.assertTrue(self.decide([], assistant=False)[0])

    def test_first_full_run_of_the_day_runs(self):
        self.assertTrue(self.decide([])[0])

    def test_earlier_successful_full_run_blocks(self):
        run, reason = self.decide([run_record(90)])
        self.assertFalse(run)
        self.assertIn("90", reason)

    def test_running_full_run_blocks(self):
        run, reason = self.decide([run_record(90, status="in_progress", conclusion=None)])
        self.assertFalse(run)
        self.assertIn("still running", reason)

    def test_failed_or_cancelled_full_run_does_not_block(self):
        for conclusion in ("failure", "cancelled"):
            self.assertTrue(self.decide([run_record(90, conclusion=conclusion)])[0], conclusion)

    def test_run_whose_work_job_was_skipped_does_not_block(self):
        self.assertTrue(self.decide([run_record(90)], jobs=self.jobs("skipped"))[0])

    def test_run_whose_work_job_failed_does_not_block(self):
        self.assertTrue(self.decide([run_record(90)], jobs=self.jobs("failure"))[0])

    def test_other_titles_days_and_later_runs_do_not_block(self):
        runs = [
            run_record(90, title="eval smoke"),
            run_record(91, title="eval compare"),
            run_record(92, started="2026-10-24T23:59:00Z"),
            run_record(101),
        ]
        self.assertTrue(self.decide(runs)[0])

    def test_run_started_just_after_midnight_utc_counts_as_today(self):
        self.assertFalse(self.decide([run_record(90, started="2026-10-25T00:00:01Z")])[0])

    def test_force_bypasses_the_guard(self):
        run, _ = self.decide([run_record(90)], force=True)
        self.assertTrue(run)

    def test_smoke_and_compare_are_not_limited(self):
        self.assertTrue(self.decide([run_record(90)], set_name="smoke")[0])
        self.assertTrue(self.decide([run_record(90)], compare="a,b")[0])

    def test_gh_output_parses_compact_and_pretty_json(self):
        with tempfile.TemporaryDirectory() as tmp:
            fake = pathlib.Path(tmp, "gh")
            payload = json.dumps(run_record(7)) + "\n" + json.dumps(run_record(8), indent=2) + "\n"
            fake.write_text(f"#!/bin/sh\ncat <<'EOF'\n{payload}EOF\n")
            fake.chmod(fake.stat().st_mode | stat.S_IXUSR)
            old = os.environ["PATH"]
            os.environ["PATH"] = tmp + os.pathsep + old
            try:
                runs = self.guard.gh_api("o/r", "actions/workflows/eval.yml/runs")
            finally:
                os.environ["PATH"] = old
        self.assertEqual([r["id"] for r in runs], [7, 8])


if __name__ == "__main__":
    unittest.main()
