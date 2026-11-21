#!/usr/bin/env python3
"""Remove the latest successful Railway deployment for a service/environment."""

import subprocess
import sys


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: railway_down.py <service> <environment>", file=sys.stderr)
        return 2

    service, environment = sys.argv[1:]
    command = ["railway", "down", "--service", service, "--environment", environment, "--yes"]
    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.stdout:
        print(result.stdout, end="")
    if result.returncode == 0:
        if result.stderr:
            print(result.stderr, end="", file=sys.stderr)
        return 0

    output = f"{result.stdout}\n{result.stderr}".lower()
    if "no deployment" in output or "no active deployment" in output:
        print(f"No deployment to remove for {service} in {environment}; continuing.")
        return 0

    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)
    return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
