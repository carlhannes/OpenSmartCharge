#!/usr/bin/env bash
#
# OpenSmartCharge — declarative installer / upgrader for a dedicated Debian/Ubuntu box.
#
#   Fresh install (bootstrap):
#     curl -fsSL https://raw.githubusercontent.com/carlhannes/OpenSmartCharge/main/setup.sh | bash
#
#   Upgrade / re-run (from anywhere, or inside the clone):
#     ./setup.sh                     # pull latest main, rebuild, restart
#
# This script is CONVERGENT and IDEMPOTENT: every step checks the current state and only acts on
# what is missing or out of date. Re-running it is how you UPGRADE — it fetches the latest code,
# rebuilds, and restarts the service. It NEVER writes osc.yaml and NEVER touches data/ (your SQLite
# DB), so your configuration and history survive every upgrade. A fresh box is configured entirely
# through the web onboarding at http://<box>:8080 after this finishes.
#
# Options / environment:
#   --dry-run            Report what WOULD change, without changing anything.
#   --ref <git-ref>      Branch/tag/SHA to deploy (default: main, or $OSC_REF).
#   -h | --help          Show this help.
#   OSC_HOME=<dir>       Where the repo lives (default: an existing OSC clone in $PWD, else
#                        $HOME/OpenSmartCharge).
#   OSC_USER=<user>      System user the service runs as (default: the invoking user).
#
set -euo pipefail

REPO_URL="https://github.com/carlhannes/OpenSmartCharge.git"

# ---- args ------------------------------------------------------------------------------------
DRY_RUN=0
OSC_REF="${OSC_REF:-main}"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --ref) OSC_REF="${2:?--ref needs a value}"; shift ;;
    -h|--help) sed -n '2,26p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
  shift
done

# ---- pretty logging --------------------------------------------------------------------------
if [ -t 1 ]; then B=$'\033[1m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; R=$'\033[0m'; else B=""; G=""; Y=""; C=""; R=""; fi
info() { printf '%s\n' "${B}${C}==>${R} ${B}$*${R}"; }
ok()   { printf '    %s%s%s\n' "$G" "✓ $*" "$R"; }
todo() { printf '    %s%s%s\n' "$Y" "→ $*" "$R"; }
warn() { printf '    %s%s%s\n' "$Y" "! $*" "$R"; }
# run <shell-command-string> — executes it, or just prints it under --dry-run.
run()  { if [ "$DRY_RUN" -eq 1 ]; then printf '    [dry-run] %s\n' "$*"; else eval "$@"; fi; }

# ---- preflight -------------------------------------------------------------------------------
info "Preflight"
if ! command -v apt-get >/dev/null 2>&1; then
  echo "This installer supports Debian/Ubuntu (apt) only." >&2; exit 1
fi
if [ "$(id -u)" -ne 0 ] && ! command -v sudo >/dev/null 2>&1; then
  echo "Run as root, or install sudo first." >&2; exit 1
fi
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
OSC_USER="${OSC_USER:-$(id -un)}"

# OSC_HOME: reuse an OSC clone we're standing in; otherwise a stable default under $HOME.
if [ -z "${OSC_HOME:-}" ]; then
  if git rev-parse --show-toplevel >/dev/null 2>&1 \
     && grep -q '"opensmartcharge"' "$(git rev-parse --show-toplevel)/package.json" 2>/dev/null; then
    OSC_HOME="$(git rev-parse --show-toplevel)"
  else
    OSC_HOME="$HOME/OpenSmartCharge"
  fi
fi
ok "target dir : $OSC_HOME"
ok "git ref    : $OSC_REF"
ok "run as     : $OSC_USER"
[ "$DRY_RUN" -eq 1 ] && warn "dry-run: no changes will be made"

APT_UPDATED=0
apt_update_once() { if [ "$APT_UPDATED" -eq 0 ]; then run "$SUDO apt-get update -qq"; APT_UPDATED=1; fi; }
ensure_pkg() {
  if dpkg -s "$1" >/dev/null 2>&1; then ok "$1 present"; else todo "install $1"; apt_update_once; run "$SUDO apt-get install -y -qq $1"; fi
}

# ---- Node.js 24 ------------------------------------------------------------------------------
info "Node.js (>= 24)"
node_major=0
command -v node >/dev/null 2>&1 && node_major="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
if [ "$node_major" -ge 24 ] 2>/dev/null; then
  ok "node $(node -v) present"
else
  todo "install Node.js 24.x (NodeSource)"
  run "curl -fsSL https://deb.nodesource.com/setup_24.x | ${SUDO:+$SUDO -E }bash -"
  run "$SUDO apt-get install -y nodejs"
fi

# ---- system packages -------------------------------------------------------------------------
info "System packages"
ensure_pkg git
ensure_pkg build-essential
ensure_pkg mosquitto
ensure_pkg mosquitto-clients

# ---- system services: time sync + MQTT broker -----------------------------------------------
info "System services"
# Clock accuracy matters for 15-minute tariff-slot bucketing.
run "$SUDO systemctl enable --now systemd-timesyncd" || warn "could not enable systemd-timesyncd (is it available?)"
# Anonymous LAN listener on :1883 to match the repo's mosquitto.conf — written once, never clobbered.
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

# ---- repo: clone or fast-forward to the target ref -------------------------------------------
info "Repository"
if [ ! -d "$OSC_HOME/.git" ]; then
  todo "clone $REPO_URL → $OSC_HOME"
  run "git clone '$REPO_URL' '$OSC_HOME'"
  run "git -C '$OSC_HOME' checkout -q '$OSC_REF'"
else
  todo "update $OSC_HOME to '$OSC_REF'"
  run "git -C '$OSC_HOME' fetch --tags --prune origin"
  run "git -C '$OSC_HOME' checkout -q '$OSC_REF'"
  # If the ref is a branch, fast-forward it to the remote tip (a tag/SHA just stays checked out).
  if [ "$DRY_RUN" -eq 0 ] && git -C "$OSC_HOME" show-ref --verify --quiet "refs/heads/$OSC_REF"; then
    run "git -C '$OSC_HOME' merge --ff-only 'origin/$OSC_REF'"
  fi
fi

# ---- build: backend (dist/) + ui2 static SPA (dist/ui) ---------------------------------------
info "Build"
todo "npm ci && npm run build"
run "( cd '$OSC_HOME' && npm ci && npm run build )"

# ---- config & data: never touched ------------------------------------------------------------
info "Config & data (left untouched)"
ok "osc.yaml is never written by this script — configure via the web UI on first boot"
ok "data/ (SQLite DB) is never touched — your config + history survive upgrades"

# ---- systemd service -------------------------------------------------------------------------
info "systemd service (osc)"
NODE_BIN="$(command -v node || echo /usr/bin/node)"
read -r -d '' UNIT <<EOF || true
[Unit]
Description=OpenSmartCharge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$OSC_USER
WorkingDirectory=$OSC_HOME
ExecStart=$NODE_BIN dist/core/lifecycle.js
Restart=on-failure
TimeoutStopSec=20
Environment=NODE_ENV=production

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

# ---- start / restart -------------------------------------------------------------------------
info "Service state"
if systemctl is-enabled --quiet osc 2>/dev/null; then
  todo "restart osc (pick up the new build)"
  run "$SUDO systemctl restart osc"
else
  todo "enable + start osc"
  run "$SUDO systemctl enable --now osc"
fi

# ---- report ----------------------------------------------------------------------------------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"; [ -z "$IP" ] && IP="<box-ip>"
info "Done"
ok  "Web UI / onboarding : http://$IP:8080"
ok  "Point your charger  : ws://$IP:8080/ocpp/<stationId>"
ok  "Logs                : journalctl -u osc -f"
ok  "Re-run this script anytime to upgrade (config + data are preserved)."
