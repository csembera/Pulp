#!/usr/bin/env node
/**
 * End-to-end smoke test — create user → login → upload → poll → topic → attempt.
 * Exits 0 on success, non-zero on any failure.
 *
 * Required env:
 *   SMOKE_EMAIL          unique email
 *   SMOKE_PASSWORD       password meeting Cognito policy
 *
 * Uses AdminCreateUser + AdminSetUserPassword(Permanent=true) to bootstrap
 * the account directly, bypassing the temp-password / NEW_PASSWORD_REQUIRED
 * flow. The caller's AWS credentials must allow cognito:AdminCreateUser and
 * cognito:AdminSetUserPassword on the pool. No cleanup — each run should
 * use a fresh email.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cdkMods   = resolve(__dirname, '../cdk/node_modules');
const require   = createRequire(pathToFileURL(join(cdkMods, 'sentinel')));

const {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminSetUserPasswordCommand,
  InitiateAuthCommand,
} = require('@aws-sdk/client-cognito-identity-provider');

// ── Config ────────────────────────────────────────────────────────────────────
const EMAIL    = process.env.SMOKE_EMAIL;
const PASSWORD = process.env.SMOKE_PASSWORD;

if (!EMAIL || !PASSWORD) {
  console.error('Missing env. Required: SMOKE_EMAIL, SMOKE_PASSWORD');
  process.exit(2);
}

const outputsPath = resolve(__dirname, '../cdk/outputs.json');
if (!existsSync(outputsPath)) {
  console.error(`cdk/outputs.json not found — run 'make deploy-backend' first.`);
  process.exit(2);
}
const outputs   = JSON.parse(readFileSync(outputsPath, 'utf8'));
const REGION    = 'us-east-1';
const USER_POOL = outputs.PulpDataStack.UserPoolId;
const CLIENT_ID = outputs.PulpDataStack.UserPoolClientId;
const API       = outputs.PulpAppStack.ApiUrl;

const fixturePath = resolve(__dirname, 'fixtures/sample.pdf');
if (!existsSync(fixturePath)) {
  console.error(`Fixture missing: ${fixturePath}`);
  process.exit(2);
}

const cognito = new CognitoIdentityProviderClient({ region: REGION });

// ── Helpers ───────────────────────────────────────────────────────────────────
async function step(label, fn) {
  process.stdout.write(`→ ${label}\n`);
  try {
    return await fn();
  } catch (e) {
    console.error(`✗ ${label} failed:`, e?.name ?? '', e?.message ?? e);
    process.exit(1);
  }
}

async function authedFetch(idToken, path, init = {}) {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${idToken}`,
      ...(init.body && !(init.headers?.['Content-Type']) ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

// ── Flow ──────────────────────────────────────────────────────────────────────
console.log(`Smoke target: ${API}`);
console.log(`User:         ${EMAIL}`);

// 1. Create user (suppressed welcome email; pre-verified) and set a permanent password.
await step('AdminCreateUser', async () => {
  await cognito.send(new AdminCreateUserCommand({
    UserPoolId:     USER_POOL,
    Username:       EMAIL,
    UserAttributes: [
      { Name: 'email',          Value: EMAIL },
      { Name: 'email_verified', Value: 'true' },
    ],
    MessageAction: 'SUPPRESS',
  }));
});

await step('AdminSetUserPassword (permanent)', async () => {
  await cognito.send(new AdminSetUserPasswordCommand({
    UserPoolId: USER_POOL,
    Username:   EMAIL,
    Password:   PASSWORD,
    Permanent:  true,
  }));
});

// 2. Login
const idToken = await step('Login (USER_PASSWORD_AUTH)', async () => {
  const r = await cognito.send(new InitiateAuthCommand({
    AuthFlow:        'USER_PASSWORD_AUTH',
    AuthParameters:  { USERNAME: EMAIL, PASSWORD },
    ClientId:        CLIENT_ID,
  }));
  return r.AuthenticationResult.IdToken;
});

// 3. Upload init
const { uploadUrl, jobId } = await step('POST /uploads', async () => {
  const r = await authedFetch(idToken, '/uploads', {
    method: 'POST',
    body:   JSON.stringify({ filename: 'sample.pdf' }),
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const body = await r.json();
  console.log(`   jobId: ${body.jobId}`);
  return body;
});

// 4. PUT the PDF to S3
await step('PUT sample.pdf to S3', async () => {
  const pdf = readFileSync(fixturePath);
  const r = await fetch(uploadUrl, {
    method:  'PUT',
    headers: {
      'Content-Type':   'application/pdf',
      'Content-Length': String(pdf.length),
    },
    body: pdf,
  });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
});

// 5. Poll until terminal state
const POLL_MS       = 3_000;
const POLL_BUDGET   = 120_000;
const startedAt     = Date.now();
const topicId = await step('Poll GET /jobs/{jobId}', async () => {
  while (Date.now() - startedAt < POLL_BUDGET) {
    await new Promise(r => setTimeout(r, POLL_MS));
    const r = await authedFetch(idToken, `/jobs/${jobId}`);
    if (!r.ok) { console.log(`   transient ${r.status}, retrying`); continue; }
    const body = await r.json();
    console.log(`   status: ${body.status}`);
    if (body.status === 'complete') return body.topicId;
    if (body.status === 'failed')   throw new Error(`job failed: ${JSON.stringify(body.error)}`);
  }
  throw new Error(`did not complete within ${POLL_BUDGET / 1000}s`);
});

// 6. Fetch topic detail
await step('GET /topics/{topicId}', async () => {
  const r = await authedFetch(idToken, `/topics/${topicId}`);
  if (!r.ok) throw new Error(`${r.status}`);
  const topic = await r.json();
  if (!topic.title)                                      throw new Error('missing title');
  if (!Array.isArray(topic.quizQuestions) || topic.quizQuestions.length !== 25)
    throw new Error(`expected 25 quiz questions, got ${topic.quizQuestions?.length}`);
  if (!Array.isArray(topic.keyTerms) || topic.keyTerms.length < 10)
    throw new Error(`expected ≥10 key terms, got ${topic.keyTerms?.length}`);
  console.log(`   title: ${topic.title}`);
});

// 7. POST an attempt
await step('POST /topics/{topicId}/attempts', async () => {
  const r = await authedFetch(idToken, `/topics/${topicId}/attempts`, {
    method: 'POST',
    body:   JSON.stringify({ length: 'short', score: 8, total: 10 }),
  });
  if (r.status !== 201) throw new Error(`expected 201, got ${r.status}`);
});

// 8. GET attempts history
await step('GET /topics/{topicId}/attempts', async () => {
  const r = await authedFetch(idToken, `/topics/${topicId}/attempts`);
  if (!r.ok) throw new Error(`${r.status}`);
  const list = await r.json();
  if (!Array.isArray(list) || list.length < 1) throw new Error('history empty');
  console.log(`   ${list.length} attempt(s) recorded`);
});

console.log('\n✅ Smoke test passed');
