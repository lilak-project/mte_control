#!/usr/bin/env bash
# Build the runner. No root: the binary needs no privilege, only the udev rule.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cmake -S "$here" -B "$here/build"
cmake --build "$here/build" -j
echo
echo "Built: $here/build/run_mte.exe"
"$here/build/run_mte.exe" --help | head -3
