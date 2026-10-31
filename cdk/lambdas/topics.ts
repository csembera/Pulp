import {
  BatchWriteItemCommand,
  DeleteItemCommand,
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  type WriteRequest,
} from '@aws-sdk/client-dynamodb';
import { S3Client, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

const dynamo = new DynamoDBClient({});
const s3     = new S3Client({});
const TABLE_NAME  = process.env.TABLE_NAME!;
const BUCKET_NAME = process.env.BUCKET_NAME!;

const MAX_TITLE_LENGTH = 200;

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

export async function handler(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
): Promise<APIGatewayProxyResultV2> {
  const userId = event.requestContext.authorizer.jwt.claims['sub'] as string;
  const method = event.requestContext.http.method;

  // DELETE /jobs/{jobId} — cancel an in-flight upload job
  const jobId = event.pathParameters?.jobId;
  if (jobId) {
    if (method === 'DELETE') return cancelJob(userId, jobId);
    return json(405, { message: 'Method not allowed' });
  }

  const topicId = event.pathParameters?.topicId;
  if (!topicId) return getList(userId);

  switch (method) {
    case 'GET':    return getDetail(userId, topicId);
    case 'PATCH':  return renameTopic(userId, topicId, event.body);
    case 'DELETE': return deleteTopic(userId, topicId);
    default:       return json(405, { message: 'Method not allowed' });
  }
}

async function getList(userId: string): Promise<APIGatewayProxyResultV2> {
  const result = await dynamo.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: {
      ':pk':     { S: `USER#${userId}` },
      ':prefix': { S: 'TOPIC#' },
    },
  }));

  const items = (result.Items ?? [])
    .map(item => ({
      topicId:       item.topicId?.S,
      title:         item.title?.S,
      createdAt:     item.createdAt?.S,
      status:        item.status?.S,
      lastStudiedAt: item.lastStudiedAt?.S,
    }))
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));

  return json(200, items);
}

async function getDetail(userId: string, topicId: string): Promise<APIGatewayProxyResultV2> {
  const result = await dynamo.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: { S: `USER#${userId}` },
      SK: { S: `TOPIC#${topicId}` },
    },
  }));

  if (!result.Item) return json(404, { message: 'Not found' });
  const item = result.Item;

  // Content (summary / quiz / keyTerms) lives in S3; the row holds only the pointer.
  let content: unknown = { summary: null, quizQuestions: [], keyTerms: [] };
  const contentKey = item.contentKey?.S;
  if (contentKey) {
    const obj = await s3.send(new GetObjectCommand({ Bucket: BUCKET_NAME, Key: contentKey }));
    content = JSON.parse(await obj.Body!.transformToString());
  }

  return json(200, {
    topicId:   item.topicId?.S,
    title:     item.title?.S,
    createdAt: item.createdAt?.S,
    ...(content as object),
  });
}

async function renameTopic(
  userId: string,
  topicId: string,
  rawBody: string | undefined,
): Promise<APIGatewayProxyResultV2> {
  let body: { title?: unknown };
  try {
    body = JSON.parse(rawBody ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  if (typeof body.title !== 'string') {
    return json(400, { message: 'title is required and must be a string' });
  }
  const title = body.title.trim();
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH) {
    return json(400, { message: `title must be 1..${MAX_TITLE_LENGTH} characters` });
  }

  try {
    await dynamo.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `USER#${userId}` },
        SK: { S: `TOPIC#${topicId}` },
      },
      UpdateExpression: 'SET title = :title',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeValues: { ':title': { S: title } },
    }));
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      return json(404, { message: 'Topic not found' });
    }
    throw err;
  }

  return json(200, { topicId, title });
}

// Core deletion logic shared by deleteTopic and cancelJob.
async function eraseTopicData(userId: string, topicId: string, contentKey: string | undefined): Promise<void> {
  const attemptKeys: { PK: { S: string }; SK: { S: string } }[] = [];
  let exclusiveStartKey: Record<string, { S: string }> | undefined;
  do {
    const page = await dynamo.send(new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: {
        ':pk':     { S: `USER#${userId}` },
        ':prefix': { S: `ATTEMPT#${topicId}#` },
      },
      ProjectionExpression: 'PK, SK',
      ExclusiveStartKey: exclusiveStartKey,
    }));
    for (const item of page.Items ?? []) {
      if (item.PK?.S && item.SK?.S) {
        attemptKeys.push({ PK: { S: item.PK.S }, SK: { S: item.SK.S } });
      }
    }
    exclusiveStartKey = page.LastEvaluatedKey as Record<string, { S: string }> | undefined;
  } while (exclusiveStartKey);

  for (let i = 0; i < attemptKeys.length; i += 25) {
    const chunk = attemptKeys.slice(i, i + 25);
    const requests: WriteRequest[] = chunk.map(Key => ({ DeleteRequest: { Key } }));
    await dynamo.send(new BatchWriteItemCommand({
      RequestItems: { [TABLE_NAME]: requests },
    }));
  }

  await dynamo.send(new DeleteItemCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: { S: `USER#${userId}` },
      SK: { S: `TOPIC#${topicId}` },
    },
  }));

  // Remove the S3 content last — an orphaned object on partial failure is benign.
  if (contentKey) {
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET_NAME, Key: contentKey }));
  }
}

async function deleteTopic(userId: string, topicId: string): Promise<APIGatewayProxyResultV2> {
  const topicResult = await dynamo.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: { S: `USER#${userId}` },
      SK: { S: `TOPIC#${topicId}` },
    },
    ProjectionExpression: 'PK, contentKey',
  }));
  if (!topicResult.Item) return json(404, { message: 'Topic not found' });

  await eraseTopicData(userId, topicId, topicResult.Item.contentKey?.S);
  return json(204, null);
}

// Marks a job cancelled and removes any topic the processor already wrote.
// topicId === jobId (the processor reuses the job UUID), so we can look it up directly.
// Idempotent: returns 200 whether or not the job existed.
async function cancelJob(userId: string, jobId: string): Promise<APIGatewayProxyResultV2> {
  try {
    await dynamo.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `USER#${userId}` },
        SK: { S: `JOB#${jobId}` },
      },
      UpdateExpression: 'SET #status = :cancelled, cancelledAt = :now',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':cancelled': { S: 'cancelled' },
        ':now':       { S: new Date().toISOString() },
      },
    }));
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // Job expired or never existed — nothing to cancel.
      return json(200, { cancelled: true });
    }
    throw err;
  }

  // If the processor already wrote the topic before this cancel arrived, delete it.
  const topicResult = await dynamo.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: { S: `USER#${userId}` },
      SK: { S: `TOPIC#${jobId}` },
    },
    ProjectionExpression: 'PK, contentKey',
  }));

  if (topicResult.Item) {
    await eraseTopicData(userId, jobId, topicResult.Item.contentKey?.S);
  }

  return json(200, { cancelled: true });
}
