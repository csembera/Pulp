#!/usr/bin/env node
/**
 * Dump a topic's full processing output (summary, keyTerms, quizQuestions)
 * straight from DynamoDB so you can diff the artifacts of two upload runs.
 *
 * Usage:
 *   node scripts/get-topic.mjs --email user@example.com
 *     # lists this user's topics with id, title, createdAt, status, model
 *
 *   node scripts/get-topic.mjs --email user@example.com --topic-id <uuid>
 *     # dumps the full topic JSON
 *
 *   node scripts/get-topic.mjs --user-id <cognito-sub> --topic-id <uuid>
 *     # same, skips the Cognito email→sub lookup
 *
 *   node scripts/get-topic.mjs --email user@example.com --topic-id <uuid> \
 *       --section summary
 *     # dumps a single section: summary | keyTerms | quizQuestions | meta
 *
 *   node scripts/get-topic.mjs --email user@example.com --topic-id <uuid> > out.json
 *     # pipe to jq, diff, etc.
 *
 * Flags:
 *   --email <addr>            Resolve to userId via Cognito AdminGetUser.
 *   --user-id <sub>           Skip Cognito lookup; use this sub directly.
 *   --topic-id <uuid>         If omitted, lists the user's topics.
 *   --section <name>          Print only one of: summary, keyTerms, quizQuestions, meta.
 *   --user-pool-id <id>       Override Cognito pool (default: read from cdk/outputs.json).
 *   --table <name>            Override table (default: PULP_TABLE_NAME or pulp-table).
 *   --region <region>         AWS region (default: AWS_REGION or us-east-1).
 *   --raw                     Print raw DynamoDB AttributeValue shapes (skips unmarshalling).
 *   --help                    Show this message.
 *
 * Reads cdk/outputs.json for UserPoolId when --email is used and the pool
 * isn't passed explicitly. The DynamoDB table name is hard-coded to
 * `pulp-table` in the stack but can be overridden with --table.
 */

import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createRequire } from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const cdkMods   = resolve(__dirname, '../cdk/node_modules');
const require   = createRequire(pathToFileURL(join(cdkMods, 'sentinel')));

const { CognitoIdentityProviderClient, AdminGetUserCommand } =
  require('@aws-sdk/client-cognito-identity-provider');
const { DynamoDBClient, GetItemCommand, QueryCommand } =
  require('@aws-sdk/client-dynamodb');

// Minimal AttributeValue → JS unmarshaller. Avoids depending on
// @aws-sdk/util-dynamodb (not in cdk/node_modules). Covers the types we
// actually store: S, N, BOOL, NULL, L, M, SS, NS.
function unmarshalAv(v) {
  if (v == null) return null;
  if ('S'    in v) return v.S;
  if ('N'    in v) return Number(v.N);
  if ('BOOL' in v) return v.BOOL;
  if ('NULL' in v) return null;
  if ('L'    in v) return v.L.map(unmarshalAv);
  if ('M'    in v) return unmarshall(v.M);
  if ('SS'   in v) return v.SS;
  if ('NS'   in v) return v.NS.map(Number);
  return v;
}
function unmarshall(item) {
  const out = {};
  for (const [k, v] of Object.entries(item ?? {})) out[k] = unmarshalAv(v);
  return out;
}

// ── arg parsing ─────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h')        { out.help = true; continue; }
    if (a === '--raw')                       { out.raw = true; continue; }
    if (a === '--email')                     { out.email      = argv[++i]; continue; }
    if (a === '--user-id')                   { out.userId     = argv[++i]; continue; }
    if (a === '--topic-id')                  { out.topicId    = argv[++i]; continue; }
    if (a === '--section')                   { out.section    = argv[++i]; continue; }
    if (a === '--user-pool-id')              { out.userPoolId = argv[++i]; continue; }
    if (a === '--table')                     { out.table      = argv[++i]; continue; }
    if (a === '--region')                    { out.region     = argv[++i]; continue; }
    throw new Error(`Unknown argument: ${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  // Print the file's leading comment block.
  const src = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const m   = src.match(/\/\*\*([\s\S]*?)\*\//);
  console.log(m ? m[1].replace(/^\s*\* ?/gm, '').trim() : '(see source for usage)');
  process.exit(0);
}

if (!args.email && !args.userId) {
  console.error('Error: --email or --user-id is required. Use --help for usage.');
  process.exit(2);
}
if (args.section &&
    !['summary', 'keyTerms', 'quizQuestions', 'meta'].includes(args.section)) {
  console.error(`Error: --section must be one of summary, keyTerms, quizQuestions, meta`);
  process.exit(2);
}

const region    = args.region || process.env.AWS_REGION || 'us-east-1';
const tableName = args.table  || process.env.PULP_TABLE_NAME || 'pulp-table';

// ── resolve userPoolId (only if needed) ─────────────────────────────────
function readOutputs() {
  const path = resolve(__dirname, '../cdk/outputs.json');
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

async function resolveUserId() {
  if (args.userId) return args.userId;

  let poolId = args.userPoolId;
  if (!poolId) {
    const outputs = readOutputs();
    poolId = outputs?.PulpDataStack?.UserPoolId;
  }
  if (!poolId) {
    throw new Error('Cognito User Pool ID not found — pass --user-pool-id or run `make deploy-backend` to populate cdk/outputs.json.');
  }

  const cognito = new CognitoIdentityProviderClient({ region });
  const result  = await cognito.send(new AdminGetUserCommand({
    UserPoolId: poolId,
    Username:   args.email,
  }));
  const subAttr = result.UserAttributes?.find(a => a.Name === 'sub');
  if (!subAttr?.Value) {
    throw new Error(`No 'sub' attribute on Cognito user ${args.email}.`);
  }
  return subAttr.Value;
}

// ── dynamo helpers ──────────────────────────────────────────────────────
const dynamo = new DynamoDBClient({ region });

async function listTopics(userId) {
  const result = await dynamo.send(new QueryCommand({
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: {
      ':pk':     { S: `USER#${userId}` },
      ':prefix': { S: 'TOPIC#' },
    },
    ProjectionExpression: 'topicId, title, createdAt, #s, jobId, pdfBucket, pdfKey',
    ExpressionAttributeNames: { '#s': 'status' },
  }));
  return (result.Items ?? [])
    .map(item => args.raw ? item : unmarshall(item))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
}

async function getTopic(userId, topicId) {
  const result = await dynamo.send(new GetItemCommand({
    TableName: tableName,
    Key: {
      PK: { S: `USER#${userId}` },
      SK: { S: `TOPIC#${topicId}` },
    },
  }));
  if (!result.Item) return null;
  if (args.raw) return result.Item;

  const item = unmarshall(result.Item);
  // The artifacts are stored as JSON-stringified blobs — parse them so the
  // output is directly diffable. Failed parses are surfaced rather than
  // silently swallowed.
  for (const key of ['summary', 'quizQuestions', 'keyTerms']) {
    if (typeof item[key] === 'string') {
      try { item[key] = JSON.parse(item[key]); }
      catch (e) { item[`__${key}_parse_error`] = e.message; }
    }
  }
  return item;
}

function project(topic) {
  if (!args.section || args.raw) return topic;
  if (args.section === 'meta') {
    return {
      topicId:   topic.topicId,
      title:     topic.title,
      createdAt: topic.createdAt,
      status:    topic.status,
      jobId:     topic.jobId,
      userId:    topic.userId,
      pdfBucket: topic.pdfBucket,
      pdfKey:    topic.pdfKey,
    };
  }
  return topic[args.section];
}

// ── run ─────────────────────────────────────────────────────────────────
(async () => {
  const userId = await resolveUserId();

  if (!args.topicId) {
    const topics = await listTopics(userId);
    if (topics.length === 0) {
      console.error(`(no topics for ${args.email ?? userId})`);
      process.exit(0);
    }
    console.log(JSON.stringify({ userId, count: topics.length, topics }, null, 2));
    return;
  }

  const topic = await getTopic(userId, args.topicId);
  if (!topic) {
    console.error(`Topic ${args.topicId} not found for user ${args.email ?? userId}.`);
    process.exit(1);
  }
  console.log(JSON.stringify(project(topic), null, 2));
})().catch(err => {
  console.error(`Error: ${err.message ?? err}`);
  process.exit(1);
});
