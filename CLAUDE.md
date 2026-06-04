# CLAUDE.md — Secure Serverless PWA

Guidance for building serverless PWAs on AWS (CDK + Lambda + Cognito + DynamoDB + Bedrock).

## Read first

Before non-trivial work, skim:
- [ARCHITECTURE.md](ARCHITECTURE.md) — request flow, stack split rationale
- [SPEC.md](SPEC.md) — product requirements and acceptance criteria

## Design principles (in priority order)

1. **Cost ceiling first.** A hard monthly AWS Budget governs every choice. Reject anything that creates idle capacity (containers, warm pools, provisioned concurrency, NAT gateways, RDS, always-on infra). When proposing a feature, name the recurring cost.
2. **Single-developer operability.** Fully managed services only. No clusters, no fleets to patch, no custom control planes. Every component must emit CloudWatch metrics out of the box.
3. **Brittleness budget.** Fail closed, never lose user data. A failed model call must not lose an upload; a malformed AI response must not corrupt persisted state. Validate every external response before writing it.
4. **Stateful/stateless separation.** Put stateful resources (S3, DynamoDB, Cognito, SQS) in their own stack with `RemovalPolicy.RETAIN`. Compute, edge, and observability go in a separate stack so they can be torn down without data loss.

These constraints produce a Lambda-only, event-driven design. If you find yourself reaching for a container or a VPC, stop and re-examine.

## Architecture defaults

- **Two CDK stacks**, data and app. Cross-stack refs only one direction (app → data). Co-locate resources that would otherwise create a cycle (e.g. SQS queue lives with the bucket whose events feed it; CloudFront lives with the frontend bucket whose OAC grants it access).
- **Direct browser → S3 uploads via presigned PUT URLs.** Never stream user-uploaded bytes through Lambda — it makes Lambda duration and memory scale with payload size. The signed URL's signature is the gate, not Origin headers.
- **S3 → SQS → Lambda for async work.** Use S3 event notifications with prefix/suffix filters into SQS; consume from a Lambda with `batchSize: 1`, `maxConcurrency` set deliberately to cap downstream fan-out, and `visibilityTimeout` ≥ 6× function timeout.
- **DLQ + alarm on every queue.** `maxReceiveCount: 3`, 14-day DLQ retention, CloudWatch alarm on DLQ depth > 0.
- **Single-table DynamoDB.** Composite keys (`PK=USER#<id>`, `SK=<entity>#<id>`). Owner-scoped queries only — no public access patterns. Add GSIs only when an access pattern truly cannot be served by the base table.
- **HTTP API Gateway with native JWT authorizer**, not a custom Lambda authorizer. Cognito JWKS is validated on every request for free.
- **CloudFront + S3 + OAC** for the SPA. Bucket is fully private, `BlockPublicAccess.BLOCK_ALL`, `DenyNonTLS` resource policy, OAC scoped to the distribution ARN.

## Security defaults — non-negotiable

- **TLS everywhere.** `DenyNonTLS` on every bucket. CloudFront `HTTPS_ONLY`. No HTTP listeners.
- **Private buckets.** `BlockPublicAccess.BLOCK_ALL` on every bucket without exception. Access via OAC (frontend) or presigned URLs (uploads) only.
- **WAF rate-limit auth routes.** Rule blocks any IP exceeding ~100 req / 5 min on `/auth/*`. Add WebACL before exposing any new public endpoint.
- **JWT on every route except those intentionally public.** Document any unauthenticated route and explain why in code comments.
- **No email/account enumeration.** Public endpoints (signup, join-request, password reset) must return identical responses regardless of whether the email exists.
- **Least-privilege IAM, scoped by ARN.** Every Lambda gets only the actions it needs on only the resources it touches. No wildcards on resource ARNs except where AWS forces them (e.g. Bedrock cross-region inference profiles). Review IAM diffs in every CDK PR.
- **CORS scoped tight.** API Gateway `allowOrigins` is the CloudFront domain only — never `*`.
- **Secrets in SSM Parameter Store SecureString or Secrets Manager**, never in env vars committed to source. Prefer SSM for cost; use Secrets Manager only when rotation automation is required.
- **Operator-gated signup.** Self-signup is disabled (`selfSignUpEnabled: false`); accounts are created only via `AdminCreateUser` after an operator approves a join-request. No public registration path.
- **Validate every model/AI response against a schema** before persisting. Reject and retry on schema failure; never write partial state.
- **Idempotency guards on all SQS consumers.** Use a DynamoDB conditional update (`pending → processing`) to handle at-least-once delivery; silently discard on condition failure.

## Frontend conventions

- **Single HTML file with Preact**, no bundler, no build step, no service worker unless the PWA install/offline story actively needs one. The deploy is `aws s3 cp` + CloudFront invalidation.
- **Cache headers per asset class.** HTML: `no-cache, no-store, must-revalidate`. Static assets (logos, fonts): `public, max-age=31536000, immutable`.
- **Auth in memory only.** Store the Cognito ID token in a JS variable, attach as `Authorization: Bearer <jwt>`. Don't put JWTs in `localStorage`. Persist only non-sensitive UX state (e.g. an in-flight `jobId`) in `localStorage`.
- **Poll, don't WebSocket**, until the cost/UX math demands otherwise. 3 s polling is fine for jobs that take 15–60 s.
- **Client-side input validation is UX, not security.** Re-validate on the server.

## Lambda handler conventions

- `NodejsFunction`, 128 MB, 5 s timeout for request handlers. Larger only with justification (the async processor is the typical exception).
- `tracing: ACTIVE` on every function for X-Ray.
- Validate inputs at the top of the handler; return a typed error response on failure.
- Treat S3 `s3:TestEvent` and empty `Records` arrays as a normal case — log and return, don't throw (or you'll fill the DLQ on first deploy).
- **Two-class retry inside any AI/external call:**
  - Transport errors (throttling, 5xx): exponential backoff with jitter, same prompt/payload.
  - Schema/validation errors: no backoff; append the validator's error to the prompt as a hint and retry. In-context error recovery is dramatically cheaper than a fresh round-trip.
- Atomic state transitions via DynamoDB `ConditionExpression`. Never read-then-write without a guard.
- All-or-nothing writes. If any sub-task fails, mark the parent row `failed` with structured `errorDetails`; don't write partial children.

## Observability

Every stack ships with at minimum:
- DLQ depth alarm (> 0 for 1 min)
- Queue age alarm (oldest message > 5 min)
- Function error rate alarm (> 5 / 5 min, throttles excluded)
- Per-quota alarms for any rate-limited external API (e.g. model invocation throttles)

All alarms route to a single SNS topic with one email subscriber. Add resource-policy grants for both `cloudwatch.amazonaws.com` and `budgets.amazonaws.com` service principals on the topic — account IAM trust does not cover service principals (common CDK gotcha).

AWS Budget at the cost ceiling, with notifications at 80% and 100%.

## Testing

- Unit-test validators and pure logic with Jest co-located next to the handler (`processor.test.ts`).
- Smoke scripts in [scripts/](scripts/) for manual end-to-end checks against a real deploy. Use these to validate any change that touches the upload → process → topic pipeline.
- Never mock AWS clients in integration tests — hit the real services in a sandbox account. Mocks lie about IAM and quotas.

## Deploy

```sh
make deploy-backend     # cdk deploy --all → writes cdk/outputs.json
make deploy-frontend    # syncs SPA to S3, invalidates CloudFront /*
```

Backend must be deployed at least once before frontend (the frontend script reads bucket name + distribution ID from `cdk/outputs.json`). Operational scripts live in [scripts/](scripts/) and are surfaced via [Makefile](Makefile) targets.

## Common gotchas (don't relearn these)

- **Bedrock cross-region inference profiles** require both the SDK call and the IAM policy to reference the profile ID (e.g. `us.amazon.nova-2-lite-v1:0`), not the bare model ID. The IAM resource ARN must include all regions the profile may route to.
- **Cognito `customMessage` trigger fires for every email type** (sign-in, forgot-password, AdminCreateUser invite, …). Guard on `event.triggerSource === 'CustomMessage_AdminCreateUser'` before overriding the body, or you'll rewrite unrelated emails.
- **CloudFront WAF must be in us-east-1** (`scope: 'CLOUDFRONT'`). Regional WebACLs cannot attach to a distribution.
- **S3 → SQS notifications** trigger a `s3:TestEvent` on first wire-up. Discard messages where `body.Event === 's3:TestEvent'` or `body.Records` is empty.
- **CDK cross-stack exports are one-way and sticky** — once exported, you can't easily remove the export without first removing every consumer. Plan stack boundaries before deploying.
- **DynamoDB `RemovalPolicy.RETAIN` is not the default.** Set it explicitly on every stateful resource.
- **SES account-level suppression is an account setting, not a CDK resource.** Run `make ses-enable-suppression` once after production access is granted so hard bounces and complaints stop counting against the sending reputation. CloudWatch alarms on `Reputation.BounceRate` / `Reputation.ComplaintRate` fire well below AWS's enforcement thresholds (5% / 0.1%).

## What to never do

- Commit AWS credentials, `.env` files, or `cdk.out/` artifacts.
- Use `*` in CORS, IAM resource ARNs, or bucket policies.
- Stream uploads through Lambda.
- Read-then-write to DynamoDB without a `ConditionExpression`.
- Persist unvalidated AI output.
- Skip the WAF rule on a new auth route.
- Add a build pipeline to the frontend without an explicit reason.
- Bypass `make` targets to run raw `cdk deploy` against prod (the targets capture outputs the frontend deploy depends on).

## When working with Claude in this repo

- Before implementing anything non-trivial, state the assumptions and wait for confirmation. Cost-ceiling and single-dev-operability decisions are easy to violate silently.
- Surface IAM widening, new public routes, and new stateful resources in the response — these need explicit human review.
- For UI changes, deploy to a sandbox and verify in a browser before reporting done. Type-checks don't catch UX regressions.
- Prefer extending an existing Lambda handler over adding a new route. Each new route is another IAM policy, another integration, another alarm to think about.
