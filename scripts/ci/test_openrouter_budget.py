"""Tests for OpenRouter budget parsing and status logic."""

import io
import json
import unittest
from contextlib import redirect_stdout
from io import BytesIO
from unittest.mock import patch

from openrouter_budget import classify, fetch_remaining, main, parse_threshold


class OpenRouterBudgetTests(unittest.TestCase):
    def test_unlimited_key_is_not_low(self):
        payload = {"data": {"limit": None, "limit_remaining": None}}
        opener = lambda *_args, **_kwargs: BytesIO(json.dumps(payload).encode())
        self.assertIsNone(fetch_remaining("test-key", opener))
        self.assertEqual(classify(None, 2.0), "recovered")

    def test_malformed_partial_unlimited_response_is_fatal(self):
        payload = {"data": {"limit": None, "limit_remaining": 0}}
        opener = lambda *_args, **_kwargs: BytesIO(json.dumps(payload).encode())
        with self.assertRaisesRegex(RuntimeError, "limit_remaining without a limit"):
            fetch_remaining("test-key", opener)

    def test_malformed_numeric_string_is_fatal(self):
        payload = {"data": {"limit": 5, "limit_remaining": "4"}}
        opener = lambda *_args, **_kwargs: BytesIO(json.dumps(payload).encode())
        with self.assertRaisesRegex(RuntimeError, "non-numeric limit_remaining"):
            fetch_remaining("test-key", opener)

    def test_unlimited_key_prints_notice_without_treating_it_as_low(self):
        output = io.StringIO()
        with patch.dict(
            "os.environ",
            {
                "OPENROUTER_API_KEY": "test-key",
                "OPENROUTER_BUDGET_THRESHOLD": "2",
                "GITHUB_REPOSITORY": "owner/repo",
            },
            clear=True,
        ):
            with (
                patch("openrouter_budget.fetch_remaining", return_value=None),
                patch("openrouter_budget.gh", return_value="[]"),
                redirect_stdout(output),
            ):
                self.assertEqual(main(), 0)
        self.assertIn("::notice::OpenRouter key is unlimited; account credit is not visible through this endpoint.", output.getvalue())

    def test_enough_credit(self):
        self.assertEqual(classify(2.5, 2.0), "recovered")

    def test_low_credit(self):
        self.assertEqual(classify(1.99, 2.0), "low")

    def test_api_error_is_not_low(self):
        with self.assertRaises(RuntimeError):
            fetch_remaining("test-key", lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("offline")))

    def test_threshold_parsing(self):
        self.assertEqual(parse_threshold("2"), 2.0)
        with self.assertRaises(ValueError):
            parse_threshold("not-money")
        with self.assertRaises(ValueError):
            parse_threshold("-1")


if __name__ == "__main__":
    unittest.main()
