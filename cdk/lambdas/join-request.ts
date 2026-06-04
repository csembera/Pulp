import {
  DynamoDBClient,
  PutItemCommand,
  ConditionalCheckFailedException,
} from '@aws-sdk/client-dynamodb';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { timingSafeEqual } from 'crypto';

const dynamo = new DynamoDBClient({});
const sns    = new SNSClient({});
const TABLE_NAME           = process.env.TABLE_NAME!;
const ALARMS_TOPIC_ARN     = process.env.ALARMS_TOPIC_ARN;
const ORIGIN_VERIFY_SECRET = process.env.ORIGIN_VERIFY_SECRET;

const RECEIVED_RESPONSE: APIGatewayProxyResultV2 = {
  statusCode: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: 'Request received' }),
};

// Without CloudFront's injected secret header, the request bypassed the WAF.
// Unset secret = allow (local/test).
function fromCloudFront(event: APIGatewayProxyEventV2): boolean {
  if (!ORIGIN_VERIFY_SECRET) return true;
  const provided = event.headers?.['x-origin-verify'];
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(ORIGIN_VERIFY_SECRET);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  if (!fromCloudFront(event)) return RECEIVED_RESPONSE;

  let email: string | undefined;

  try {
    const body = JSON.parse(event.body ?? '{}') as { email?: string };
    email = body.email?.toLowerCase().trim();
  } catch {
    // Malformed JSON — still return 200 to avoid enumeration.
  }

  // Always return 200 regardless of outcome to prevent email enumeration.
  if (email) {
    const createdAt = new Date().toISOString();
    let recorded = false;

    try {
      // Write only when absent or previously rejected; approved/pending survive replays.
      await dynamo.send(new PutItemCommand({
        TableName: TABLE_NAME,
        Item: {
          PK:        { S: `JOINREQ#${email}` },
          SK:        { S: 'REQUEST' },
          status:    { S: 'pending' },
          createdAt: { S: createdAt },
        },
        ConditionExpression: 'attribute_not_exists(PK) OR #s = :rejected',
        ExpressionAttributeNames:  { '#s': 'status' },
        ExpressionAttributeValues: { ':rejected': { S: 'rejected' } },
      }));
      recorded = true;
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) {
        console.error(JSON.stringify({ message: 'Failed to write join request', email, err }));
      }
    }

    if (recorded && ALARMS_TOPIC_ARN) {
      try {
        await sns.send(new PublishCommand({
          TopicArn: ALARMS_TOPIC_ARN,
          Subject: 'Pulp: new invite request',
          Message:
            `Pending invite request received.\n\n` +
            `Email: ${email}\n` +
            `At:    ${createdAt}\n\n` +
            `Approve:  make admin-create-user EMAIL=${email}\n` +
            `Reject:   make reject-request EMAIL=${email}\n` +
            `List all: make list-requests\n`,
        }));
      } catch (err) {
        console.error(JSON.stringify({ message: 'Failed to publish join-request notification', email, err }));
      }
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: 'Request received' }),
  };
}
