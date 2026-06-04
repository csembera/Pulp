import {
  DynamoDBClient,
  GetItemCommand,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

const dynamo = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;

const VALID_LENGTHS = new Set(['short', 'medium', 'long']);

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
  const userId  = event.requestContext.authorizer.jwt.claims['sub'] as string;
  const topicId = event.pathParameters?.topicId;
  if (!topicId) return json(400, { message: 'topicId is required' });

  // Ownership check — topic must belong to this user.
  const topicResult = await dynamo.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: { S: `USER#${userId}` },
      SK: { S: `TOPIC#${topicId}` },
    },
  }));
  if (!topicResult.Item) return json(404, { message: 'Topic not found' });

  if (event.requestContext.http.method === 'POST') {
    return postAttempt(userId, topicId, event.body);
  }
  return getAttempts(userId, topicId);
}

async function postAttempt(
  userId: string,
  topicId: string,
  rawBody: string | undefined,
): Promise<APIGatewayProxyResultV2> {
  let body: { length?: string; score?: number; total?: number };
  try {
    body = JSON.parse(rawBody ?? '{}');
  } catch {
    return json(400, { message: 'Invalid JSON body' });
  }

  const { length, score, total } = body;

  if (!length || !VALID_LENGTHS.has(length)) {
    return json(400, { message: 'length must be short, medium, or long' });
  }
  if (typeof score !== 'number' || typeof total !== 'number' || score > total || score < 0) {
    return json(400, { message: 'score and total are required; score must be 0..total' });
  }

  const timestamp = new Date().toISOString();

  await dynamo.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      PK:        { S: `USER#${userId}` },
      SK:        { S: `ATTEMPT#${topicId}#${timestamp}` },
      topicId:   { S: topicId },
      userId:    { S: userId },
      length:    { S: length },
      score:     { N: String(score) },
      total:     { N: String(total) },
      timestamp: { S: timestamp },
    },
  }));

  // Denormalize lastStudiedAt onto the topic — avoids an N+1 on the library list.
  await dynamo.send(new UpdateItemCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: { S: `USER#${userId}` },
      SK: { S: `TOPIC#${topicId}` },
    },
    UpdateExpression: 'SET lastStudiedAt = :ts',
    ConditionExpression: 'attribute_exists(PK)',
    ExpressionAttributeValues: { ':ts': { S: timestamp } },
  }));

  return json(201, { timestamp });
}

async function getAttempts(userId: string, topicId: string): Promise<APIGatewayProxyResultV2> {
  const result = await dynamo.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
    ExpressionAttributeValues: {
      ':pk':     { S: `USER#${userId}` },
      ':prefix': { S: `ATTEMPT#${topicId}#` },
    },
    ScanIndexForward: false, // newest first (ISO timestamps sort lexicographically)
  }));

  const items = (result.Items ?? []).map(item => ({
    timestamp: item.timestamp?.S,
    length:    item.length?.S,
    score:     Number(item.score?.N),
    total:     Number(item.total?.N),
  }));

  return json(200, items);
}
