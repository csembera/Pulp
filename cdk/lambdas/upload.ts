import { DynamoDBClient, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';
import { randomUUID } from 'crypto';

const dynamo = new DynamoDBClient({});
const s3 = new S3Client({});

const TABLE_NAME = process.env.TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB
// Short TTL — a requested-but-never-uploaded job self-expires; the processor
// promotes it to durable retention once the file lands (on pending → processing).
const PENDING_TTL_SECONDS = 60 * 60; // 1 h
// Per-user topic cap (completed topics only).
const MAX_TOPICS_PER_USER = 5;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function formatMB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyResultV2> {
  // Extract authenticated user ID from JWT claims (injected by API Gateway).
  const userId = event.requestContext.authorizer.jwt.claims['sub'] as string | undefined;
  if (!userId) {
    return json(401, { message: 'Unauthorized' });
  }

  let filename: string | undefined;
  let fileSize: number | undefined;
  try {
    const body = JSON.parse(event.body ?? '{}') as { filename?: string; fileSize?: number };
    filename = body.filename?.trim();
    fileSize = body.fileSize;
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  if (!filename) {
    return json(400, { message: 'filename is required' });
  }

  if (!filename.toLowerCase().endsWith('.pdf')) {
    return json(400, { message: 'Only .pdf files are accepted.' });
  }

  if (typeof fileSize !== 'number' || !Number.isFinite(fileSize) || !Number.isInteger(fileSize) || fileSize <= 0) {
    return json(400, { message: 'fileSize is required and must be a positive integer (bytes).' });
  }

  if (fileSize > MAX_BYTES) {
    return json(413, {
      message: `This PDF is ${formatMB(fileSize)} — Pulp accepts files up to ${formatMB(MAX_BYTES)}. Please upload a smaller PDF.`,
    });
  }

  // COUNT query — counts matching keys without retrieving items.
  const topicCountResult = await dynamo.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: {
      ':pk':     { S: `USER#${userId}` },
      ':prefix': { S: 'TOPIC#' },
    },
    Select: 'COUNT',
  }));
  const topicCount = topicCountResult.Count ?? 0;

  if (topicCount >= MAX_TOPICS_PER_USER) {
    return json(409, {
      message: `You've reached the ${MAX_TOPICS_PER_USER}-topic limit. Delete a topic from your library before uploading another PDF.`,
      code:    'TOPIC_LIMIT_REACHED',
      limit:   MAX_TOPICS_PER_USER,
      current: topicCount,
    });
  }

  const jobId = randomUUID();
  const s3Key = `uploads/${userId}/${jobId}.pdf`;
  const now = new Date();
  const expiresAt = Math.floor(now.getTime() / 1000) + PENDING_TTL_SECONDS;

  // Presigned PUT — Content-Type/Length are signed, so S3 enforces them.
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: s3Key,
      ContentType: 'application/pdf',
      ContentLength: fileSize,
    }),
    {
      expiresIn: 900, // 15 minutes
      signableHeaders: new Set(['content-type', 'content-length']),
    },
  );

  // Pending job row — short TTL self-expires if the upload never lands.
  await dynamo.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      PK:        { S: `USER#${userId}` },
      SK:        { S: `JOB#${jobId}` },
      jobId:     { S: jobId },
      userId:    { S: userId },
      s3Key:     { S: s3Key },
      status:    { S: 'pending' },
      createdAt: { S: now.toISOString() },
      expiresAt: { N: String(expiresAt) },
    },
    // UUID collision guard.
    ConditionExpression: 'attribute_not_exists(PK)',
  }));

  return json(200, { uploadUrl, jobId });
}
