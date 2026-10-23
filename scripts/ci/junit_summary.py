"""Render a nextest/JUnit report as a Markdown job summary.

Usage: junit_summary.py <title> <junit.xml> [<junit.xml> ...]
Prints Markdown on stdout; callers append it to $GITHUB_STEP_SUMMARY. Never fails the job.
"""

import sys
import xml.etree.ElementTree as ET


def collect(paths):
    total = failed = skipped = 0
    cases = []
    missing = []
    for path in paths:
        try:
            root = ET.parse(path).getroot()
        except (OSError, ET.ParseError):
            missing.append(path)
            continue
        for suite in root.iter("testsuite"):
            for case in suite.iter("testcase"):
                name = f"{case.get('classname') or suite.get('name')}::{case.get('name')}"
                time = float(case.get("time") or 0)
                if case.find("failure") is not None or case.find("error") is not None:
                    status = "failed"
                elif case.find("skipped") is not None:
                    status = "skipped"
                else:
                    status = "passed"
                total += 1
                failed += status == "failed"
                skipped += status == "skipped"
                cases.append((name, status, time))
    return total, failed, skipped, cases, missing


def main(argv):
    if len(argv) < 3:
        print("usage: junit_summary.py <title> <junit.xml>...", file=sys.stderr)
        return 2
    title, paths = argv[1], argv[2:]
    total, failed, skipped, cases, missing = collect(paths)
    print(f"### {title}\n")
    if missing and not cases:
        print(f"_no JUnit report found ({', '.join(missing)})_")
        return 0
    passed = total - failed - skipped
    print("| Total | Passed | Failed | Skipped |\n| --- | --- | --- | --- |")
    print(f"| {total} | {passed} | {failed} | {skipped} |\n")
    failures = [c for c in cases if c[1] == "failed"]
    if failures:
        print("**Failed tests**\n")
        for name, _, _ in failures[:20]:
            print(f"- `{name}`")
        print()
    slowest = sorted(cases, key=lambda c: c[2], reverse=True)[:5]
    if slowest and slowest[0][2] > 0:
        print("<details><summary>Slowest tests</summary>\n")
        for name, _, time in slowest:
            print(f"- `{name}` {time:.2f}s")
        print("\n</details>")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
