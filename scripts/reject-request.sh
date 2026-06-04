#!/usr/bin/env bash
# Reject a pending invite request. Flips JOINREQ#{email} from pending to
# rejected and stamps rejectedAt. Only succeeds if the row exists and is
# currently pending — rejecting an already-approved/rejected row is a no-op
# that prints a note rather than a hard failure.
#
# Normally invoked via `make reject-request EMAIL=user@example.com`.
set -euo pipefail

: "${EMAIL:?EMAIL env var is required — use 'make reject-request EMAIL=user@example.com'}"

TABLE="${PULP_TABLE_NAME:-pulp-table}"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

if aws dynamodb update-item \
    --table-name "$TABLE" \
    --key "{\"PK\":{\"S\":\"JOINREQ#$EMAIL\"},\"SK\":{\"S\":\"REQUEST\"}}" \
    --update-expression "SET #s = :rejected, rejectedAt = :now" \
    --condition-expression "attribute_exists(PK) AND #s = :pending" \
    --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values "{\":rejected\":{\"S\":\"rejected\"},\":pending\":{\"S\":\"pending\"},\":now\":{\"S\":\"$NOW\"}}" \
    >/dev/null 2>&1; then
  echo "Rejected: $EMAIL"
else
  echo "No-op: no pending JOINREQ row for $EMAIL (already approved/rejected or never requested)."
  exit 1
fi
