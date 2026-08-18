#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(node -p 'process.versions.node.split(`.`)[0]')" -lt 24 ]]; then
  echo "Node.js 24 or newer is required." >&2
  exit 1
fi
npm ci
npm run build
echo "AutoRouter setup complete. Copy .env.example to .env only if you need overrides."
