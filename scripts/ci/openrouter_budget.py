"""Check the authenticated OpenRouter key's remaining limit and maintain one alert issue."""

import json
import math
import os
import subprocess
import sys
import urllib.error
import urllib.request


def parse_threshold(value):
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("OPENROUTER_BUDGET_THRESHOLD must be a non-negative number") from exc
    if not math.isfinite(result) or result < 0:
        raise ValueError("OPENROUTER_BUDGET_THRESHOLD must be a non-negative number")
    return result


def classify(remaining, threshold):
    return "low" if remaining is not None and remaining < threshold else "recovered"


def fetch_remaining(api_key, opener=urllib.request.urlopen):
    """Read limit_remaining for the current key (GET /api/v1/key per OpenRouter docs)."""
    request = urllib.request.Request(
        "https://openrouter.ai/api/v1/key",
        headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
    )
    try:
        with opener(request, timeout=20) as response:
            payload = json.load(response)
    except (OSError, urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise RuntimeError("OpenRouter key balance request failed") from exc
    try:
        data = payload["data"]
    except (KeyError, TypeError) as exc:
        raise RuntimeError("OpenRouter key response is missing data") from exc
    if not isinstance(data, dict):
        raise RuntimeError("OpenRouter key response data is malformed")
    try:
        limit = data["limit"]
        remaining = data["limit_remaining"]
    except KeyError as exc:
        raise RuntimeError("OpenRouter key response is missing limit or limit_remaining") from exc
    if limit is None:
        if remaining is None:
            return None
        raise RuntimeError("OpenRouter key response has a limit_remaining without a limit")
    if isinstance(limit, bool) or not isinstance(limit, (int, float)):
        raise RuntimeError("OpenRouter key response has non-numeric limit")
    if not math.isfinite(limit) or limit < 0:
        raise RuntimeError("OpenRouter key response has invalid limit")
    if isinstance(remaining, bool) or not isinstance(remaining, (int, float)):
        raise RuntimeError("OpenRouter key response has non-numeric limit_remaining")
    if not math.isfinite(remaining) or remaining < 0:
        raise RuntimeError("OpenRouter key response has invalid limit_remaining")
    return float(remaining)


def gh(*args):
    result = subprocess.run(["gh", *args], capture_output=True, text=True, check=False)
    if result.returncode:
        raise RuntimeError(f"gh {' '.join(args[:2])} failed: {result.stderr.strip()}")
    return result.stdout


def maintain_issue(state, remaining, threshold, repo):
    issues = json.loads(gh("issue", "list", "--repo", repo, "--label", "budget-alert", "--state", "open", "--json", "number", "--limit", "100"))
    if state == "low":
        message = (
            f"OpenRouter key limit remaining: **${remaining:.4f}**; alert threshold: **${threshold:.2f}**. "
            "This key is shared by the assistant and voice features. Check OpenRouter billing/key limits and restore headroom."
        )
        if issues:
            gh("issue", "comment", str(issues[0]["number"]), "--repo", repo, "--body", message)
        else:
            gh("label", "create", "budget-alert", "--repo", repo, "--color", "D93F0B", "--description", "OpenRouter credit is below the alert threshold", "--force")
            gh("issue", "create", "--repo", repo, "--title", "OpenRouter budget is low", "--label", "budget-alert", "--body", message)
    else:
        for issue in issues:
            number = str(issue["number"])
            if remaining is None:
                recovery = "OpenRouter key is unlimited (`limit` and `limit_remaining` are null); account credit is not visible through this endpoint. Closing this alert."
            else:
                recovery = f"OpenRouter key limit recovered: **${remaining:.4f}** remaining (threshold ${threshold:.2f}). Closing this alert."
            gh("issue", "comment", number, "--repo", repo, "--body", recovery)
            gh("issue", "close", number, "--repo", repo)


def main():
    try:
        api_key = os.environ.get("OPENROUTER_API_KEY", "")
        if not api_key:
            raise RuntimeError("OPENROUTER_API_KEY is required")
        threshold = parse_threshold(os.environ.get("OPENROUTER_BUDGET_THRESHOLD", "2"))
        remaining = fetch_remaining(api_key)
        state = classify(remaining, threshold)
        repo = os.environ.get("GITHUB_REPOSITORY", "")
        if not repo:
            raise RuntimeError("GITHUB_REPOSITORY is required")
        maintain_issue(state, remaining, threshold, repo)
        if remaining is None:
            print("::notice::OpenRouter key is unlimited; account credit is not visible through this endpoint.")
        else:
            print(f"{state}: ${remaining:.4f} remaining; threshold ${threshold:.2f}")
    except (RuntimeError, ValueError) as exc:
        print(f"::error::{exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
