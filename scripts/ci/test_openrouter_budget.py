"""Tests for OpenRouter budget parsing and status logic."""

import unittest

from openrouter_budget import classify, fetch_remaining, parse_threshold


class OpenRouterBudgetTests(unittest.TestCase):
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
