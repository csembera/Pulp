#!/usr/bin/env bash
# List invite requests. Defaults to status=pending; pass STATUS=all (or any
# concrete status: pending | approved | rejected) to widen the filter.
#
# Normally invoked via `make list-requests` or `make list-requests STATUS=all`.
set -euo pipefail

TABLE="${PULP_TABLE_NAME:-pulp-table}"
STATUS="${STATUS:-pending}"

# Scan with a begins_with filter on PK. Fine at beta volume — JOINREQ# rows
# are counted in tens, and we only run this interactively. If the table ever
# grows past a few thousand rows, switch to a GSI on status.
if [ "$STATUS" = "all" ]; then
  FILTER="begins_with(PK, :prefix)"
  VALUES='{":prefix":{"S":"JOINREQ#"}}'
else
  FILTER="begins_with(PK, :prefix) AND #s = :status"
  VALUES="{\":prefix\":{\"S\":\"JOINREQ#\"},\":status\":{\"S\":\"$STATUS\"}}"
fi

aws dynamodb scan \
  --table-name "$TABLE" \
  --filter-expression "$FILTER" \
  --expression-attribute-names '{"#s":"status"}' \
  --expression-attribute-values "$VALUES" \
  --output json \
| python3 -c '
import json, sys

data = json.load(sys.stdin)
rows = []
for item in data.get("Items", []):
    pk = item.get("PK", {}).get("S", "")
    email = pk.removeprefix("JOINREQ#") if pk.startswith("JOINREQ#") else pk
    rows.append((
        email,
        item.get("status",     {}).get("S", "-"),
        item.get("createdAt",  {}).get("S", "-"),
        item.get("approvedAt", {}).get("S", "-"),
    ))

rows.sort(key=lambda r: r[2], reverse=True)

header = "EMAIL".ljust(36) + "  " + "STATUS".ljust(10) + "  " + "CREATED".ljust(20) + "  " + "APPROVED".ljust(20)
rule   = ("-" * 36)       + "  " + ("-" * 10)          + "  " + ("-" * 20)          + "  " + ("-" * 20)
print(header)
print(rule)
if not rows:
    print("(no matching requests)")
for email, status, created, approved in rows:
    print(f"{email:<36}  {status:<10}  {created:<20}  {approved:<20}")
'
