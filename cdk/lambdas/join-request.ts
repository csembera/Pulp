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

  let email:   string | undefined;
  let name:    string | undefined;
  let source:  string | undefined;
  let company: string | undefined;

  try {
    const body = JSON.parse(event.body ?? '{}') as {
      email?: string; name?: string; source?: string; company?: string;
    };
    email = body.email?.toLowerCase().trim();
    // name/source/company arrive from a public form. An SNS Subject must be
    // single-line ASCII, so `source` is slug-validated and only ever used to
    // pick from a fixed set of subjects; `name` and `company` are stripped of
    // control characters and kept out of the Subject entirely.
    source  = /^[a-z0-9-]{1,32}$/.test(body.source ?? '') ? body.source : undefined;
    name    = body.name?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || undefined;
    company = body.company?.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || undefined;
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
          ...(source  ? { source:  { S: source  } } : {}),
          ...(name    ? { name:    { S: name    } } : {}),
          ...(company ? { company: { S: company } } : {}),
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
        // Both TICK surfaces are TICK requests. `tick` is the product page at
        // tick.sembasolutions.com, `tick-demo` its public demo — before, only
        // the demo was recognised, so every request from the product page was
        // announced as a Pulp invite.
        // Subject is chosen from a fixed set — never interpolated from input.
        const isTick = source === 'tick' || source === 'tick-demo';

        await sns.send(new PublishCommand({
          TopicArn: ALARMS_TOPIC_ARN,
          Subject: source === 'tick'      ? 'TICK: new access request'
                 : source === 'tick-demo' ? 'TICK demo: new access request'
                 : 'Pulp: new invite request',
          Message:
            `${isTick ? 'TICK access' : 'Pending invite'} request received.\n\n` +
            `Email:   ${email}\n` +
            (name    ? `Name:    ${name}\n`    : '') +
            (company ? `Company: ${company}\n` : '') +
            (source  ? `Source:  ${source}\n`  : '') +
            `At:      ${createdAt}\n\n` +
            `Approve:  make admin-create-user EMAIL=${email}\n` +
            (isTick
              ? `          ...then grant TICK: add the user to the 'tick-viewers' Cognito group,\n` +
                `          otherwise they can sign in but still get 403 from TICK.\n`
              : '') +
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
