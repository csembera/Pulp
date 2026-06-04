import {
  DynamoDBClient,
  UpdateItemCommand,
  PutItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
  BedrockRuntimeClient,
  ConverseCommand,
} from '@aws-sdk/client-bedrock-runtime';
import type { SQSEvent, SQSRecord } from 'aws-lambda';
import { validateQuiz, validateKeyTerms, validateSummary } from './schemas';

const dynamo = new DynamoDBClient({});
const s3      = new S3Client({});
const bedrock = new BedrockRuntimeClient({});

const TABLE_NAME = process.env.TABLE_NAME!;
// Durable TTL a job is promoted to once its file is confirmed in S3 (replaces the short pending TTL).
const JOB_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days
// Cross-region inference profile (Nova 2 Lite).
const MODEL_ID = 'us.amazon.nova-2-lite-v1:0';

// Output cap — fits the quiz, the largest of the three responses.
const MAX_OUTPUT_TOKENS = 4096;

export const QUIZ_PROMPT = `Write exactly 25 multiple-choice questions testing deep understanding of this document.

Rules for every question:
- Grounded in a specific claim, number, definition, or example from the document.
- Ask about the subject matter directly — never "according to the document" or "what does the text say".
- All four options have the same length (target 8–14 words each, longest ≤ 1.3× shortest), same grammatical shape, same level of detail.
- Distractors are plausible domain-adjacent errors (wrong number, swapped cause/effect, common misconception). No joke options, no "all/none of the above".
- Exactly one option is correct.

Spread coverage across the whole document; mix definitional, mechanism, quantitative, tradeoff, and applied questions.

Return ONLY this JSON (no markdown):
[{"question":"...","options":["A","B","C","D"],"correctIndex":0},...]
Exactly 4 options per question. correctIndex is 0, 1, 2, or 3.`;

export const KEY_TERMS_PROMPT = `You are building a glossary of the 10–15 most load-bearing terms in this document — the concepts a reader must understand to reason about the material afterward.

Selection:
- Prefer terms that carry specific technical meaning in the document's domain (named mechanisms, proper-noun systems, domain-specific metrics, defined acronyms).
- Skip generic vocabulary that a reader would already know (e.g., "database", "user", "process") unless the document gives it a non-obvious specialized meaning.
- If the document defines an acronym or coined phrase, include it.

Definitions:
- Write each definition in the document's own framing — what it means HERE, in this material — not a generic dictionary entry.
- One to two sentences. Concrete over abstract. Mention the role the term plays in the document's argument or system when relevant.
- Do NOT start definitions with "The document says" or "According to the text". State the meaning directly.

Return a JSON array with exactly this structure (no markdown, no extra text):
[{"term":"...","definition":"..."},...]
Include between 10 and 15 terms inclusive. Each term and definition must be non-empty.`;

export const SUMMARY_PROMPT = `You are an expert educator. Write a comprehensive summary of this document.
Return a JSON object with exactly this structure (no markdown, no extra text):
{"title":"...","sections":[{"heading":"...","content":"..."},...]}
Include 3 to 5 sections. Title must be a concise document title.`;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// One retry loop, two failure classes: transport errors back off; schema errors
// re-prompt with the validator message appended so the model can self-correct.
export async function invokeAndValidate<T>(
  basePrompt: string,
  validate: (raw: string) => T,
  pdfS3Uri: string,
  maxRetries = 3,
): Promise<T> {
  let attempt = 0;
  let schemaHint: string | null = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const prompt = schemaHint
      ? `${basePrompt}\n\nYour previous attempt was rejected with this error: "${schemaHint}". Fix that issue and return ONLY valid JSON matching the schema above.`
      : basePrompt;

    let rawText: string;
    try {
      const response = await bedrock.send(new ConverseCommand({
        modelId: MODEL_ID,
        inferenceConfig: { maxTokens: MAX_OUTPUT_TOKENS },
        messages: [{
          role: 'user',
          content: [
            {
              document: {
                format: 'pdf',
                name: 'document',
                source: { s3Location: { uri: pdfS3Uri } } as never,
              },
            },
            { text: prompt },
          ],
        }],
      }));

      const text = response.output?.message?.content
        ?.find((b): b is { text: string } => 'text' in b)
        ?.text;
      if (!text) throw new Error('Empty Bedrock response');
      rawText = text;
    } catch (err: unknown) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      const isRetryable =
        e.name === 'ThrottlingException' ||
        (e.$metadata?.httpStatusCode !== undefined && e.$metadata.httpStatusCode >= 500);

      if (!isRetryable || attempt >= maxRetries) throw err;

      const backoffMs = Math.pow(2, attempt) * 100 + Math.random() * 100;
      await sleep(backoffMs);
      attempt++;
      continue;
    }

    try {
      return validate(rawText);
    } catch (err: unknown) {
      if (attempt >= maxRetries) throw err;
      schemaHint = err instanceof Error ? err.message : String(err);
      attempt++;
    }
  }
}

// Emit the JobsFailed metric via EMF (structured log line — no PutMetricData/IAM).
function emitJobFailedMetric(reason: string): void {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: 'Pulp',
        Dimensions: [[]],
        Metrics: [{ Name: 'JobsFailed', Unit: 'Count' }],
      }],
    },
    JobsFailed: 1,
    reason,
  }));
}

async function setJobFailed(userId: string, jobId: string, errors: Record<string, string>): Promise<void> {
  await dynamo.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: { S: `USER#${userId}` },
      SK: { S: `JOB#${jobId}` },
    },
    UpdateExpression: 'SET #status = :failed, errorDetails = :errors, failedAt = :now',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':failed': { S: 'failed' },
      ':errors': { S: JSON.stringify(errors) },
      ':now':    { S: new Date().toISOString() },
    },
  }));

  // After the row is persisted, so metric and state stay in sync.
  emitJobFailedMetric(Object.keys(errors).join(','));
}

function parseKey(key: string): { userId: string; jobId: string } {
  const decoded = decodeURIComponent(key.replace(/\+/g, ' '));
  // uploads/{userId}/{jobId}.pdf
  const parts = decoded.split('/');
  return {
    userId: parts[1],
    jobId: parts[2].replace(/\.pdf$/i, ''),
  };
}

async function processRecord(record: SQSRecord): Promise<void> {
  const body = JSON.parse(record.body) as {
    Records: Array<{
      s3: { bucket: { name: string }; object: { key: string } };
    }>;
  };
  const s3Record = body.Records[0];
  const bucket = s3Record.s3.bucket.name;
  const key = s3Record.s3.object.key;
  const { userId, jobId } = parseKey(key);

  const pdfS3Uri = `s3://${bucket}/${key}`;

  // pending → processing: claims the job (failed condition = duplicate delivery →
  // discard) and promotes the TTL now the file is confirmed in S3.
  try {
    await dynamo.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `USER#${userId}` },
        SK: { S: `JOB#${jobId}` },
      },
      UpdateExpression: 'SET #status = :processing, processingStartedAt = :now, expiresAt = :ttl',
      ConditionExpression: '#status = :pending',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':processing': { S: 'processing' },
        ':pending':    { S: 'pending' },
        ':now':        { S: new Date().toISOString() },
        ':ttl':        { N: String(Math.floor(Date.now() / 1000) + JOB_TTL_SECONDS) },
      },
    }));
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) {
      return;
    }
    throw err;
  }

  // Two-phase fan-out so Bedrock prompt caching pays off: the summary primes
  // the cache (PDF = cacheable prefix), then quiz + keyTerms reuse it. Parallel
  // would miss the cache on every call.
  const [summaryResult] = await Promise.allSettled([
    invokeAndValidate(SUMMARY_PROMPT, validateSummary, pdfS3Uri),
  ]);

  const [quizResult, keyTermsResult] = await Promise.allSettled([
    invokeAndValidate(QUIZ_PROMPT,      validateQuiz,     pdfS3Uri),
    invokeAndValidate(KEY_TERMS_PROMPT, validateKeyTerms, pdfS3Uri),
  ]);

  const errors: Record<string, string> = {};
  if (quizResult.status     === 'rejected') errors.quiz     = String(quizResult.reason);
  if (keyTermsResult.status === 'rejected') errors.keyTerms = String(keyTermsResult.reason);
  if (summaryResult.status  === 'rejected') errors.summary  = String(summaryResult.reason);

  if (Object.keys(errors).length > 0) {
    await setJobFailed(userId, jobId, errors);
    return;
  }

  const quiz     = (quizResult     as PromiseFulfilledResult<ReturnType<typeof validateQuiz>>).value;
  const keyTerms = (keyTermsResult as PromiseFulfilledResult<ReturnType<typeof validateKeyTerms>>).value;
  const summary  = (summaryResult  as PromiseFulfilledResult<ReturnType<typeof validateSummary>>).value;

  // All valid — write content to S3, then the metadata-only Topic row, mark the job
  // complete, and delete the source PDF. Content is written first so a visible Topic
  // row always implies its content object exists.
  const topicId    = jobId; // reuse job UUID as topic ID
  const now        = new Date().toISOString();
  const contentKey = `topics/${userId}/${topicId}.json`;

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: contentKey,
    ContentType: 'application/json',
    Body: JSON.stringify({ summary, quizQuestions: quiz, keyTerms }),
  }));

  await dynamo.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      PK:         { S: `USER#${userId}` },
      SK:         { S: `TOPIC#${topicId}` },
      topicId:    { S: topicId },
      userId:     { S: userId },
      jobId:      { S: jobId },
      title:      { S: summary!.title },
      contentKey: { S: contentKey },
      createdAt:  { S: now },
      status:     { S: 'complete' },
    },
  }));

  await dynamo.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: { S: `USER#${userId}` },
      SK: { S: `JOB#${jobId}` },
    },
    UpdateExpression: 'SET #status = :complete, topicId = :topicId, completedAt = :now',
    ConditionExpression: '#status = :processing',
    ExpressionAttributeNames: { '#status': 'status' },
    ExpressionAttributeValues: {
      ':complete':   { S: 'complete' },
      ':processing': { S: 'processing' },
      ':topicId':    { S: topicId },
      ':now':        { S: now },
    },
  }));

  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export async function handler(event: SQSEvent): Promise<void> {
  for (const record of event.Records) {
    await processRecord(record);
  }
}
