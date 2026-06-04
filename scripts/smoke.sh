#!/usr/bin/env bash
# Thin shim — the actual end-to-end smoke logic lives in smoke.mjs so it
# can use the AWS SDK via cdk/node_modules.
set -euo pipefail
exec node "$(dirname "$0")/smoke.mjs" "$@"
