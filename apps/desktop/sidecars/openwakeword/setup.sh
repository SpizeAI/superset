#!/usr/bin/env bash
# Bootstrap the openWakeWord Python sidecar virtual environment.
# Run from the desktop app root: bash sidecars/openwakeword/setup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"

echo "[openwakeword] Setting up virtual environment at $VENV_DIR"

if [ ! -d "$VENV_DIR" ]; then
    python3 -m venv "$VENV_DIR"
fi

source "$VENV_DIR/bin/activate"
pip install --quiet --upgrade pip
pip install --quiet "openwakeword>=0.6.0" "numpy>=1.24.0"

echo "[openwakeword] Setup complete. Sidecar ready."
echo "[openwakeword] Test with: $VENV_DIR/bin/python $SCRIPT_DIR/server.py --help"
