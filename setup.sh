#!/usr/bin/env bash
# Prepare a fresh copy of this tree on a new machine.
#
#   ./setup.sh              check what is needed, build the runner and the UI
#   ./setup.sh --check      check only, build nothing
#
# Everything it does is inside this directory. It never writes outside the tree
# and never asks for root -- the one thing that does is ./install_udev_rule.sh,
# which it tells you about at the end.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
check_only=false
[[ "${1:-}" == "--check" ]] && check_only=true

missing=()
note() { printf '  %-22s %s\n' "$1" "$2"; }

echo "Checking what this needs"
echo

# --- the runner -------------------------------------------------------------
# C, libusb, and cmake. Without these the module cannot be opened at all.
for tool in cmake gcc pkg-config; do
  if command -v "$tool" >/dev/null 2>&1; then
    note "$tool" "$(command -v "$tool")"
  else
    note "$tool" "MISSING"
    missing+=("$tool")
  fi
done

if pkg-config --exists libusb-1.0 2>/dev/null; then
  note "libusb-1.0" "$(pkg-config --modversion libusb-1.0)"
else
  note "libusb-1.0" "MISSING (headers, not just the runtime library)"
  missing+=("libusb-1.0-dev")
fi

# --- the server -------------------------------------------------------------
if command -v python3 >/dev/null 2>&1; then
  note "python3" "$(python3 -V 2>&1)"
  python3 - <<'PY' || missing+=("python3 >= 3.10")
import sys
raise SystemExit(0 if sys.version_info >= (3, 10) else 1)
PY
else
  note "python3" "MISSING"
  missing+=("python3")
fi

# Optional. The runner never flushes stdout, so through a pipe its log would
# only arrive when a run ended; stdbuf line-buffers it. Part of coreutils, so
# its absence is unusual and costs only the live log, never any data.
if command -v stdbuf >/dev/null 2>&1; then
  note "stdbuf" "$(command -v stdbuf)"
else
  note "stdbuf" "missing (optional: the runner's log will only appear at the end of a run)"
fi

# --- the UI -----------------------------------------------------------------
# Only needed to *build* the UI. A tree copied with frontend/dist already in it
# runs without node at all, which is worth knowing on a locked-down host.
if command -v npm >/dev/null 2>&1; then
  note "npm" "$(npm -v)"
else
  note "npm" "missing"
  if [[ -d "$here/frontend/dist" ]]; then
    note "" "-> but frontend/dist is already here, so nothing to build"
  else
    missing+=("npm (or copy a built frontend/dist from another machine)")
  fi
fi

if [[ ${#missing[@]} -gt 0 ]]; then
  echo
  echo "Missing: ${missing[*]}" >&2
  echo "On Debian/Ubuntu:" >&2
  echo "  sudo apt install cmake gcc pkg-config libusb-1.0-0-dev python3 python3-venv nodejs npm" >&2
  exit 1
fi

echo
if $check_only; then
  echo "Everything needed is here. Run ./setup.sh to build."
  exit 0
fi

# --- build ------------------------------------------------------------------
echo "Building the runner"
"$here/runner/build.sh" >/dev/null
echo "  runner/build/run_mte.exe"

echo "Installing the Python dependencies"
python3 -m pip install --quiet --user -r "$here/backend/requirements.txt"
echo "  fastapi, uvicorn"

if command -v npm >/dev/null 2>&1; then
  echo "Building the UI (this takes a minute the first time)"
  (cd "$here/frontend" && npm install --no-audit --no-fund >/dev/null && npm run build >/dev/null)
  echo "  frontend/dist"
fi

if [[ ! -f "$here/mte.conf" ]]; then
  cp "$here/mte.conf.example" "$here/mte.conf"
  echo
  echo "Wrote mte.conf from the example. Everything in it is optional; the one"
  echo "worth setting on a host that has older runs is MTE_ARCHIVE_ROOTS."
fi

echo
echo "Built. Two things left:"
echo
echo "  1. ./install_udev_rule.sh     once, ever. The only command that needs a"
echo "                               password. Without it the module can only be"
echo "                               opened as root."
echo "  2. ./start_server.sh"
