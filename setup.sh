#!/usr/bin/env bash
#
# OpenSmartCharge — declarative installer / upgrader for a dedicated Debian/Ubuntu box.
#
#   Fresh install (bootstrap):
#     curl -fsSL https://raw.githubusercontent.com/carlhannes/OpenSmartCharge/main/setup.sh | bash
#     # works run as root (e.g. piped to `sudo bash`) or as a user with sudo.
#
#   Upgrade / re-run:
#     sudo /opt/opensmartcharge/setup.sh          # pull latest, rebuild, restart
#
# CONVERGENT + IDEMPOTENT: each step checks the current state and only acts on what is missing or out of
# date — re-running is the UPGRADE path. OSC runs as a dedicated, unprivileged `osc` system user (never
# root); root is used only for apt, user creation, and systemd. It NEVER writes osc.yaml and NEVER
# modifies the SQLite DB, so config + history survive every upgrade. A fresh box is configured through
# the web onboarding at http://<box>:8080 once this finishes.
#
# Options / environment:
#   --dry-run          Report what WOULD change, without changing anything.
#   --ref <git-ref>    Branch/tag/SHA to deploy (default: main, or $OSC_REF).
#   -h | --help        Show this help.
#   OSC_HOME=<dir>     Install location (default: /opt/opensmartcharge).
#   OSC_USER=<user>    Service user, created if absent (default: osc).
#
set -euo pipefail

REPO_URL="https://github.com/carlhannes/OpenSmartCharge.git"
NODE_MAJOR=24

# ---- args ------------------------------------------------------------------------------------
DRY_RUN=0
OSC_REF="${OSC_REF:-main}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --ref) OSC_REF="${2:?--ref needs a value}"; shift ;;
    -h|--help) sed -n '2,30p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done
OSC_HOME="${OSC_HOME:-/opt/opensmartcharge}"
OSC_USER="${OSC_USER:-osc}"

# ---- logging ---------------------------------------------------------------------------------
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; Rc=$'\033[31m'; R=$'\033[0m'
else B=""; G=""; Y=""; C=""; Rc=""; R=""; fi
info() { printf '%s\n' "${B}${C}==>${R} ${B}$*${R}"; }
ok()   { printf '    %s%s%s\n' "$G" "✓ $*" "$R"; }
todo() { printf '    %s%s%s\n' "$Y" "→ $*" "$R"; }
warn() { printf '    %s%s%s\n' "$Y" "! $*" "$R"; }
die()  { printf '%s\n' "${Rc}✗ $*${R}" >&2; exit 1; }
# run <shell-string> — privileged/plain command; executes it, or prints it under --dry-run.
run()  { if [ "$DRY_RUN" -eq 1 ]; then printf '    [dry-run] %s\n' "$*"; else eval "$@"; fi; }

# ---- preflight -------------------------------------------------------------------------------
info "Preflight"
command -v apt-get >/dev/null 2>&1 || die "This installer supports Debian/Ubuntu (apt) only."
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  command -v sudo >/dev/null 2>&1 || die "Run as root, or install sudo first."
  SUDO="sudo"
fi

# OS detection (informational; warn-but-continue on non-Debian-family).
OS_PRETTY="unknown"; OS_ID=""; OS_LIKE=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  OS_PRETTY="${PRETTY_NAME:-${NAME:-unknown}}"; OS_ID="${ID:-}"; OS_LIKE="${ID_LIKE:-}"
fi
ok "OS           : $OS_PRETTY"
case " $OS_ID $OS_LIKE " in
  *" debian "*|*" ubuntu "*) : ;;
  *) warn "untested distro — proceeding (assuming apt + systemd)" ;;
esac
ok "install to   : $OSC_HOME"
ok "service user : $OSC_USER"
ok "git ref      : $OSC_REF"
[ "$DRY_RUN" -eq 1 ] && warn "dry-run: no changes will be made"

# run_as_osc <cmd...> — run a command as the unprivileged service user (dry-run aware). No eval:
# arguments are passed through verbatim, so embedded quoting in a `bash -c "…"` payload is safe.
run_as_osc() {
  if [ "$DRY_RUN" -eq 1 ]; then printf '    [dry-run] (as %s) %s\n' "$OSC_USER" "$*"; return 0; fi
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u "$OSC_USER" -- env PATH=/usr/local/bin:/usr/bin:/bin HOME="$OSC_HOME" "$@"
  else
    sudo -u "$OSC_USER" env PATH=/usr/local/bin:/usr/bin:/bin HOME="$OSC_HOME" "$@"
  fi
}

APT_UPDATED=0
apt_update_once() { if [ "$APT_UPDATED" -eq 0 ]; then run "$SUDO apt-get update -qq"; APT_UPDATED=1; fi; }
ensure_pkg() {
  if dpkg -s "$1" >/dev/null 2>&1; then ok "$1 present"
  else todo "install $1"; apt_update_once; run "$SUDO apt-get install -y -qq $1"; fi
}

current_node_major() {
  local v=0
  if command -v node >/dev/null 2>&1; then v="$(node -v 2>/dev/null | sed -n 's/^v\([0-9]\{1,\}\).*/\1/p')"; fi
  printf '%s' "${v:-0}"
}

install_node_tarball() {
  local arch base file ndir
  case "$(uname -m)" in
    x86_64|amd64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    armv7l) arch=armv7l ;;
    *) die "unsupported CPU arch '$(uname -m)' for the Node tarball fallback" ;;
  esac
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  file="$(curl -fsSL "$base/SHASUMS256.txt" | sed -n "s/.*\(node-v${NODE_MAJOR}\.[0-9.]*-linux-${arch}\.tar\.xz\).*/\1/p" | head -1)"
  [ -n "$file" ] || die "could not resolve a Node ${NODE_MAJOR} tarball for $arch"
  ndir="/usr/local/lib/nodejs/${file%.tar.xz}"
  todo "download $file → /usr/local (official Node ${NODE_MAJOR})"
  run "curl -fsSL '$base/$file' -o /tmp/osc-node.tar.xz"
  run "$SUDO mkdir -p /usr/local/lib/nodejs"
  run "$SUDO tar -xJf /tmp/osc-node.tar.xz -C /usr/local/lib/nodejs"
  local b
  for b in node npm npx; do run "$SUDO ln -sf '$ndir/bin/$b' /usr/local/bin/$b"; done
  run "rm -f /tmp/osc-node.tar.xz"
}

# ---- Node.js >= 24 (robust across LTS releases) ----------------------------------------------
info "Node.js (>= $NODE_MAJOR)"
if [ "$(current_node_major)" -ge "$NODE_MAJOR" ] 2>/dev/null; then
  ok "node $(node -v) present"
else
  todo "install Node.js ${NODE_MAJOR}.x via NodeSource"
  run "curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | ${SUDO:+$SUDO -E }bash -" \
    || warn "NodeSource repo setup failed — will try the official tarball"
  run "$SUDO apt-get install -y nodejs" || warn "apt install nodejs failed — will try the official tarball"
  if [ "$DRY_RUN" -eq 0 ] && ! [ "$(current_node_major)" -ge "$NODE_MAJOR" ] 2>/dev/null; then
    warn "NodeSource gave Node major '$(current_node_major)' (< $NODE_MAJOR) — falling back to the official tarball"
    install_node_tarball
    [ "$(current_node_major)" -ge "$NODE_MAJOR" ] 2>/dev/null || die "Node >= $NODE_MAJOR still not available after fallback"
  fi
fi

# ---- system packages -------------------------------------------------------------------------
info "System packages"
ensure_pkg ca-certificates
ensure_pkg git
ensure_pkg build-essential
ensure_pkg xz-utils
ensure_pkg mosquitto
ensure_pkg mosquitto-clients

# ---- service user + install dir --------------------------------------------------------------
info "Service user ($OSC_USER)"
if id "$OSC_USER" >/dev/null 2>&1; then
  ok "user $OSC_USER exists"
else
  todo "create system user $OSC_USER (nologin)"
  run "$SUDO useradd --system --user-group --home-dir '$OSC_HOME' --shell /usr/sbin/nologin '$OSC_USER'"
fi
todo "ensure $OSC_HOME owned by $OSC_USER"
run "$SUDO mkdir -p '$OSC_HOME'"
run "$SUDO chown '$OSC_USER:$OSC_USER' '$OSC_HOME'"

# ---- system services: time sync + MQTT broker -----------------------------------------------
info "System services"
run "$SUDO systemctl enable --now systemd-timesyncd" || warn "could not enable systemd-timesyncd"
if [ ! -f /etc/mosquitto/conf.d/osc.conf ]; then
  todo "write /etc/mosquitto/conf.d/osc.conf (listener 1883, allow_anonymous true)"
  if [ "$DRY_RUN" -eq 0 ]; then
    printf 'listener 1883\nallow_anonymous true\n' | $SUDO tee /etc/mosquitto/conf.d/osc.conf >/dev/null
  fi
  run "$SUDO systemctl restart mosquitto"
else
  ok "/etc/mosquitto/conf.d/osc.conf present"
fi
run "$SUDO systemctl enable --now mosquitto"

# ---- repository (as $OSC_USER) ---------------------------------------------------------------
info "Repository"
if [ -d "$OSC_HOME/.git" ]; then
  todo "update $OSC_HOME → '$OSC_REF'"
  run_as_osc git -C "$OSC_HOME" fetch --tags --prune origin
  run_as_osc git -C "$OSC_HOME" checkout "$OSC_REF"
  # If the ref is a local branch, fast-forward it to the remote tip (a tag/SHA just stays checked out).
  if [ "$DRY_RUN" -eq 0 ] && run_as_osc git -C "$OSC_HOME" show-ref --verify --quiet "refs/heads/$OSC_REF"; then
    run_as_osc git -C "$OSC_HOME" merge --ff-only "origin/$OSC_REF"
  fi
else
  todo "clone $REPO_URL → $OSC_HOME"
  run_as_osc git clone "$REPO_URL" "$OSC_HOME"
  run_as_osc git -C "$OSC_HOME" checkout "$OSC_REF"
fi

# ---- build (as $OSC_USER): backend dist/ + ui2 static SPA dist/ui ----------------------------
info "Build (as $OSC_USER)"
todo "npm ci && npm run build"
run_as_osc bash -c "cd $OSC_HOME && npm ci && npm run build"
# Pre-create the data dir (osc-owned) so the strict-sandbox ReadWritePaths target exists on first boot.
todo "ensure data dir ($OSC_HOME/data)"
run_as_osc mkdir -p "$OSC_HOME/data"

# ---- config & data: never touched ------------------------------------------------------------
info "Config & data (left untouched)"
ok "osc.yaml is never written — configure via the web UI on first boot"
ok "the SQLite DB in data/ is never modified — config + history survive upgrades"

# ---- hardened systemd unit -------------------------------------------------------------------
info "systemd service (osc)"
NODE_BIN="$(command -v node || echo /usr/local/bin/node)"
read -r -d '' UNIT <<EOF || true
[Unit]
Description=OpenSmartCharge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$OSC_USER
Group=$OSC_USER
WorkingDirectory=$OSC_HOME
ExecStart=$NODE_BIN dist/core/lifecycle.js
# Restart on ANY exit (not just failures) so a UI-triggered restart (POST /api/system/restart, a clean
# exit) is brought back too; systemd's default StartLimitBurst still bounds a crash loop.
Restart=always
RestartSec=2
# Give the graceful handler room to drain + checkpoint the WAL (its own watchdog exits at ~8s).
TimeoutStopSec=20
Environment=NODE_ENV=production
# --- sandbox (OSC only writes its SQLite data dir at runtime; networking is unaffected) ---
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$OSC_HOME/data
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
if [ "$($SUDO cat /etc/systemd/system/osc.service 2>/dev/null || true)" != "$(printf '%s' "$UNIT")" ]; then
  todo "write /etc/systemd/system/osc.service"
  if [ "$DRY_RUN" -eq 0 ]; then
    printf '%s' "$UNIT" | $SUDO tee /etc/systemd/system/osc.service >/dev/null
    $SUDO systemctl daemon-reload
  fi
else
  ok "/etc/systemd/system/osc.service up to date"
fi

# ---- start / restart + health check ----------------------------------------------------------
info "Service state"
if systemctl is-enabled --quiet osc 2>/dev/null; then
  todo "restart osc (pick up the new build)"
  run "$SUDO systemctl restart osc"
else
  todo "enable + start osc"
  run "$SUDO systemctl enable --now osc"
fi
if [ "$DRY_RUN" -eq 0 ]; then
  healthy=0
  for _ in $(seq 1 15); do
    if systemctl is-active --quiet osc && curl -fsS -m 3 -o /dev/null http://localhost:8080/api/health 2>/dev/null; then
      healthy=1; break
    fi
    sleep 2
  done
  if [ "$healthy" -eq 1 ]; then ok "osc is up (health 200)"; else warn "osc not healthy yet — check: journalctl -u osc -e"; fi
fi

# ---- report ----------------------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"; [ -n "$IP" ] || IP="<box-ip>"
info "Done"
ok "Runs as   : $OSC_USER (unprivileged, sandboxed systemd unit)"
ok "Web UI    : http://$IP:8080   ← open to onboard"
ok "Charger   : ws://$IP:8080/ocpp/<stationId>"
ok "Logs      : journalctl -u osc -f"
ok "Upgrade   : re-run this script (config + data are preserved)"
