#!/usr/bin/env bash
# seam-acp installer for macOS + Linux.
#
# Thin native bootstrapper: checks/install prerequisites (Node>=22, git, gh,
# GitHub Copilot CLI), then hands off to the shared, tested core
# (scripts/setup.mjs) for config + build, and finally offers 24/7 residency
# (launchd on macOS, systemd --user on Linux).
#
# Usage:
#   ./install.sh                 # interactive
#   ./install.sh --yes           # non-interactive (keep existing/defaults)
#   ./install.sh --residency     # opt into 24/7 residency (non-interactive)
#   ./install.sh --no-residency  # skip residency
#   ./install.sh --enable-linger # (Linux) run before login / after logout
#   ./install.sh --dry-run       # show actions, change nothing
#   ./install.sh --skip-auth     # skip gh/copilot auth checks
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$SCRIPT_DIR"

YES=0; DRY=0; RESIDENCY=auto; ENABLE_LINGER=0; SKIP_AUTH=0
for a in "$@"; do
  case "$a" in
    --yes|-y) YES=1 ;;
    --dry-run) DRY=1 ;;
    --residency) RESIDENCY=yes ;;
    --no-residency) RESIDENCY=no ;;
    --enable-linger) ENABLE_LINGER=1 ;;
    --skip-auth) SKIP_AUTH=1 ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

# --- output (respect NO_COLOR + non-tty) ------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; D=$'\033[2m'; Z=$'\033[0m'
else
  B=; G=; Y=; R=; D=; Z=
fi
step() { printf '\n%s\n' "${B}▶ $*${Z}"; }
ok()   { printf '%s\n' "${G}✓ $*${Z}"; }
warn() { printf '%s\n' "${Y}! $*${Z}"; }
err()  { printf '%s\n' "${R}✗ $*${Z}"; }
die()  { err "$*"; exit 1; }

confirm() { # prompt default(1=yes) -> exit 0 if yes
  local prompt="$1" def="${2:-1}"
  if [ "$YES" = 1 ] || [ ! -t 0 ]; then
    [ "$def" = 1 ]; return
  fi
  local hint ans
  if [ "$def" = 1 ]; then hint="(Y/n)"; else hint="(y/N)"; fi
  printf '%s %s: ' "$prompt" "$hint"
  read -r ans || true
  ans="$(printf '%s' "$ans" | tr '[:upper:]' '[:lower:]')"
  if [ -z "$ans" ]; then [ "$def" = 1 ]; return; fi
  [ "$ans" = "y" ] || [ "$ans" = "yes" ]
}

OS="$(uname -s)"

# --- package manager --------------------------------------------------------
PM=
if [ "$OS" = "Darwin" ]; then
  PM=brew
elif command -v apt-get >/dev/null 2>&1; then
  PM=apt
elif command -v dnf >/dev/null 2>&1; then
  PM=dnf
fi

pm_install() { # pkg...
  case "$PM" in
    brew) brew install "$@" ;;
    apt)  sudo apt-get update -y && sudo apt-get install -y "$@" ;;
    dnf)  sudo dnf install -y "$@" ;;
    *) return 1 ;;
  esac
}

ensure_brew() {
  command -v brew >/dev/null 2>&1 && return 0
  warn "Homebrew not found."
  if confirm "Install Homebrew now?" 1; then
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
    if [ -x /usr/local/bin/brew ]; then eval "$(/usr/local/bin/brew shellenv)"; fi
  fi
  command -v brew >/dev/null 2>&1
}

# --- prerequisites ----------------------------------------------------------
node_major() {
  if command -v node >/dev/null 2>&1; then
    node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
  else
    echo 0
  fi
}

install_via_nvm() {
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ ! -s "$NVM_DIR/nvm.sh" ]; then
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  fi
  # shellcheck disable=SC1091
  . "$NVM_DIR/nvm.sh"
  nvm install 22
  nvm use 22
}

ensure_node() {
  local maj; maj="$(node_major)"
  if [ "${maj:-0}" -ge 22 ] 2>/dev/null; then ok "node $(node -v)"; return; fi
  step "Installing Node >= 22"
  if [ "$DRY" = 1 ]; then warn "dry-run: would install Node >= 22"; return; fi
  if [ "$OS" = "Darwin" ]; then
    ensure_brew || die "Homebrew required to install Node on macOS"
    brew install node
  elif [ "$PM" = "apt" ] || [ "$PM" = "dnf" ]; then
    # Distro Node is usually too old; use nvm (user-level, avoids sudo npm -g).
    install_via_nvm
  else
    die "no supported way to install Node here; install Node >= 22 manually and re-run"
  fi
  hash -r 2>/dev/null || true
  maj="$(node_major)"
  [ "${maj:-0}" -ge 22 ] 2>/dev/null || die "Node still < 22 — open a NEW terminal and re-run (PATH not refreshed in this shell)"
  ok "node $(node -v)"
}

ensure_cmd() { # cmd pkg
  if command -v "$1" >/dev/null 2>&1; then ok "$1 present"; return; fi
  step "Installing $1"
  if [ "$DRY" = 1 ]; then warn "dry-run: would install $2 via ${PM:-<none>}"; return; fi
  if [ -z "$PM" ]; then warn "no supported package manager; install '$1' manually"; return; fi
  pm_install "$2" || { warn "could not auto-install $1 via $PM; install it manually"; return; }
  hash -r 2>/dev/null || true
  command -v "$1" >/dev/null 2>&1 || die "$1 still not found — open a new terminal and re-run"
  ok "$1 installed"
}

ensure_copilot() {
  if command -v copilot >/dev/null 2>&1; then ok "copilot present"; return; fi
  step "Installing GitHub Copilot CLI (npm -g @github/copilot)"
  if [ "$DRY" = 1 ]; then warn "dry-run: would run npm install -g @github/copilot"; return; fi
  npm install -g @github/copilot || warn "npm i -g @github/copilot failed; install manually per https://gh.io/copilot"
  hash -r 2>/dev/null || true
  if command -v copilot >/dev/null 2>&1; then ok "copilot installed"; else warn "copilot not on PATH yet — open a new terminal, then run: copilot login"; fi
}

# --- residency --------------------------------------------------------------
env_value() { # key -> value from .env (best-effort, strips one layer of quotes)
  [ -f "$SCRIPT_DIR/.env" ] || return 0
  grep -E "^$1=" "$SCRIPT_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- \
    | sed -e "s/^['\"]//" -e "s/['\"]$//" || true
}

xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

setup_launchd() {
  local label="com.seam-acp.bot"
  local plist="$HOME/Library/LaunchAgents/$label.plist"
  local node_bin; node_bin="$(command -v node || echo /usr/local/bin/node)"
  local e_run e_dir e_home e_node e_log
  e_run="$(xml_escape "$SCRIPT_DIR/run-bot.sh")"
  e_dir="$(xml_escape "$SCRIPT_DIR")"
  e_home="$(xml_escape "$HOME")"
  e_node="$(xml_escape "$node_bin")"
  e_log="$(xml_escape "$SCRIPT_DIR/data/bot.log")"
  mkdir -p "$HOME/Library/LaunchAgents" "$SCRIPT_DIR/data"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>
    <string>$e_run</string>
  </array>
  <key>WorkingDirectory</key><string>$e_dir</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>$e_home</string>
    <key>NODE_BIN</key><string>$e_node</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$e_log</string>
  <key>StandardErrorPath</key><string>$e_log</string>
</dict></plist>
EOF
  plutil -lint "$plist" >/dev/null || die "generated plist failed plutil -lint"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl enable "gui/$(id -u)/$label" 2>/dev/null || true  # undo a prior --disable BEFORE loading
  launchctl bootstrap "gui/$(id -u)" "$plist" || die "launchctl bootstrap failed (check: launchctl print gui/$(id -u)/$label)"
  ok "launchd agent loaded: $label"
  warn "macOS LaunchAgents run only AFTER you log in (not pre-login/headless)."
}

setup_systemd() {
  if ! command -v systemctl >/dev/null 2>&1 || ! systemctl --user show-environment >/dev/null 2>&1; then
    warn "no functional systemd --user manager; skipping residency. Start manually with ./run-bot.sh or use your init system."
    return 1
  fi
  local unit_dir="$HOME/.config/systemd/user"
  local unit="$unit_dir/seam-acp-bot.service"
  local node_bin; node_bin="$(command -v node || echo /usr/bin/node)"
  mkdir -p "$unit_dir" "$SCRIPT_DIR/data"
  # Escape '%' (a systemd specifier prefix) and quote ExecStart/Environment so
  # paths with spaces don't get split by systemd.
  local sd_dir sd_node
  sd_dir="$(printf '%s' "$SCRIPT_DIR" | sed 's/%/%%/g')"
  sd_node="$(printf '%s' "$node_bin" | sed 's/%/%%/g')"
  cat > "$unit" <<EOF
[Unit]
Description=seam-acp Discord bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$sd_dir
Environment="NODE_BIN=$sd_node"
ExecStart="$sd_dir/run-bot.sh"
Restart=always
RestartSec=5
StandardOutput=append:$sd_dir/data/bot.log
StandardError=append:$sd_dir/data/bot.log

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable seam-acp-bot.service || die "systemctl --user enable failed"
  # restart (not just enable --now) so a re-run actually picks up freshly built code.
  systemctl --user restart seam-acp-bot.service || die "systemctl --user restart failed"
  ok "systemd --user service enabled + (re)started: seam-acp-bot"
  if [ "$ENABLE_LINGER" = 1 ]; then
    if loginctl enable-linger "$(id -un)" 2>/dev/null; then
      ok "linger enabled — runs before login / after logout"
    else
      warn "could not enable linger; run: sudo loginctl enable-linger $(id -un)"
    fi
  else
    warn "runs only while logged in. For pre-login 24/7: sudo loginctl enable-linger $(id -un) (or re-run with --enable-linger)"
  fi
}

want_residency() {
  case "$RESIDENCY" in
    yes) return 0 ;;
    no) return 1 ;;
    *) confirm "Set up 24/7 residency (auto-start at login + restart on crash)?" 0 ;;
  esac
}

readiness() {
  local before="$1"
  local port; port="$(env_value HEALTH_PORT)"; port="${port:-3000}"
  local log="$SCRIPT_DIR/data/bot.log" i=0
  step "Readiness check"
  while [ "$i" -lt 25 ]; do
    if [ -f "$log" ] && tail -n "+$((before + 1))" "$log" 2>/dev/null | grep -q "seam-acp ready"; then
      ok "new process logged 'seam-acp ready'"
      break
    fi
    sleep 1; i=$((i + 1))
  done
  [ "$i" -ge 25 ] && warn "did not observe a fresh 'seam-acp ready' within 25s — check $log"
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS "http://localhost:$port/health" >/dev/null 2>&1; then
      ok "/health responding on port $port"
    else
      warn "/health not responding on port $port yet"
    fi
  fi
  warn "Manual final check: send a message to your bot in Discord to confirm an end-to-end Copilot turn."
}

# --- run --------------------------------------------------------------------
printf '%s\n' "${B}seam-acp installer — ${OS}${Z}"
[ "$DRY" = 1 ] && warn "dry-run: no changes will be made"
[ -z "$PM" ] && warn "no supported package manager detected; prerequisite auto-install is limited"

step "Prerequisites"
# Up-front consent: list what's missing before installing anything.
if [ "$DRY" != 1 ]; then
  need=""
  [ "$(node_major)" -ge 22 ] 2>/dev/null || need="$need node"
  command -v git >/dev/null 2>&1 || need="$need git"
  command -v gh >/dev/null 2>&1 || need="$need gh"
  command -v copilot >/dev/null 2>&1 || need="$need copilot"
  if [ -n "$need" ]; then
    warn "will install:$need"
    warn "(via ${PM:-package manager}; Homebrew/nvm/copilot may run curl|bash or npm -g — see INSTALL.md)"
    if [ "$YES" != 1 ] && [ ! -t 0 ]; then
      die "prerequisites need installing but there is no TTY; re-run with --yes to install non-interactively"
    fi
    confirm "Proceed with installing the above?" 1 || die "aborted by user"
  fi
fi
ensure_node
ensure_cmd git git
ensure_cmd gh gh
ensure_copilot

step "Configuration & build (shared core)"
SETUP_ARGS=""
[ "$YES" = 1 ] && SETUP_ARGS="$SETUP_ARGS --yes"
[ "$DRY" = 1 ] && SETUP_ARGS="$SETUP_ARGS --dry-run"
[ "$SKIP_AUTH" = 1 ] && SETUP_ARGS="$SETUP_ARGS --skip-auth"
# shellcheck disable=SC2086
node "$SCRIPT_DIR/scripts/setup.mjs" $SETUP_ARGS || die "setup.mjs failed"

chmod +x "$SCRIPT_DIR/run-bot.sh" "$SCRIPT_DIR/stop-bot.sh" 2>/dev/null || true

if [ "$DRY" = 1 ]; then
  step "Residency"
  warn "dry-run: would offer launchd/systemd residency here"
  ok "dry-run complete"
  exit 0
fi

if want_residency; then
  step "24/7 residency"
  log_before=0
  [ -f "$SCRIPT_DIR/data/bot.log" ] && log_before="$(wc -l < "$SCRIPT_DIR/data/bot.log" 2>/dev/null || echo 0)"
  if [ "$OS" = "Darwin" ]; then
    setup_launchd && readiness "$log_before"
  else
    setup_systemd && readiness "$log_before"
  fi
else
  step "Residency skipped"
  ok "Start the bot manually with: ${B}./run-bot.sh${Z}  (or re-run with --residency to auto-start)"
fi

step "Done"
ok "seam-acp is set up."
printf '%s\n' "${D}Stop residency: ./stop-bot.sh   Logs: tail -f data/bot.log${Z}"
