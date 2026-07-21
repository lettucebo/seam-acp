#!/usr/bin/env bash
# Stop the seam-acp unix residency cleanly.
#
#   ./stop-bot.sh            # stop now (autostart stays enabled)
#   ./stop-bot.sh --disable  # stop AND disable autostart at login
#
# SAFETY: we NEVER kill by the process name "copilot". The copilot CLI children
# exit when the bot's stdin closes; we additionally clean up only descendant PIDs
# of THIS bot's node (captured before the kill), never by name — a name-based kill
# could terminate an unrelated (or the currently-running) Copilot CLI.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
LABEL="com.seam-acp.bot"      # launchd (macOS)
SERVICE="seam-acp-bot"         # systemd --user (Linux)
DISABLE=0
[ "${1:-}" = "--disable" ] && DISABLE=1

OS="$(uname -s)"

# Capture our node + its descendants BEFORE stopping (detached copilot children
# get reparented once node dies and could no longer be found by lineage).
node_pids="$(pgrep -f "$SCRIPT_DIR/dist/index.js" 2>/dev/null || true)"
descendants=""
for npid in $node_pids; do
  descendants="$descendants $(pgrep -P "$npid" 2>/dev/null || true)"
done

if [ "$OS" = "Darwin" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null \
    || launchctl unload "$HOME/Library/LaunchAgents/$LABEL.plist" 2>/dev/null \
    || true
  echo "launchd: booted out $LABEL (if loaded)"
  if [ "$DISABLE" -eq 1 ]; then
    launchctl disable "gui/$(id -u)/$LABEL" 2>/dev/null || true
    echo "launchd: disabled autostart for $LABEL"
  fi
else
  systemctl --user stop "$SERVICE.service" 2>/dev/null || true
  echo "systemd: stopped $SERVICE (autostart still enabled unless --disable)"
  if [ "$DISABLE" -eq 1 ]; then
    systemctl --user disable "$SERVICE.service" 2>/dev/null || true
    echo "systemd: disabled autostart for $SERVICE"
  fi
fi

# Best-effort cleanup of any surviving PIDs we captured (by PID, never by name).
sleep 1
for pid in $node_pids $descendants; do
  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
  fi
done
echo "done."
