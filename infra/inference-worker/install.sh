#!/usr/bin/env bash
# Copies a prebuilt release binary and template. Does not build, enable or start.
set -euo pipefail
source_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
binary="${1:?Usage: install.sh /absolute/path/to/prebuilt/taphoa-infer}"
[[ -f "$binary" && -x "$binary" ]] || { echo 'A prebuilt executable is required' >&2; exit 1; }
install -d "$HOME/.local/bin" "$HOME/.local/share/taphoa-infer" "$HOME/.config/systemd/user"
install -d -m 700 "$HOME/.config/taphoa-infer" "$HOME/.local/state/taphoa-infer/cuda-cache"
install -m 755 "$binary" "$HOME/.local/bin/.taphoa-infer.new"
mv "$HOME/.local/bin/.taphoa-infer.new" "$HOME/.local/bin/taphoa-infer"
install -m 644 "$source_dir/taphoa-infer.service" "$HOME/.config/systemd/user/taphoa-infer.service"
cat <<'COMMANDS'
Copied binary and unit. No service was enabled or started.
1. Create ~/.config/taphoa-infer/environment (chmod 600); see README.md.
2. systemctl --user daemon-reload
3. systemctl --user start taphoa-infer
4. curl --fail http://127.0.0.1:8090/healthz
Optional, only when you want login-time startup:
   systemctl --user enable taphoa-infer
COMMANDS
