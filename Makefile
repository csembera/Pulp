# Pulp — deploy targets
#
#   make deploy-backend   cdk deploy both stacks; refreshes cdk/outputs.json
#   make deploy-frontend  sync frontend/index.html to S3; invalidate CloudFront /*
#
# All deploy targets read bucket + distribution IDs from cdk/outputs.json, so
# deploy-backend must have been run at least once before the others.

.PHONY: deploy-backend deploy-frontend admin-create-user list-requests reject-request get-topic ses-enable-suppression ses-status

# Inspect a topic's full processing output (summary, keyTerms, quizQuestions)
# so you can diff old vs. new model runs side by side.
#
#   make get-topic EMAIL=user@example.com
#       → list topics for the user
#   make get-topic EMAIL=user@example.com TOPIC_ID=<uuid>
#       → dump the full topic JSON
#   make get-topic EMAIL=user@example.com TOPIC_ID=<uuid> SECTION=quizQuestions
#       → only one of: summary | keyTerms | quizQuestions | meta
#
# Pass any other flag through SCRIPT_ARGS, e.g. SCRIPT_ARGS="--raw".
get-topic:
	@test -n "$(EMAIL)" || { echo "Usage: make get-topic EMAIL=user@example.com [TOPIC_ID=<uuid>] [SECTION=summary|keyTerms|quizQuestions|meta]"; exit 1; }
	@node scripts/get-topic.mjs --email "$(EMAIL)" \
	  $(if $(TOPIC_ID),--topic-id "$(TOPIC_ID)",) \
	  $(if $(SECTION),--section "$(SECTION)",) \
	  $(SCRIPT_ARGS)

# Canonical onboarding path — selfSignUpEnabled is OFF on the user pool.
# Creates the Cognito user via AdminCreateUser; Cognito emails a temporary
# password and the frontend's NEW_PASSWORD_REQUIRED flow lets the user pick
# a permanent one on first sign-in. Also flips the matching JOINREQ row to
# approved (if any).
admin-create-user:
	@test -n "$(EMAIL)" || { echo "Usage: make admin-create-user EMAIL=user@example.com"; exit 1; }
	@EMAIL="$(EMAIL)" bash scripts/admin-create-user.sh

list-requests:
	@STATUS="$(STATUS)" bash scripts/list-requests.sh

reject-request:
	@test -n "$(EMAIL)" || { echo "Usage: make reject-request EMAIL=user@example.com"; exit 1; }
	@EMAIL="$(EMAIL)" bash scripts/reject-request.sh

deploy-backend:
	cd cdk && npx cdk deploy --all --outputs-file outputs.json

deploy-frontend:
	@test -f cdk/outputs.json || { echo "cdk/outputs.json missing — run 'make deploy-backend' first."; exit 1; }
	@BUCKET=$$(jq -r '.PulpAppStack.FrontendBucketName' cdk/outputs.json); \
	DIST=$$(jq -r '.PulpAppStack.DistributionId' cdk/outputs.json); \
	API=$$(jq -r '.PulpAppStack.ApiUrl' cdk/outputs.json); \
	POOL=$$(jq -r '.PulpDataStack.UserPoolId' cdk/outputs.json); \
	CLIENT=$$(jq -r '.PulpDataStack.UserPoolClientId' cdk/outputs.json); \
	REGION=$$(echo "$$API" | sed -E 's|.*execute-api\.([^.]+)\.amazonaws.*|\1|'); \
	for pair in "FrontendBucketName=$$BUCKET" "DistributionId=$$DIST" "ApiUrl=$$API" "UserPoolId=$$POOL" "UserPoolClientId=$$CLIENT"; do \
	  if [ -z "$${pair#*=}" ] || [ "$${pair#*=}" = "null" ]; then \
	    echo "$${pair%%=*} not found in cdk/outputs.json — run 'make deploy-backend' first."; exit 1; \
	  fi; \
	done; \
	TMP=$$(mktemp); \
	trap 'rm -f "$$TMP"' EXIT; \
	echo "→ stamping CONFIG from cdk/outputs.json (api=$$API pool=$$POOL region=$$REGION)"; \
	sed -E \
	  -e "s|(region:[[:space:]]*')[^']*(')|\1$$REGION\2|" \
	  -e "s|(userPoolId:[[:space:]]*')[^']*(')|\1$$POOL\2|" \
	  -e "s|(userPoolClientId:[[:space:]]*')[^']*(')|\1$$CLIENT\2|" \
	  frontend/index.html > "$$TMP"; \
	if ! grep -q "userPoolId:[[:space:]]*'$$POOL'" "$$TMP"; then \
	  echo "CONFIG substitution failed — userPoolId not stamped. Aborting."; exit 1; \
	fi; \
	echo "→ aws s3 cp $$TMP (stamped frontend/index.html) s3://$$BUCKET/index.html"; \
	aws s3 cp "$$TMP" "s3://$$BUCKET/index.html" \
	  --content-type "text/html; charset=utf-8" \
	  --cache-control "no-cache, no-store, must-revalidate"; \
	echo "→ aws s3 cp frontend/og-image.png s3://$$BUCKET/og-image.png"; \
	aws s3 cp frontend/og-image.png "s3://$$BUCKET/og-image.png" \
	  --content-type "image/png" \
	  --cache-control "public, max-age=31536000, immutable"; \
	echo "→ aws cloudfront create-invalidation --distribution-id $$DIST --paths /*"; \
	aws cloudfront create-invalidation --distribution-id "$$DIST" --paths '/*' > /dev/null; \
	echo "Done — invalidation typically propagates within a minute."
