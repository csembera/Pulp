#!/usr/bin/env bash
# Create a Cognito user via AdminCreateUser. Cognito emails a temporary
# password; the user signs in once and is forced to set a permanent
# password (handled by the frontend's NEW_PASSWORD_REQUIRED challenge).
#
# This is the canonical onboarding path now that selfSignUpEnabled is OFF
# on the user pool. Also flips the matching JOINREQ#{email} row (if any)
# to status=approved for audit parity.
#
# Normally invoked via `make admin-create-user EMAIL=user@example.com`.
set -euo pipefail

: "${EMAIL:?EMAIL env var is required — use 'make admin-create-user EMAIL=user@example.com'}"

OUTPUTS_FILE="${PULP_OUTPUTS_FILE:-cdk/outputs.json}"
TABLE="${PULP_TABLE_NAME:-pulp-table}"

if [ ! -f "$OUTPUTS_FILE" ]; then
  echo "$OUTPUTS_FILE missing — run 'make deploy-backend' first." >&2
  exit 1
fi

USER_POOL_ID="$(jq -r '.PulpDataStack.UserPoolId' "$OUTPUTS_FILE")"
if [ -z "$USER_POOL_ID" ] || [ "$USER_POOL_ID" = "null" ]; then
  echo "UserPoolId not found in $OUTPUTS_FILE." >&2
  exit 1
fi

CREATED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

# AdminCreateUser sends the SUPPRESS option's opposite by default — i.e. the
# user receives an invitation email with their temporary password. We mark
# the email pre-verified so the user isn't prompted to verify it again at
# first sign-in.
aws cognito-idp admin-create-user \
  --user-pool-id "$USER_POOL_ID" \
  --username    "$EMAIL" \
  --user-attributes "Name=email,Value=$EMAIL" "Name=email_verified,Value=true" \
  --desired-delivery-mediums EMAIL \
  > /dev/null

JOINREQ_RESULT="none"
if aws dynamodb update-item \
    --table-name "$TABLE" \
    --key "{\"PK\":{\"S\":\"JOINREQ#$EMAIL\"},\"SK\":{\"S\":\"REQUEST\"}}" \
    --update-expression "SET #s = :approved, approvedAt = :now" \
    --condition-expression "attribute_exists(PK) AND (#s = :pending OR #s = :rejected)" \
    --expression-attribute-names '{"#s":"status"}' \
    --expression-attribute-values "{\":approved\":{\"S\":\"approved\"},\":pending\":{\"S\":\"pending\"},\":rejected\":{\"S\":\"rejected\"},\":now\":{\"S\":\"$CREATED_AT\"}}" \
    >/dev/null 2>&1; then
  JOINREQ_RESULT="updated"
fi

cat <<EOF

Cognito user created for: $EMAIL
Temporary password sent by email — the user will be prompted to set a
permanent password on first sign-in.

EOF

if [ "$JOINREQ_RESULT" = "none" ]; then
  echo "Note: no pending JOINREQ row found for $EMAIL — user created anyway."
  echo
fi
