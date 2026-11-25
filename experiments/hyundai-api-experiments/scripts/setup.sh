#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
source scripts/enter.sh
if ! command -v uv >/dev/null 2>&1; then
  if [[ "$(uname -s)" != Linux || "$(uname -m)" != x86_64 ]]; then
    echo 'Install uv for your platform: https://docs.astral.sh/uv/getting-started/installation/'
    exit 2
  fi
  mkdir -p .tools
  curl --fail --location --max-time 120 \
    https://github.com/astral-sh/uv/releases/download/0.12.23/uv-x86_64-unknown-linux-gnu.tar.gz \
    --output .tools/uv.tar.gz
  tar -xzf .tools/uv.tar.gz --strip-components=1 -C .tools uv-x86_64-unknown-linux-gnu/uv
fi
uv python install 3.11
uv sync --locked
