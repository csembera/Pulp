# Pulp — Architecture Write-Up

A serverless, single-region (us-east-1) AWS application that turns user-uploaded PDFs into structured study material (summary, key terms, and a 25-question quiz) using Amazon Bedrock Nova 2 Lite. The full topology is captured in [architecture.drawio](architecture.drawio); this document explains *why* each piece is there, *how* requests flow through the system, and *what* trade-offs were made.

---

## 1. Design principles

The architecture is shaped by four constraints, in priority order:

1. **Cost ceiling.** A hard $5/month AWS Budget governs every choice. Anything that would create idle capacity (containers, fixed-size warm pools, provisioned concurrency, NAT gateways, RDS) is disqualified up front.
2. **Single-developer operability.** No control plane, no clusters, no fleet to patch. Every component is fully managed and emits CloudWatch metrics out of the box.
3. **Brittleness budget.** The pipeline must degrade gracefully. A failed Bedrock call should not lose user uploads; a malformed model response should not silently corrupt user data.
4. **Stateful/stateless separation.** Stateful resources (S3 buckets, DynamoDB, Cognito User Pool, SQS) live in a separate stack with `RemovalPolicy.RETAIN` so they survive any tear-down of the compute stack.

These principles produce a Lambda-only, event-driven design with managed AI inference, a single-table NoSQL store, and CloudFront in front of a static Single-Page Application (SPA) — no servers, no containers, no VPC.

---

## 2. Stack layout

The CDK app is split into two stacks:

### `PulpDataStack` — stateful resources
- `UploadsBucket` (S3) — receives PDFs from the browser via presigned PUT URLs
- `pulp-table` (DynamoDB) — single-table store for users, jobs, topics, attempts, join-requests
- `UserPool` + `UserPoolClient` (Cognito) — issues JWT ID tokens to the SPA. `selfSignUpEnabled: false` — accounts are minted via `AdminCreateUser` only
- `CustomMessageFn` (Lambda) — Cognito `customMessage` trigger that overrides the `AdminCreateUser` invitation email with the Pulp-branded welcome HTML
- `PulpSenderIdentity` (SES) — a verified sender identity; the user pool's `email` is `UserPoolEmail.withSES(...)` so all transactional mail ships through SES, not Cognito's built-in mailer
- `MainQueue` + `Dlq` (SQS) — co-located with the uploads bucket so the S3 → SQS event notification can be wired without a circular cross-stack dependency

### `PulpAppStack` — compute, edge, observability
- `FrontendBucket` + `Distribution` (S3 + CloudFront) — co-located so the OAC bucket policy can reference the distribution ARN without a cycle
- `WebAcl` (WAF v2) — rate-limits `/auth/*`
- `Api` (HTTP API Gateway) with JWT authorizer
- Five request-handler Lambdas (`upload`, `results`, `topics`, `attempts`, `join-request`)
- `ProcessorFn` (SQS-triggered Lambda) — the asynchronous PDF pipeline
- `AlarmsTopic` (SNS) + 5 CloudWatch Alarms + AWS Budget

---

## 3. End-to-end request flow

The numbered arrows in the diagram correspond to the steps below.

### ① Static SPA load (CloudFront → S3)
The user navigates to the CloudFront domain. CloudFront serves `index.html` from `FrontendBucket` over HTTPS. The bucket is fully private; access is granted exclusively via Origin Access Control (OAC). The bucket policy denies any non-TLS request and allows only the CloudFront service principal scoped to the distribution ARN. WAF inspects every viewer request before it reaches the origin.

The SPA itself is a single Preact file (`frontend/index.html`) — no build step, no bundler, no service worker. CloudFront caches it with a short TTL; the deploy script (`make deploy-frontend`) issues a `/*` invalidation after each upload.

### ② Authentication (Browser → Cognito)
The user pool runs with `selfSignUpEnabled: false`, so the public surface is invite-only and gated behind a manual approval step:

1. **Public join-request.** Prospective users submit their email to `POST /auth/join-request` (see § 3.3). This writes a `JOINREQ#<email>` row with `status: pending` and pings the alarms SNS topic so the operator gets an email — no account is created yet.
2. **Admin approval.** The operator runs `make admin-create-user EMAIL=<email>`, which calls Cognito `AdminCreateUser`. The script also flips the matching `JOINREQ` row to `status: approved` for audit parity.
3. **Branded invite email.** Cognito fires the `customMessage` trigger with `triggerSource = CustomMessage_AdminCreateUser`. `CustomMessageFn` replaces the default body and subject with the Pulp-branded welcome HTML (rendered by `welcome-email-template.ts`), embedding a CTA that points at `SIGN_IN_URL`. SES — not Cognito's built-in mailer — actually delivers the message.
4. **First sign-in.** The SPA performs `USER_SRP_AUTH` against the user pool (no client secret — `generateSecret: false`). Because the temporary password forces the `NEW_PASSWORD_REQUIRED` challenge, the app client is also configured for `USER_PASSWORD_AUTH`; `amazon-cognito-identity-js` uses that flow to respond to the challenge and let the user pick a permanent password.

After authentication, Cognito returns an ID token. The SPA stores it in memory and attaches it as `Authorization: Bearer <JWT>` on every subsequent API call.

### ③ Authenticated REST calls (Browser → API Gateway → Lambda)
All routes except `/auth/join-request` go through API Gateway's built-in JWT authorizer, which validates the token's signature, issuer, audience, and expiry against Cognito's JWKS endpoint on every request. There is no custom Lambda authorizer — using the native authorizer gives free request validation and consistent latency.

The five request-handler Lambdas are:

| Route                                              | Lambda          | Auth   | Purpose |
|----------------------------------------------------|-----------------|--------|---------|
| `POST /auth/join-request`                          | `join-request`  | Public | Records a `JOINREQ#<email>` row + publishes to SNS so the operator is notified |
| `POST /uploads`                                    | `upload`        | JWT    | Validates `.pdf` suffix + 50 MB cap + 5-topic-per-user cap; returns presigned PUT URL + jobId, writes pending job row |
| `GET /jobs/{jobId}`                                | `results`       | JWT    | Reads job row; returns `pending` / `processing` / `complete` / `failed` |
| `GET /topics`, `GET /topics/{id}`                  | `topics`        | JWT    | Lists or fetches Topic rows for the caller |
| `PATCH /topics/{id}`                               | `topics`        | JWT    | Renames a topic (1..200 chars), guarded by `attribute_exists` |
| `DELETE /topics/{id}`                              | `topics`        | JWT    | Deletes the Topic row and batch-deletes every `ATTEMPT#<topicId>#*` for the caller |
| `GET/POST /topics/{id}/attempts`                   | `attempts`      | JWT    | Records and lists quiz attempts |

Each is a `NodejsFunction` at 128 MB / 5 s timeout (the processor is the only heavyweight). All have `tracing: ACTIVE` for X-Ray.

### ④ Direct browser → S3 upload
`POST /uploads` does not stream the PDF through Lambda. Instead, the `upload` handler:
1. Validates the `.pdf` suffix and that `fileSize` is a positive integer ≤ 50 MB (rejects with `413` otherwise).
2. Runs a `Select: 'COUNT'` query against `PK = USER#<userId>` / `SK begins_with TOPIC#`. If the caller already owns ≥ 5 completed topics, returns `409` with `code: TOPIC_LIMIT_REACHED` so the SPA can surface a delete-to-make-room prompt.
3. Generates a UUID `jobId`.
4. Returns a presigned `PutObject` URL scoped to `uploads/<userId>/<jobId>.pdf`. The signature includes both `Content-Type: application/pdf` and `Content-Length`, so S3 itself rejects any upload that exceeds the validated size — the cap holds even if the browser is bypassed. URL expires in 15 minutes.
5. Writes a pending job row (`PK=USER#<userId>`, `SK=JOB#<jobId>`, `status=pending`, TTL 90 days) to DynamoDB, guarded by `attribute_not_exists(PK)` as a UUID-collision backstop.

The browser then `PUT`s the PDF body directly to S3. This is critical for the cost ceiling — Lambda payload size and duration would otherwise scale with PDF size; here Lambda only signs the URL. The `UploadsBucket` CORS rule allows `PUT` from `*` because the presigned URL's signature (key + expiry + size + content-type) is the real gate, not the Origin header.

### ⑤ S3 event notification → SQS
Once the PDF lands in `UploadsBucket`, an `ObjectCreated:Put` notification (filtered to `prefix=uploads/`, `suffix=.pdf`) is delivered to `MainQueue`. The S3 service principal is automatically granted `sqs:SendMessage` by CDK's `SqsDestination`.

### ⑥ SQS → Processor Lambda
`MainQueue` is the front of the asynchronous pipeline. Its parameters are tuned to the processor's behavior:

- `visibilityTimeout: 720s` — 2.4× the processor's 300 s Lambda timeout, giving headroom for in-flight retries before SQS redelivers.
- `maxReceiveCount: 3` — four total delivery attempts before the message lands in the DLQ.
- `batchSize: 1` — one PDF per invocation, so a single bad PDF can never poison-pill a batch of others.
- `maxConcurrency: 5` — caps Bedrock fan-out at ~15 in-flight calls (5 invocations × up to 3 Converse calls each), well under the Nova 2 Lite TPS quota.

The processor Lambda itself runs at **1024 MB / 300 s** (the only heavyweight in the system). Memory was raised from 256 MB to give ~4× the CPU on Lambda's linear memory→CPU curve, cutting PDF serialization and JSON parse time enough that the sequential cache-prime + parallel fan-out + retries fit inside the timeout on larger PDFs.

If the processor throws, SQS hides the message for the visibility timeout, then redelivers. After three rejections, SQS routes the message to the DLQ (14-day retention) and the `pulp-dlq-depth` alarm fires.

### ⑦ Processor → Bedrock (two-phase Converse fan-out)
For each SQS message, the processor:

1. **Parses the S3 key** (`uploads/<userId>/<jobId>.pdf`).
2. **Idempotency guard.** Atomically transitions the job row from `pending` → `processing` using a `ConditionExpression`. If the condition fails, the message is a duplicate delivery and is silently discarded — this is the SQS at-least-once contract handled correctly.
3. **Two-phase Bedrock Converse fan-out**, structured to make the prompt cache pay off:
   - **Phase 1 (cache prime):** `summary` runs alone first. The Converse request references the PDF as a `document` source pointing at `s3Location`, which becomes the cacheable prefix. Cache writes cost ~1.25× a normal call but populate the prefix once.
   - **Phase 2 (parallel):** `quiz` and `keyTerms` then fire in parallel via `Promise.allSettled`. Both hit the same cached prefix and pay ~10% of the input cost for the PDF portion.

   Running all three in parallel from the start would defeat caching: each would miss on first write because none of the others has finished yet. The wall-clock cost of the sequential prime is ~1 Bedrock round-trip — comfortably within the 300 s Lambda budget.

   Validators applied to the three responses:
   - `validateQuiz` — exactly 25 questions, 4 options each, valid `correctIndex`
   - `validateKeyTerms` — 10–15 terms, non-empty fields
   - `validateSummary` — 3–5 sections, non-empty title

   All three calls use `us.amazon.nova-2-lite-v1:0` (the cross-region inference profile — the bare model ID does not work for Nova 2). `maxTokens` is capped at 4096, comfortably above the largest expected response.

4. **Two-class retry loop** inside `invokeAndValidate`:
   - **Transport errors** (`ThrottlingException`, 5xx): exponential backoff (`2^attempt × 100ms + jitter`), same prompt, up to 3 retries.
   - **Schema/parse errors**: no backoff — the validator's error message is appended to the prompt as a hint, and the model gets another shot. This is essentially in-context error recovery and dramatically reduces final failure rate without paying retry latency on a network round-trip.

5. **All-or-nothing write.** If any of the three calls is still `rejected` after retries, the job row is marked `failed` with a structured `errorDetails` map and a custom `Pulp/JobsFailed` CloudWatch metric is emitted via Embedded Metric Format (no `PutMetricData` call, no extra IAM); no Topic is created. If all three succeed, the processor:
   - Writes a Topic row (`PK=USER#<userId>`, `SK=TOPIC#<topicId>`) containing the title, summary, quiz, and key terms as JSON-stringified attributes.
   - Conditionally updates the job row to `complete` (guard: must still be `processing`).
   - Deletes the PDF from S3 (the model output is the durable artifact; the source file is no longer needed).

### ⑧–⑨ Result retrieval
The SPA polls `GET /jobs/{jobId}` every few seconds while a job is `pending`/`processing`. Once `complete`, the response includes the `topicId`, and the SPA calls `GET /topics/{topicId}` to load the full Topic. Quiz attempts go through the `attempts` Lambda, which validates submitted answers against the stored `quizQuestions` and writes an Attempt row.

---

## 4. Data model

A single DynamoDB table (`pulp-table`, on-demand billing, TTL on `expiresAt`) holds every entity. Composite keys:

| Entity         | PK                  | SK                    | Notes |
|----------------|---------------------|-----------------------|-------|
| User           | `USER#<userId>`     | `PROFILE`             | Shadow of Cognito sub; created on first authenticated request |
| Job            | `USER#<userId>`     | `JOB#<jobId>`         | `status ∈ {pending, processing, complete, failed}`; TTL 90 days |
| Topic          | `USER#<userId>`     | `TOPIC#<topicId>`     | The processor's output; `topicId === jobId`. Also enforces the 5-topic-per-user upload cap (counted via `Select: 'COUNT'`) |
| Attempt        | `USER#<userId>`     | `ATTEMPT#<topicId>#<ts>` | Quiz attempts, sorted by timestamp via the SK. Batch-deleted in pages of 25 when the parent Topic is deleted |
| Join-request   | `JOINREQ#<email>`   | `REQUEST`             | Public join requests; `status ∈ {pending, approved, rejected}`. Approved by `make admin-create-user` |

All Topic queries are `Query(PK = USER#<userId>, SK begins_with "TOPIC#")` — single-partition, hot-key-free under per-user sharding. There are no GSIs; the access patterns the SPA needs are all owner-scoped.

---

## 5. Security posture

- **TLS everywhere.** Both S3 buckets have a `DenyNonTLS` resource policy. CloudFront is `HTTPS_ONLY`.
- **CloudFront response headers policy.** Every response is stamped at the edge with: `Content-Security-Policy` (`default-src 'self'`; `script-src` + `esm.sh` for ES module imports; `connect-src` scoped to the API Gateway / Cognito / S3 hostnames; `frame-ancestors 'none'`; `object-src 'none'`; `upgrade-insecure-requests`); `Strict-Transport-Security` `max-age=63072000` (2 years); `X-Content-Type-Options: nosniff`; `X-Frame-Options: DENY`; `Referrer-Policy: strict-origin-when-cross-origin`. CSP is the primary defense against XSS escalation — even if user-submitted content or AI-generated output injects script, `connect-src` prevents JWT exfiltration and `script-src` prevents loading attacker-controlled code. `'unsafe-inline'` is required for `script-src` and `style-src` because the SPA is a single HTML file with inline `<script type="module">` and inline `<style>` — moving to hash-based CSP would force a build step the architecture explicitly avoids.
- **Private buckets.** `FrontendBucket` is reachable only via OAC; `UploadsBucket` is reachable only via signed URLs and the processor's IAM role. Both have `BlockPublicAccess.BLOCK_ALL`.
- **WAF rate limit.** `AuthRateLimit` rule blocks any IP exceeding 100 requests per 5-minute window to `/auth/*`, blunting credential stuffing and join-request abuse without affecting legitimate usage.
- **JWT on every request.** API Gateway's native JWT authorizer enforces signature, issuer, audience, and expiry on every call; the only exception is `POST /auth/join-request`, which is intentionally public.
- **No email enumeration.** `join-request` always returns 200, regardless of whether the email is new or already present.
- **Self-signup disabled.** `selfSignUpEnabled: false` on the user pool; the only path to an account is operator-driven `AdminCreateUser`.
- **Cognito auth flows scoped to what's needed.** `userSrp` for normal sign-in plus `userPassword` for the `NEW_PASSWORD_REQUIRED` challenge response on first sign-in. Other flows (`adminUserPassword`, `custom`) remain disabled.
- **Transactional mail via verified SES identity.** Cognito sends through SES (`UserPoolEmail.withSES`) from the verified sender address, not Cognito's built-in 50/day mailer. SES starts in sandbox mode (verified destinations only) until production access is granted.
- **Least-privilege IAM.**
  - `customMessage`: no extra IAM beyond the default Lambda execution role — pure template rendering.
  - `upload`: `s3:PutObject` on `UploadsBucket` only; read+write on the table (read for the topic-count `COUNT` query, write for the pending JOB row).
  - `processor`: `bedrock:InvokeModel` scoped to the Nova 2 Lite inference profile + foundation-model wildcard for the US regions the profile routes to; `s3:GetObject`/`DeleteObject` on `UploadsBucket`; `dynamodb:UpdateItem`/`PutItem`.
  - `results`: read-only on the table.
  - `topics`: read+write on the table (PATCH renames, DELETE batch-deletes attempts).
- **CORS scoped tight.** API Gateway `allowOrigins` is the CloudFront domain only.

---

## 6. Observability and cost guardrails

Five CloudWatch alarms feed the `pulp-alarms` SNS topic, which has a single email subscriber:

| Alarm                    | Threshold                                  | What it catches |
|--------------------------|--------------------------------------------|-----------------|
| `pulp-dlq-depth`         | DLQ messages > 0 for 1 min                 | Any persistent processor failure |
| `pulp-queue-age`         | Oldest message > 300 s                     | Processor lagging or stuck |
| `pulp-processor-errors`  | Lambda Errors > 5 in 5 min                 | Runtime failures (excluding throttles) |
| `pulp-bedrock-throttles` | `InvocationThrottles` > 3 in 5 min         | Model quota exhaustion |
| `pulp-jobs-failed`       | `Pulp/JobsFailed` > 1 in 5 min             | Validator/schema failures — the processor exits cleanly but writes `status: failed`, so Lambda Errors won't catch this. Metric is emitted via EMF from the processor logs, no `PutMetricData` call required |

The SNS topic also accepts publishes from CloudWatch and Budgets via explicit resource-policy grants for those service principals (account-level IAM trust does not cover service principals, which is a common CDK gotcha).

The AWS Budget enforces the cost ceiling: $5/month with two SNS notifications at 80% ($4) and 100% ($5) thresholds. X-Ray active tracing is on for every Lambda, giving end-to-end latency breakdowns at no additional alarm cost.

---

## 7. Operational notes & known sharp edges

- **Bedrock cross-region profile.** Nova 2 Lite cannot be invoked by its bare model ID; the IAM policy and the SDK call must both reference the inference profile (`us.amazon.nova-2-lite-v1:0`). The IAM policy includes `arn:aws:bedrock:us-*::foundation-model/amazon.nova-2-lite-v1:0` because the profile may route to any US region.
- **SES identity verification + sandbox.** `PulpSenderIdentity` is created by CDK, but SES emails the address a confirmation link that *must be clicked manually* before the first send — otherwise Cognito's invitation email fails with `MessageRejected`. SES also starts the account in sandbox mode (only verified destinations can receive mail); production access is required before inviting arbitrary beta users via `make admin-create-user`. `userPool.node.addDependency(senderIdentity)` makes the dependency explicit so Cognito waits on the identity at deploy time.
- **Custom SIGN_IN_URL is hardcoded.** The welcome email's CTA target is set via the `SIGN_IN_URL` env var on `CustomMessageFn`, which defaults to the live CloudFront distribution. Override the env var (or replace the default) once a custom domain like `app.pulp.dev` is in place.
- **Topic deletion is not transactional.** `DELETE /topics/{id}` paginates `ATTEMPT#<topicId>#*`, batch-deletes them in chunks of 25, then deletes the Topic row. If the Lambda dies mid-cleanup, orphan attempts can survive their parent topic; a retry of the same DELETE returns 404 because the Topic row is checked first. Acceptable today (attempts are owner-scoped and harmless), but worth knowing if attempts ever start carrying cost.
- **Visibility timeout vs. concurrency interaction.** Because `visibilityTimeout = 720s` and `maxConcurrency = 5`, a slow burst of 6+ uploads will queue up: the 6th invocation cannot start until the first finishes or its visibility timeout fires. This is a deliberate cap to keep Bedrock spend bounded.
- **Single-region deployment.** us-east-1 only. The frontend bucket and CloudFront WAF *must* be in us-east-1 (CLOUDFRONT scope), so a multi-region story would require duplicating the data stack and a global table — out of scope for the cost ceiling.

---

## 8. Deploy

```sh
make deploy-backend     # cdk deploy --all → writes cdk/outputs.json
make deploy-frontend    # syncs frontend/index.html + Pulp_logo.png + simple-logo.png to S3, invalidates /*
```

`deploy-frontend` reads the bucket name and distribution ID from `cdk/outputs.json`, so the backend must have been deployed at least once before the frontend command will succeed.

**First-deploy gotcha:** before any user can be invited, click the SES verification link sent to the verified sender address (see § 7) — until that's done, `make admin-create-user EMAIL=…` will create the Cognito user but the invitation email will be rejected by SES.

Operator commands (all wrapped in `Makefile` targets):

| Target                                                | Purpose |
|-------------------------------------------------------|---------|
| `make admin-create-user EMAIL=<email>`                | Canonical onboarding: AdminCreateUser + flips matching `JOINREQ` row to approved |
| `make list-requests`                                  | List pending join-requests |
| `make reject-request EMAIL=<email>`                   | Mark a join-request rejected |
| `make get-topic EMAIL=<email> [TOPIC_ID=…]`           | Inspect topic processing output (summary / keyTerms / quizQuestions) for debugging |
