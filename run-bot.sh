#!/usr/bin/env bash
# seam-acp unix launcher — env-pinning wrapper for launchd (macOS) / systemd (Linux).
#
# The service manager supervises and restarts (launchd KeepAlive / systemd
# Restart=always), so this wrapper does NOT loop — it only pins a deterministic
# environment (services get a minimal PATH) and exec's node. The app reads .env
# itself (dotenv), incl. COPILOT_CLI_PATH, so we don't load .env here.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$SCRIPT_DIR"

# Copilot CLI auth lives under the user profile; the profile resolves it via $HOME.
export HOME="${HOME:-$(cd ~ && pwd)}"

# Resolve an absolute node (service PATH is minimal). NODE_BIN overrides.
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
if [ -z "${NODE_BIN}" ]; then
  for cand in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "$HOME"/.nvm/versions/node/*/bin/node; do
    if [ -x "$cand" ]; then NODE_BIN="$cand"; break; fi
  done
fi
if [ -z "${NODE_BIN}" ]; then
  echo "run-bot.sh: node not found; set NODE_BIN or install Node >=22" >&2
  exit 127
fi

mkdir -p "$SCRIPT_DIR/data"
exec "$NODE_BIN" "$SCRIPT_DIR/dist/index.js"
