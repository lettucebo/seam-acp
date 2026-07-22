#!/usr/bin/env bash
# seam-acp one-line network bootstrap (macOS + Linux).
#
# Run WITHOUT cloning first. Use the command-substitution form so stdin stays a
# TTY (interactive prompts work); a plain `curl | bash` pipe cannot prompt.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/lettucebo/seam-acp/main/get.sh)"
#
# With flags (note the `_` — it fills $0 so flags land in $@):
#   bash -c "$(curl -fsSL .../get.sh)" _ --yes --no-residency
#
# Env overrides:
#   SEAM_ACP_DIR   target directory (default: ~/seam-acp)
#   SEAM_ACP_REF   branch or tag to clone (default: main)
#
# It ensures git, clones the repo, then hands off to the repo's install.sh
# (which installs prerequisites, writes .env, builds, and offers residency).
set -euo pipefail

REPO_URL="https://github.com/lettucebo/seam-acp.git"
REF="${SEAM_ACP_REF:-main}"

# --- output (respect NO_COLOR + non-tty) ------------------------------------
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
  B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; Z=$'\033[0m'
else
  B=; G=; Y=; R=; Z=
fi
say()  { printf '%s\n' "$*"; }
step() { printf '\n%s\n' "${B}> $*${Z}"; }
ok()   { printf '%s\n' "${G}OK $*${Z}"; }
warn() { printf '%s\n' "${Y}!  $*${Z}"; }
die()  { printf '%s\n' "${R}X  $*${Z}" >&2; exit 1; }

# --- parse flags: --yes for our own prompts; everything is forwarded to install.sh
YES=0
for a in "$@"; do
  case "$a" in
    --yes|-y) YES=1 ;;
    --help|-h)
      sed -n '2,20p' "$0" 2>/dev/null | sed 's/^# \{0,1\}//' || true
      say "Usage: bash -c \"\$(curl -fsSL .../get.sh)\" _ [--yes] [install.sh flags]"
      exit 0 ;;
  esac
done

step "seam-acp bootstrap"

# --- interactivity guard ----------------------------------------------------
# The installer needs to prompt (token, etc.). If we can't reach a TTY and the
# user didn't pass --yes, stop with the correct command instead of failing later.
if [ "$YES" != 1 ] && { [ ! -t 0 ] || [ ! -t 1 ]; } && [ ! -r /dev/tty ]; then
  die "no interactive terminal detected. Use the command-substitution form (not a pipe):
  bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/lettucebo/seam-acp/main/get.sh)\"
Or run non-interactively with a prepared .env and pass --yes."
fi

# Read a line from the controlling terminal even when stdin is the script text.
prompt() { # varname promptText default
  local __var="$1" __msg="$2" __def="${3:-}" __ans=""
  if [ "$YES" = 1 ] || { [ ! -t 0 ] && [ ! -r /dev/tty ]; }; then
    printf -v "$__var" '%s' "$__def"; return
  fi
  if [ -r /dev/tty ]; then
    printf '%s%s: ' "$__msg" "${__def:+ [$__def]}" > /dev/tty
    IFS= read -r __ans < /dev/tty || true
  else
    printf '%s%s: ' "$__msg" "${__def:+ [$__def]}"
    IFS= read -r __ans || true
  fi
  [ -z "$__ans" ] && __ans="$__def"
  printf -v "$__var" '%s' "$__ans"
}

# --- ensure git -------------------------------------------------------------
have_git() { command -v git >/dev/null 2>&1 && git --version >/dev/null 2>&1; }

ensure_git() {
  have_git && { ok "git $(git --version | awk '{print $3}')"; return; }
  step "Installing git"
  local os; os="$(uname -s)"
  if [ "$os" = "Darwin" ]; then
    if command -v brew >/dev/null 2>&1; then
      brew install git
    else
      warn "Homebrew not found."
      if [ "$YES" = 1 ] || { local a; prompt a "Install Homebrew now? (needed to install git) (Y/n)" "Y"; [ "$(printf '%s' "$a" | tr '[:upper:]' '[:lower:]')" != "n" ]; }; then
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"
        [ -x /usr/local/bin/brew ] && eval "$(/usr/local/bin/brew shellenv)"
        brew install git
      fi
    fi
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -y && sudo apt-get install -y git
  elif command -v dnf >/dev/null 2>&1; then
    sudo dnf install -y git
  else
    die "could not find a package manager to install git. Install git manually and re-run."
  fi
  hash -r 2>/dev/null || true
  have_git || die "git still not available after install. Open a new terminal and re-run."
  ok "git installed"
}

# --- target directory -------------------------------------------------------
# shellcheck disable=SC2088  # "~/"* is a case pattern (literal match), not an expansion
expand_tilde() { case "$1" in "~") printf '%s' "$HOME";; "~/"*) printf '%s' "$HOME/${1#\~/}";; *) printf '%s' "$1";; esac; }

TARGET=""
if [ -n "${SEAM_ACP_DIR:-}" ]; then
  TARGET="$(expand_tilde "$SEAM_ACP_DIR")"
else
  prompt TARGET "Where should seam-acp be installed?" "$HOME/seam-acp"
  TARGET="$(expand_tilde "$TARGET")"
fi
[ -n "$TARGET" ] || die "no target directory given"

ensure_git

# --- clone / reuse ----------------------------------------------------------
clone_repo() {
  step "Cloning seam-acp ($REF) -> $TARGET"
  git clone --branch "$REF" -- "$REPO_URL" "$TARGET" \
    || die "git clone failed (ref '$REF', target '$TARGET')"
  ok "cloned"
}

if [ -e "$TARGET" ]; then
  if [ -f "$TARGET/scripts/setup.mjs" ] && [ -d "$TARGET/.git" ] \
     && git -C "$TARGET" remote get-url origin 2>/dev/null | grep -qi "seam-acp"; then
    ok "using existing checkout at $TARGET"
    warn "not auto-updating; run 'git -C \"$TARGET\" pull' yourself to update."
  elif [ -d "$TARGET" ] && [ -z "$(ls -A "$TARGET" 2>/dev/null)" ]; then
    clone_repo
  else
    die "target '$TARGET' exists and is not a seam-acp checkout. Choose another with SEAM_ACP_DIR."
  fi
else
  clone_repo
fi

[ -f "$TARGET/install.sh" ] || die "install.sh missing in $TARGET (incomplete checkout?)"

# --- hand off to the repo installer (preserving original args) --------------
step "Handing off to installer"
chmod +x "$TARGET/install.sh" 2>/dev/null || true
exec bash "$TARGET/install.sh" "$@"
