#!/usr/bin/env bash
set -euo pipefail
base_url="http://${HOST:-127.0.0.1}:${PORT:-20200}"
curl --fail --silent --show-error "${base_url}/health"
echo
