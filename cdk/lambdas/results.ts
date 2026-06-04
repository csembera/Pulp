import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyResultV2 } from 'aws-lambda';

const dynamo = new DynamoDBClient({});
const TABLE_NAME = process.env.TABLE_NAME!;

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
  const jobId  = event.pathParameters?.jobId;

  if (!jobId) return json(400, { message: 'jobId is required' });

  const result = await dynamo.send(new GetItemCommand({
    TableName: TABLE_NAME,
    Key: {
      PK: { S: `USER#${userId}` },
      SK: { S: `JOB#${jobId}` },
    },
  }));

  if (!result.Item) return json(404, { message: 'Not found' });

  const status = result.Item.status?.S ?? 'unknown';
  const response: Record<string, unknown> = { status };

  if (status === 'complete') {
    response.topicId = result.Item.topicId?.S;
  }
  if (status === 'failed') {
    const raw = result.Item.errorDetails?.S;
    response.error = raw ? JSON.parse(raw) : null;
  }

  return json(200, response);
}
