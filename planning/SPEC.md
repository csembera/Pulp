# Pulp — Technical Specification

**Version:** 2.0
**Date:** April 2026
**Status:** Draft for review
**Authors:** Canyon
**Classification:** Confidential

---

## Table of contents

1. [Executive summary](#1-executive-summary)
2. [Product overview](#2-product-overview)
3. [Tech stack](#3-tech-stack)
4. [Architecture](#4-architecture)
5. [AWS infrastructure](#5-aws-infrastructure)
6. [API reference](#6-api-reference)
7. [CDK stack outline](#7-cdk-stack-outline)
8. [Security](#8-security)
9. [Observability](#9-observability)
10. [Deployment](#10-deployment)
11. [Remaining open questions](#11-remaining-open-questions)
- [Appendix A: Directory structure](#appendix-a-directory-structure)
- [Appendix B: Environment variables](#appendix-b-environment-variables)

---

## 1. Executive summary

Pulp is a serverless web application for students and professionals who want to extract structured learning materials from a PDF without manual effort. A user uploads a PDF, and Pulp generates three artefacts: a structured summary organised into logical sections, a set of multiple-choice quiz questions at a length the user selects, and a list of key terms scaled to the document's length. All artefacts are stored permanently in the user's learning library. Quiz attempts — including score, timestamp, and quiz length — are recorded so users can track progress over time.

Access is invite-only. A single shared invite code, stored in Secrets Manager, is required at registration alongside an email and password. There is no public sign-up.

The application is built to stay within AWS free tier limits for all services except Bedrock, which has no free tier. At low invite-only volume the Bedrock cost is expected to remain under a few US dollars per month.

> **Design principle:** Optimise for developer simplicity and operational zero-maintenance. No build pipeline, no server management, no background workers beyond Lambda. The entire frontend is a single HTML file. The entire backend is a CDK stack.

---

## 2. Product overview

### 2.1 User journey

| Screen | What the user sees | Actions available |
|---|---|---|
| Sign-up / login | Email, password, invite code fields | Register, log in |
| Learning library | Grid of topic tiles, one per uploaded PDF | Click tile, upload new PDF |
| Topic detail | Title of the document | Open summary, open key terms, take quiz |
| Summary view | Logical sections with prose under each | Read, return to topic |
| Key terms view | Term and definition pairs | Read, return to topic |
| Quiz config | Short / Medium / Long selector | Start quiz |
| Quiz in progress | Question and four labelled options A–D | Select answer, next question |
| Quiz results | Score (e.g. 8/15), percentage, attempt history | Retake, return to topic |
| Processing screen | Spinner and animated progress steps | Wait (no interactions) |

### 2.2 Invite code flow

Sign-up requires a single-use invite code tied to the requesting email. The flow:

1. A prospective user submits `{ email }` to `POST /auth/join-request` from the main page. The request is recorded in DynamoDB as a `JOINREQ#{email}` item with `status: pending`.
2. The owner reviews pending requests and approves one by generating a random 32-byte invite code. The code is stored as an SSM Parameter Store `SecureString` at `/pulp/invite-codes/{codeHash}` with value `{ email, status: unused, createdAt }`. The plaintext code is emailed to the requester out of band.
3. The user submits `{ email, password, inviteCode }` via the Cognito `preSignUp` trigger. The trigger hashes the code (SHA-256), looks up the parameter, and verifies `email` matches and `status === unused`. On success it marks the parameter `used` with `consumedAt` and allows Cognito to create the user. Any mismatch throws, which Cognito surfaces as a sign-up failure — no user record is created.

Codes are **single-use and bound to one email**. A leaked code cannot onboard anyone other than the intended recipient, and cannot be replayed.

> **Storage choice:** SSM Parameter Store `SecureString` rather than Secrets Manager. SSM is free, supports KMS encryption, and is rotatable via PutParameter without a redeploy — meeting every requirement Secrets Manager would at $0 vs $0.40/code/month.

> **No in-Lambda caching:** The Cognito preSignUp trigger reads the parameter once per signup attempt. Signup volume is negligible (invite-only) so caching adds complexity without benefit, and avoids the stale-cache failure mode that made Secrets Manager caching error-prone.

### 2.3 AI outputs specification

| Output | Format | Scaling rule |
|---|---|---|
| Summary | Prose sections with logical headings | Fixed — model chooses section count based on content |
| Quiz questions | Multiple choice, 4 options (A, B, C, D) | Bank of 25 generated and stored per topic. User picks attempt length (Short 10 · Medium 15 · Long 25); client samples from the bank per attempt |
| Key terms | Term + definition pairs | Fixed range — model returns 10–15 terms based on document content |

**Key term count:** Fixed 10–15 per document. This removes the need for a page-count pre-read, allowing the processor to hand the PDF to Bedrock via `s3Location` without Lambda ever loading the bytes — saving ~1–3 seconds of pipeline latency per job and ~50 MB of Lambda memory.

**Quiz question randomisation:**

Each topic has a fixed bank of 25 questions generated once at processing time. On every attempt, the client shuffles the bank, slices the first `n` (10/15/25 per the user's length selection), and also shuffles the four answer options within each question so the correct answer is not always in the same position. All shuffling is client-side; the bank itself is immutable.

### 2.4 Processing screen behaviour

After the PDF is uploaded to S3, the user is shown a processing screen with a spinner. Three labelled progress steps animate as the job moves through the pipeline. The client polls `GET /jobs/{jobId}` every 3 seconds. When `status` equals `complete` the client navigates directly to the new topic's detail screen. When `status` equals `failed` the client shows an error message with a retry option.

| Step label shown | Triggered when |
|---|---|
| Uploading to S3 | S3 PUT completes |
| Bedrock reading document via S3 URI | DynamoDB status transitions to `processing` |
| Saving to your library | DynamoDB status transitions to `complete` |

> **Polling rationale:** Processing takes 15–40 seconds for a typical document. The user has no reason to navigate away during this window — the processing screen is a deliberate dead-end. A 3-second poll interval means at most 3 seconds of extra wait after completion. WebSocket would require two additional Lambdas, a second API Gateway endpoint, and connection ID tracking in DynamoDB for no perceptible user benefit at this scale.

> **Tab close + return (v1):** If the user closes the tab during processing, the job still completes server-side. The client persists the active `jobId` to `localStorage` at upload time. When the user reopens the library on the same browser, an in-flight banner appears above the tile grid and resumes polling `GET /jobs/{jobId}`; on `complete` the banner clears and the new tile is loaded via `GET /topics`. This is a same-device-only signal — see §12 for the v2 plan that lifts this to a cross-device tile via a backend change.

### 2.5 Non-goals for v1

- No multi-document sessions — one PDF per job, one job at a time per user
- No result export — no CSV, no flashcard file, no printable view
- No sharing — results are private to the uploading user
- No re-processing — a processed document cannot be sent to Bedrock again
- No email notifications — user waits on the processing screen
- No admin dashboard — join requests reviewed and invite codes generated via CLI against SSM + DynamoDB
- No custom domain — CloudFront domain used until a domain is purchased
- No multi-region / multi-AZ redundancy — single-region `us-east-1` is acceptable for MVP
- No DynamoDB PITR or backups — acceptable data-loss risk for MVP
- No CI/CD — `cdk deploy` from the owner's workstation; staging env deferred

---

## 3. Tech stack

### 3.1 Frontend

| Layer | Choice & rationale |
|---|---|
| UI framework | Preact 10 — 3 KB vs React 40 KB, identical hooks API, no transpiler needed |
| Template syntax | HTM — JSX-like tagged template literals that run natively in any browser |
| Module delivery | ES module imports via esm.sh — zero npm, zero bundler, zero node_modules |
| Hosting | S3 static website + CloudFront — deploy with a single `aws s3 cp` command |
| Build pipeline | None — `index.html` is the only deployable artefact |
| Auth client | Cognito SRP flow via Amazon Cognito SDK (loaded from CDN) |
| Styling | Vanilla CSS custom properties — no framework, no preprocessor |
| Fonts | Google Fonts: Lora (display) + DM Sans (UI) via link preconnect |

### 3.2 Backend

| Layer | Choice & rationale |
|---|---|
| Runtime | Node.js 22 on Lambda — minimal cold start, native ESM, fast JSON |
| API layer | API Gateway HTTP API (v2) — lower latency and cost than REST API |
| Async transport | SQS standard — at-least-once with retry; processor is idempotent via conditional DynamoDB writes |
| AI model | Bedrock Nova 2 Lite (`us.amazon.nova-2-lite-v1:0`) — S3 URI source, 1M token context, no per-file PDF size limit via S3 |
| PDF delivery | S3 URI via `s3Location` parameter — Bedrock reads directly from S3, no bytes transit Lambda |
| Job state | DynamoDB single-table — on-demand capacity, 90-day TTL on job records |
| Learning artefacts | DynamoDB — summary, quiz questions, key terms stored permanently per topic |
| Quiz attempts | DynamoDB — timestamp, score, total, and length enum stored per attempt |
| Invite codes | SSM Parameter Store `SecureString` — per-email, single-use, KMS-encrypted, free |
| IaC | AWS CDK TypeScript — split into `PulpDataStack` (retain-on-delete) and `PulpAppStack` (compute/API) |
| Tracing | AWS X-Ray on Lambda + API Gateway — Bedrock call latency attribution |

### 3.3 DevOps

| Concern | Approach |
|---|---|
| Provisioning | `cdk deploy` — single command provisions all resources |
| Frontend deploy | `aws s3 sync` + `cloudfront create-invalidation` (Makefile target) |
| Secrets | Invite code in Secrets Manager; all other config via Lambda env vars injected by CDK |
| Logging | CloudWatch Logs — structured JSON, 30-day retention per Lambda log group |
| Monitoring | CloudWatch Alarms: DLQ depth, Lambda error rate, Bedrock throttling |
| Local testing | AWS SAM local invoke for Lambda; Postman or curl for API testing |
| Region | `us-east-1` (primary and only region for v1) |

---

## 4. Architecture

### 4.1 System layers

| Tier | Components | Responsibility |
|---|---|---|
| Client | Browser / mobile app (single `index.html`) | UI, upload, polling, library display |
| Auth + API | Cognito User Pool, API Gateway HTTP API | Identity, JWT validation, request routing |
| Compute | Upload, Processor, Results, Sign-up, Attempts Lambdas | Business logic |
| Queue + Storage | SQS FIFO, S3 uploads bucket, DynamoDB | Async decoupling, file storage, data persistence |
| AI | Bedrock Nova 2 Lite | PDF comprehension, structured output generation |

### 4.2 Request lifecycle

#### A — Authentication and sign-up

- Prospective user submits `{ email }` to `POST /auth/join-request`. Request is recorded in DynamoDB for owner review.
- Owner approves a request by generating a random invite code, hashing it (SHA-256), and writing the hash to SSM Parameter Store with the bound email. Plaintext code is delivered out-of-band.
- User calls the Cognito SDK `signUp` directly with `{ email, password, clientMetadata: { inviteCode } }`. The Cognito `preSignUp` Lambda trigger hashes the code, looks up SSM, verifies the email binding and `status === unused`, marks it `used`, and allows the signup. Any failure throws — Cognito creates no user record.
- On subsequent logins, Cognito validates credentials and returns a JWT ID token. All API Gateway requests carry this token as `Authorization: Bearer`.

#### B — Uploading a document

- Client calls `POST /uploads` with `{ filename }` (no quiz length — the bank is always 25)
- Upload Lambda generates a presigned S3 PUT URL scoped to `uploads/{userId}/{jobId}.pdf` with `Content-Type: application/pdf` and `Content-Length` range pinned (max 50 MB) and writes a DynamoDB job record with `status: pending`
- Client PUTs the file directly to S3 — no bytes pass through Lambda or API Gateway, bypassing the 10 MB payload limit. Uploads that violate the pinned headers are rejected by S3.
- Client navigates to the processing screen and begins polling `GET /jobs/{jobId}` every 3 seconds

#### C — Async processing pipeline

- S3 fires an `s3:ObjectCreated:Put` event notification to the SQS standard queue on successful upload
- Processor Lambda is triggered by SQS event source mapping (batch size: 1). Processor performs a **conditional** DynamoDB update (`status = pending`) → `processing`; if the condition fails (duplicate delivery, job already complete) the message is deleted without re-running Bedrock — this is the idempotency guard
- Lambda does **not** download the PDF. It immediately fans out three Bedrock Nova 2 Lite calls in parallel via `Promise.allSettled()`, each passing the PDF by `s3Location` so Bedrock reads from S3 directly:
  - Call 1 — structured summary with logical sections (prose)
  - Call 2 — a bank of exactly 25 multiple-choice quiz questions, returned as JSON
  - Call 3 — 10–15 key terms (model-chosen count in range), returned as JSON
- Each Bedrock call has its own retry with exponential backoff + jitter (up to 3 attempts) for `ThrottlingException` and transient 5xx
- All three calls pass the PDF via `s3Location` — Bedrock fetches from S3 directly
- Returned JSON is schema-validated (quiz: exactly 25 items, `options.length === 4`, `correctIndex ∈ 0..3`; keyTerms: 10–15 items inclusive, non-empty `term` / `definition`). Schema failure marks the job `failed`.
- **On success of all three:** Lambda writes `summary`, `quizQuestions`, `keyTerms` to a Topic record in DynamoDB (conditional on `status = processing`) and sets `status: complete`. Lambda then deletes the S3 object
- **On any artefact failure:** Lambda sets `status: failed` and writes the per-call error detail. PDF is **not** deleted. SQS retries up to 3× before routing to the DLQ

#### D — Polling and result delivery

- Client polls `GET /jobs/{jobId}` every 3 seconds from the processing screen
- When `status === 'complete'`, client navigates to the new topic detail screen
- When `status === 'failed'`, client shows an inline error with a "Try again" button that resets to the upload screen

#### E — Quiz flow

- User opens a topic tile and selects "Take quiz"
- User selects Short (10), Medium (15), or Long (25) on the quiz config screen
- Client fetches the full 25-question bank from the Topic record, shuffles it, slices the first `n`, and shuffles the four options per question before the first question renders
- User answers each question. No answer is revealed as correct or incorrect until the final screen
- On completion, client calculates score, displays it (e.g. 12 / 15 — 80%), and calls `POST /topics/{topicId}/attempts` to save `{ timestamp, score, total, length }`
- All previous attempts for the topic are shown below the current score in reverse chronological order

---

## 5. AWS infrastructure

### 5.1 Resource inventory

| Service | Resource / config | Notes |
|---|---|---|
| S3 | `pulp-uploads-{accountId}` | No public access · versioning off · SSE-S3 enforced · TLS-only bucket policy (`aws:SecureTransport`) · PDF deleted after successful processing |
| S3 | `pulp-frontend` | Static website hosting · CloudFront OAC only · TLS-only bucket policy |
| CloudFront | Distribution · HTTPS only | Default behaviour → `pulp-frontend` bucket · AWS WAF web ACL attached (rate-based rule on `/auth/*`) |
| Cognito | `pulp-user-pool` | Email sign-in · self sign-up enabled (gated by preSignUp trigger) · `AdvancedSecurityMode: ENFORCED` |
| Cognito | `pulp-app-client` | No client secret · SRP auth flow |
| SSM Parameter Store | `/pulp/invite-codes/{codeHash}` | `SecureString` · per-email single-use invite codes · KMS-encrypted |
| API Gateway | `pulp-api` (HTTP API) | Cognito JWT authorizer on all routes · CORS `allowOrigins` restricted to CloudFront domain · X-Ray tracing on · `/auth/join-request` throttled |
| Lambda | `pulp-presignup-trigger` | Node 22 · 256 MB · 5 s · Cognito preSignUp trigger · reads + updates SSM |
| Lambda | `pulp-join-request-handler` | Node 22 · 128 MB · 5 s · writes `JOINREQ#` records |
| Lambda | `pulp-upload-handler` | Node 22 · 256 MB · 10 s · presign (Content-Type + Content-Length pinned) + DynamoDB init |
| Lambda | `pulp-processor` | Node 22 · 256 MB · 120 s · SQS trigger · parses PDF · 3 parallel Bedrock calls (allSettled + retry) |
| Lambda | `pulp-results-handler` | Node 22 · 128 MB · 5 s · job status read |
| Lambda | `pulp-attempts-handler` | Node 22 · 128 MB · 5 s · write and read quiz attempt records |
| SQS | `pulp-jobs` | Standard queue · `visibilityTimeout`: 720 s (6× Lambda timeout) |
| SQS | `pulp-jobs-dlq` | Standard · `maxReceiveCount`: 3 · CloudWatch alarm on depth > 0 |
| DynamoDB | `pulp-table` (single-table) | On-demand · TTL on job records (90 days) · topics and attempts stored permanently |
| Bedrock | Nova 2 Lite on-demand | Model ID: `us.amazon.nova-2-lite-v1:0` (cross-region inference profile) |
| CloudWatch | Log groups per Lambda | 30-day retention |
| IAM | `pulp-processor-role` | Least-privilege: bedrock, s3, dynamodb, sqs |

### 5.2 DynamoDB data model

Single-table design. Three entity types share one table: **Jobs** (temporary processing records), **Topics** (permanent learning artefacts), and **Attempts** (quiz attempt history).

#### Job records

| Attribute | Type | Description |
|---|---|---|
| PK | String | `USER#{userId}` — Cognito sub claim |
| SK | String | `JOB#{jobId}` — UUID v4 generated at upload |
| `status` | String | `pending` \| `processing` \| `complete` \| `failed` |
| `s3Key` | String | Full S3 object key of the uploaded PDF |
| `createdAt` | String | ISO 8601 timestamp |
| `updatedAt` | String | ISO 8601 timestamp |
| `error` | String | Present only when `status = failed` |
| `expiresAt` | Number | Unix epoch — `createdAt` + 90 days (DynamoDB TTL attribute) |

#### Topic records

| Attribute | Type | Description |
|---|---|---|
| PK | String | `USER#{userId}` |
| SK | String | `TOPIC#{topicId}` — same value as the `jobId` that created it |
| `title` | String | PDF filename (without extension) displayed on the library tile |
| `createdAt` | String | ISO 8601 timestamp |
| `summary` | String | Full structured summary returned by Bedrock |
| `quizQuestions` | List | Bank of 25 `{ question, options: [A, B, C, D], correctIndex }` objects — client samples `n` per attempt |
| `keyTerms` | List | Array of `{ term, definition }` objects |

#### Attempt records

| Attribute | Type | Description |
|---|---|---|
| PK | String | `USER#{userId}` |
| SK | String | `ATTEMPT#{topicId}#{timestamp}` — sortable, unique per attempt |
| `topicId` | String | Reference to the parent topic |
| `score` | Number | Number of correct answers |
| `total` | Number | Total questions in that attempt (10, 15, or 25) |
| `length` | String | `short` \| `medium` \| `long` — enum for display |
| `timestamp` | String | ISO 8601 — also embedded in SK for sort ordering |

> **Access patterns:** Library query: `PK = USER#{userId}`, `SK begins_with TOPIC#`. Attempts query: `PK = USER#{userId}`, `SK begins_with ATTEMPT#{topicId}`. No GSI required for v1.

### 5.3 IAM policy — processor Lambda

| Permission | Resource scope |
|---|---|
| `bedrock:InvokeModel` | `arn:aws:bedrock:*::foundation-model/amazon.nova-2-lite-v1:0` |
| `s3:GetObject` | `arn:aws:s3:::pulp-uploads-{accountId}/uploads/*` |
| `s3:DeleteObject` | `arn:aws:s3:::pulp-uploads-{accountId}/uploads/*` |
| `dynamodb:UpdateItem` | `arn:aws:dynamodb:us-east-1:{accountId}:table/pulp-table` |
| `dynamodb:PutItem` | `arn:aws:dynamodb:us-east-1:{accountId}:table/pulp-table` |
| `sqs:ReceiveMessage` | `arn:aws:sqs:us-east-1:{accountId}:pulp-jobs.fifo` |
| `sqs:DeleteMessage` | `arn:aws:sqs:us-east-1:{accountId}:pulp-jobs.fifo` |
| `sqs:GetQueueAttributes` | `arn:aws:sqs:us-east-1:{accountId}:pulp-jobs.fifo` |
| `ssm:GetParameter` · `ssm:PutParameter` | `arn:aws:ssm:us-east-1:{accountId}:parameter/pulp/invite-codes/*` (preSignUp trigger only) |

### 5.4 Bedrock integration

#### No page-count extraction

The processor does not read the PDF. Key term count is a fixed 10–15 range chosen by the model, so there is no need to determine page count before invoking Bedrock. Removing the pre-read means the PDF bytes never transit Lambda — Bedrock fetches directly from S3 via `s3Location`, saving ~1–3 seconds of pipeline latency per job.

```js
const questionCount = { short: 10, medium: 15, long: 25 }[quizLength];
```

#### Prompt templates

| Call | System prompt | User prompt |
|---|---|---|
| Summary | `You are a precise academic assistant.` | `Analyse this document and write a structured summary. Create logical section headings that reflect the document's content — do not mirror the document's own headings, create your own based on the ideas. Under each heading write 2–4 sentences of clear prose. Output in English only.` |
| Quiz | `You are a precise academic assistant. Respond only with valid JSON, no markdown.` | `Generate exactly 25 multiple-choice questions from this document. Each question must have exactly 4 answer options labelled A, B, C, D. Return a JSON array of objects: { question: string, options: [string, string, string, string], correctIndex: number (0–3) }. Questions should span the full document and cover distinct ideas — no duplicates or trivial variants, since subsets of this bank will be used for multiple quiz attempts. Output in English only.` |
| Key terms | `You are a precise academic assistant. Respond only with valid JSON, no markdown.` | `Extract between 10 and 15 key terms from this document (inclusive) — choose the count that best fits the document's conceptual density. Return a JSON array of objects: { term: string, definition: string }. Definitions must be 1–2 sentences. Output in English only.` |

> **JSON safety:** The processor Lambda wraps all `JSON.parse()` calls in `try/catch`. If Bedrock returns malformed JSON for quiz or key terms, the job is marked as `failed` and the error is stored. The summary is stored as a plain string and does not require JSON parsing.

### 5.5 File size and page limits

| Path | PDF size limit | Page limit |
|---|---|---|
| Nova 2 Lite via S3 URI (Pulp processor) | No per-file limit; 2 GB combined via S3 | ~390 pages (1M token context) |
| API Gateway (not used for PDF upload) | 10 MB payload hard limit | N/A |
| S3 presigned URL (direct upload) | 5 GB single PUT · 5 TB multipart | N/A |

A PDF that exceeds the Nova 2 Lite context window (~390 pages at 2,560 tokens per standard page) will cause a Bedrock error, which the processor handles as a failed job. A user-facing error message should advise splitting very long documents.

---

## 6. API reference

**Base URL:** `https://{api-id}.execute-api.us-east-1.amazonaws.com/prod`

All endpoints except `POST /auth/join-request` require `Authorization: Bearer {Cognito JWT ID token}`. Signup itself is performed directly against the Cognito endpoint via the Amazon Cognito SDK (SRP flow), not through API Gateway — the preSignUp Lambda trigger performs the invite-code check.

### 6.1 Auth

#### `POST /auth/join-request`

| Field | Detail |
|---|---|
| Auth | None — public endpoint · rate-limited by WAF |
| Request body | `{ email: string }` |
| Response 200 | `{ message: "Request received" }` — always returned to avoid email enumeration |
| Side effect | Writes a `JOINREQ#{email}` record to DynamoDB for owner review |

#### Signup (direct Cognito SDK — no API Gateway route)

| Field | Detail |
|---|---|
| Flow | Client calls `CognitoIdentityProviderClient.SignUpCommand` with `ClientMetadata: { inviteCode }` |
| Trigger | Cognito invokes the `preSignUp` Lambda, which hashes the code, validates against SSM, binds to the submitted email, and marks the code `used` |
| Success | Cognito creates the user |
| Failure | preSignUp throws → Cognito returns signup error; no user record is created |

### 6.2 Uploads

#### `POST /uploads`

| Field | Detail |
|---|---|
| Request body | `{ filename: string }` |
| Response 200 | `{ uploadUrl: string, jobId: string }` |
| Side effect | Writes DynamoDB job record with `status: pending` |

### 6.3 Jobs

#### `GET /jobs/{jobId}`

| Field | Detail |
|---|---|
| Response 200 | `{ status: string, topicId?: string, error?: string }` |
| Notes | Returns `topicId` when `status = complete`, enabling client navigation to the topic detail screen |

### 6.4 Topics

#### `GET /topics`

| Field | Detail |
|---|---|
| Response 200 | Array of `{ topicId, title, createdAt }` |
| Notes | Returns all topics for the authenticated user, sorted by `createdAt` descending |

#### `GET /topics/{topicId}`

| Field | Detail |
|---|---|
| Response 200 | `{ topicId, title, createdAt, summary, quizQuestions, keyTerms }` |
| Notes | Full topic record including all learning artefacts |

### 6.5 Attempts

#### `POST /topics/{topicId}/attempts`

| Field | Detail |
|---|---|
| Request body | `{ score: number, total: number, length: "short" \| "medium" \| "long" }` |
| Response 200 | `{ message: "Attempt saved" }` |
| Side effect | Writes `ATTEMPT#` record to DynamoDB |

#### `GET /topics/{topicId}/attempts`

| Field | Detail |
|---|---|
| Response 200 | Array of `{ timestamp, score, total, length }` sorted by `timestamp` descending |
| Notes | Returns all attempts for the topic, displayed on the quiz results screen |

---

## 7. CDK stack outline

Files: `cdk/lib/pulp-data-stack.ts` (stateful, `removalPolicy: RETAIN`) and `cdk/lib/pulp-app-stack.ts` (compute/API, free to destroy/recreate). The app stack consumes data-stack outputs via SSM parameters or CfnOutput imports.

**`PulpDataStack` — retain-on-delete**

| Construct | Key configuration |
|---|---|
| `s3.Bucket` (uploads) | `versioned: false` · `blockPublicAccess: BLOCK_ALL` · `encryption: S3_MANAGED` · TLS-only bucket policy · `removalPolicy: RETAIN` |
| `s3.Bucket` (frontend) | `websiteIndexDocument: index.html` · no public access · TLS-only bucket policy · `removalPolicy: RETAIN` |
| `dynamodb.Table` | `partitionKey: PK` · `sortKey: SK` · `billingMode: PAY_PER_REQUEST` · `timeToLiveAttribute: expiresAt` · `removalPolicy: RETAIN` |
| `cognito.UserPool` | `selfSignUpEnabled: true` · `signInAliases: { email: true }` · `advancedSecurityMode: ENFORCED` · `lambdaTriggers: { preSignUp: preSignUpTrigger }` · `removalPolicy: RETAIN` |
| `cognito.UserPoolClient` | `generateSecret: false` · `authFlows: { userSrp: true }` |

**`PulpAppStack` — compute / API**

| Construct | Key configuration |
|---|---|
| `cloudfront.Distribution` | `defaultBehavior: S3Origin(frontendBucket)` (OAC) · `viewerProtocolPolicy: HTTPS_ONLY` · `webAclId: wafWebAcl.attrArn` |
| `wafv2.CfnWebACL` | Rate-based rule: 100 req / 5 min per IP on `/auth/*` paths |
| `sqs.Queue` (DLQ) | Standard · `retentionPeriod: Duration.days(14)` |
| `sqs.Queue` (main) | Standard · `visibilityTimeout: Duration.seconds(720)` · `deadLetterQueue: { queue: dlq, maxReceiveCount: 3 }` |
| `apigatewayv2.HttpApi` | `corsPreflight: { allowOrigins: [cloudFrontDomain] }` · `defaultAuthorizer: HttpJwtAuthorizer(userPool)` — `/auth/join-request` excluded · X-Ray tracing enabled |
| `lambda.NodejsFunction` (preSignUpTrigger) | `entry: lambdas/presignup.ts` · 256 MB · 5 s · X-Ray `ACTIVE` · `ssm:GetParameter` + `ssm:PutParameter` on `/pulp/invite-codes/*` |
| `lambda.NodejsFunction` (joinRequest) | `entry: lambdas/join-request.ts` · 128 MB · 5 s · X-Ray `ACTIVE` |
| `lambda.NodejsFunction` (upload) | `entry: lambdas/upload.ts` · 256 MB · 10 s · X-Ray `ACTIVE` · `env: BUCKET, TABLE, QUEUE_URL` |
| `lambda.NodejsFunction` (processor) | `entry: lambdas/processor.ts` · 256 MB · 120 s · X-Ray `ACTIVE` · `events: SqsEventSource(queue, { batchSize: 1, maxConcurrency: 5 })` |
| `lambda.NodejsFunction` (results) | `entry: lambdas/results.ts` · 128 MB · 5 s · X-Ray `ACTIVE` · `env: TABLE` |
| `lambda.NodejsFunction` (topics) | `entry: lambdas/topics.ts` · 128 MB · 5 s · X-Ray `ACTIVE` · `env: TABLE` |
| `lambda.NodejsFunction` (attempts) | `entry: lambdas/attempts.ts` · 128 MB · 5 s · X-Ray `ACTIVE` · `env: TABLE` |
| IAM (processor role) | `bedrock:InvokeModel` · `s3:GetObject` · `s3:DeleteObject` (uploads) · `dynamodb:UpdateItem` · `dynamodb:PutItem` · `sqs:ReceiveMessage` · `sqs:DeleteMessage` · `sqs:GetQueueAttributes` (main queue) |
| `cloudwatch.Alarm` (DLQ depth) | `ApproximateNumberOfMessagesVisible > 0` · SNS email |
| `cloudwatch.Alarm` (queue age) | `ApproximateAgeOfOldestMessage > 300 s` · SNS email |
| `cloudwatch.Alarm` (processor errors) | Lambda `Errors > 5` in 5 min · SNS email |
| `cloudwatch.Alarm` (Bedrock throttles) | Custom metric from processor logs · > 3 in 5 min · SNS email |
| `budgets.CfnBudget` | Monthly cost budget $5 · email notification at 80% and 100% |

---

## 8. Security

### 8.1 Invite code protection

- Invite codes are stored as SSM Parameter Store `SecureString` values under `/pulp/invite-codes/{sha256(code)}`. Only the hash is persisted; plaintext is delivered to the requester out of band and never logged
- Each code is **single-use and email-bound** — the parameter value records the approved email, and the preSignUp trigger marks the parameter `used` on consumption. Replay or cross-email reuse is rejected
- The check occurs inside the Cognito preSignUp trigger, so invalid attempts leave no trace in the user pool
- No in-Lambda caching of parameters — signup volume is too low to justify a cache, and per-signup reads guarantee consumed codes cannot be reused from stale state

### 8.2 Authentication

- All API Gateway routes except `POST /auth/join-request` are protected by a Cognito JWT authorizer
- The authorizer validates the token's signature, issuer, audience, and expiry on every request — no custom Lambda validation needed
- Cognito `AdvancedSecurityMode: ENFORCED` provides compromised-credential detection and adaptive MFA challenges
- AWS WAF rate-based rule applied to `/auth/*` routes at the CloudFront layer to blunt credential stuffing and join-request abuse
- JWT tokens expire after 1 hour. The client re-authenticates silently using the Cognito refresh token flow

### 8.3 Data isolation

- All DynamoDB queries filter by `PK = USER#{userId}` derived from the JWT sub claim
- The results and attempts Lambdas validate that the `topicId` in the path belongs to the requesting user before returning data
- S3 presigned URLs are scoped to `uploads/{userId}/{jobId}.pdf` and pin `Content-Type: application/pdf` and a `Content-Length` range (max 50 MB) — a user cannot overwrite another user's file, upload non-PDF payloads, or submit oversize objects
- S3 bucket policy denies any request where `aws:SecureTransport = false` (TLS-only enforcement)
- Server-side encryption (SSE-S3) explicitly enabled on both buckets

### 8.4 Input validation

- Upload Lambda validates that the filename ends in `.pdf` before generating the presigned URL
- The document name passed to Bedrock is always the static string `"document"` regardless of the user's filename — this prevents prompt injection via attacker-controlled filenames
- Quiz and key term JSON responses from Bedrock are parsed in `try/catch`. Malformed output triggers a `failed` status rather than a 500 error
- `length` on attempt submission is validated as an enum (`short | medium | long`) at the attempts Lambda before being stored

---

## 9. Observability

### 9.1 Structured logging

All Lambdas emit JSON-structured logs to CloudWatch. The processor Lambda logs `jobId`, `userId`, `pageCount`, `keyTermCount`, `questionCount`, and individual Bedrock call latencies so slow or expensive jobs are identifiable.

### 9.2 Alarms

| Alarm | Threshold | Action |
|---|---|---|
| DLQ message depth | > 0 messages | SNS email to owner |
| SQS `ApproximateAgeOfOldestMessage` | > 300 s | SNS email — preventative; catches stuck processor before DLQ |
| Processor Lambda errors | > 5 errors in 5 minutes | SNS email to owner |
| Bedrock `ThrottlingException` rate | > 3 in 5 minutes | SNS email to owner |
| AWS Budgets — monthly total | > $5 / month | SNS email — Bedrock is the only unbounded cost |

### 9.3 Cost estimate

Estimated monthly cost at low invite-only volume (~20 PDFs processed, average 15 pages each).

| Service | Estimated monthly cost |
|---|---|
| Lambda (all functions) | < $0.01 — within free tier (1M requests/month) |
| API Gateway HTTP API | < $0.01 — within free tier (1M requests/month) |
| SQS FIFO | < $0.01 — within free tier (1M requests/month) |
| DynamoDB | < $0.01 — within free tier (25 GB storage, 200M requests) |
| S3 | < $0.01 — PDFs deleted post-processing, minimal storage |
| CloudFront | < $0.01 — within free tier (1 TB transfer/month) |
| Cognito | $0 — free for up to 50,000 MAU (Advanced Security adds ~$0.05/MAU beyond the free tier) |
| SSM Parameter Store | $0 — standard parameters are free |
| AWS WAF | ~$1.00 — $1/web ACL/month + $0.60/rule/month |
| X-Ray | < $0.01 — within free tier (100k traces/month) |
| Bedrock Nova 2 Lite | ~$0.10–$0.50 — dominant variable cost; scales with document length and question count |
| **Total (approx.)** | **~$1.10–$1.60/month at this volume** |

> **Free tier note:** All services except Bedrock, WAF, and Advanced Security remain within permanent free tier allocations at low invite-only volume. Bedrock has no free tier — it is pay-per-token from the first call. A $5/month AWS Budgets alert guards against Bedrock cost spikes.

---

## 10. Deployment

### 10.1 Prerequisites

- AWS CLI configured with AdministratorAccess on the new account
- Node.js 22 and npm installed locally
- AWS CDK CLI: `npm install -g aws-cdk`
- Bedrock model access enabled for Nova 2 Lite in `us-east-1` (console: Bedrock → Model access → Amazon Nova Lite → Enable)

### 10.2 First deployment

```bash
cd cdk && npm install
cdk bootstrap aws://{accountId}/us-east-1
cdk deploy PulpDataStack PulpAppStack --outputs-file outputs.json

# Deploy frontend
aws s3 cp ../frontend/index.html s3://pulp-frontend/
aws cloudfront create-invalidation --distribution-id {id} --paths '/*'
```

**Approving a join request and issuing an invite code:**

```bash
# 1. Generate a random code and its SHA-256 hash
CODE=$(openssl rand -hex 16)
HASH=$(printf '%s' "$CODE" | shasum -a 256 | awk '{print $1}')

# 2. Write the hash to SSM bound to the requester's email
aws ssm put-parameter \
  --name "/pulp/invite-codes/$HASH" \
  --type SecureString \
  --value "{\"email\":\"user@example.com\",\"status\":\"unused\",\"createdAt\":\"$(date -u +%FT%TZ)\"}"

# 3. Email $CODE to the user out of band. Plaintext is never stored server-side.
```

### 10.3 Subsequent deployments

- **Backend:** `cdk deploy PulpAppStack` (or `PulpDataStack` when stateful resources change) — CDK computes changeset, updates only changed resources
- **Frontend:** `make deploy-frontend` (runs `s3 cp` + CloudFront invalidation)
- **Issuing a new invite:** `aws ssm put-parameter ...` as in §10.2 — effective immediately, no redeploy needed
- **CI/CD:** deferred for MVP; future work is GitHub Actions with an OIDC-assumed deploy role

### 10.4 Teardown

```bash
cdk destroy PulpStack
```

`PulpDataStack` resources (S3, DynamoDB, Cognito) are marked `RETAIN` and will not be deleted. Empty both buckets and delete the user pool / table manually if a full teardown is required.

---

## 11. Remaining open questions

| Question | Impact |
|---|---|
| Who monitors the `JOINREQ#` table and issues codes? | Manual approval loop — needs an operational cadence until an admin UI is built |
| Should a maximum PDF file size be enforced client-side before upload? | Prevents users hitting a Bedrock context error for very large files |
| What error message should display if a PDF exceeds the page limit? | UX copy needed for the failed job screen |
| Should quiz question shuffling be seeded so the same attempt reproduces identical question order? | Affects reproducibility and debugging |
| Is there a cap on how many topics a single user can create? | No limit currently enforced — could be added as a Lambda check |

---

## 12. Planned for the next version

| Item | Why deferred from v1 | v2 sketch |
|---|---|---|
| Cross-device in-flight tile in the library | v1 ships a localStorage-backed banner (see §2.4) — same-device only, but covers the dominant use case (close tab, reopen on same browser) | Extend `GET /topics` to return both completed `TOPIC#` rows and any in-progress `JOB#` rows for the user, merged into a single tile list with the existing `status` field driving the badge. Requires a second `Query` (or a `BatchGetItem`) in `topics.ts` and updates to Phase 5 acceptance tests. |

---

## Appendix A: Directory structure

```
pulp/
  frontend/
    index.html                  # Complete Preact + HTM app — the only frontend file
  cdk/
    lib/
      pulp-data-stack.ts        # Stateful: S3, DynamoDB, Cognito (RETAIN)
      pulp-app-stack.ts         # Compute/API: CloudFront, WAF, API GW, Lambdas, SQS, alarms
    lambdas/
      presignup.ts               # Cognito preSignUp trigger — SSM invite code check
      join-request.ts            # POST /auth/join-request — records pending requests
      upload.ts                  # POST /uploads — presign + DynamoDB job init
      processor.ts               # SQS trigger — page count, Bedrock calls, DynamoDB write, S3 delete
      results.ts                 # GET /jobs/{jobId} — job status polling
      topics.ts                  # GET /topics, GET /topics/{topicId}
      attempts.ts                # POST + GET /topics/{topicId}/attempts
    package.json
    cdk.json
  Makefile
  README.md
```

---

## Appendix B: Environment variables

| Variable | Lambda(s) | Description |
|---|---|---|
| `BUCKET_NAME` | upload, processor | S3 uploads bucket name |
| `TABLE_NAME` | all | DynamoDB table name |
| `QUEUE_URL` | upload | SQS FIFO main queue URL |
| `USER_POOL_ID` | presignup | Cognito User Pool ID |
| `APP_CLIENT_ID` | presignup | Cognito App Client ID |
| `INVITE_CODE_SSM_PREFIX` | presignup | SSM Parameter Store prefix (e.g. `/pulp/invite-codes/`) |
| `AWS_REGION` | all | Auto-injected by Lambda runtime |

---

*End of specification*