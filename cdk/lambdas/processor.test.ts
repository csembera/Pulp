import { handler } from './processor';
import { DynamoDBClient, UpdateItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { BedrockRuntimeClient, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { mockClient } from 'aws-sdk-client-mock';
import type { SQSEvent } from 'aws-lambda';

const dynamoMock  = mockClient(DynamoDBClient);
const s3Mock      = mockClient(S3Client);
const bedrockMock = mockClient(BedrockRuntimeClient);

const BUCKET  = 'test-bucket';
const USER_ID = 'user-abc';
const JOB_ID  = 'job-123';
const S3_KEY  = `uploads/${USER_ID}/${JOB_ID}.pdf`;

function makeEvent(): SQSEvent {
  const s3Body = JSON.stringify({
    Records: [{ s3: { bucket: { name: BUCKET }, object: { key: S3_KEY } } }],
  });
  return {
    Records: [{
      messageId: 'msg-1',
      receiptHandle: 'rh-1',
      body: s3Body,
      attributes: {} as never,
      messageAttributes: {},
      md5OfBody: '',
      eventSource: 'aws:sqs',
      eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:queue',
      awsRegion: 'us-east-1',
    }],
  };
}

const validQuiz = JSON.stringify(
  Array.from({ length: 25 }, (_, i) => ({
    question: `Q${i + 1}?`,
    options: ['A', 'B', 'C', 'D'],
    correctIndex: 0,
  })),
);

const validKeyTerms = JSON.stringify(
  Array.from({ length: 12 }, (_, i) => ({
    term: `Term ${i + 1}`,
    definition: `Definition ${i + 1}`,
  })),
);

const validSummary = JSON.stringify({
  title: 'Test Document',
  sections: [
    { heading: 'Intro', content: 'Content 1' },
    { heading: 'Body', content: 'Content 2' },
    { heading: 'Conclusion', content: 'Content 3' },
  ],
});

function bedrockResponse(text: string) {
  return {
    output: {
      message: { role: 'assistant' as const, content: [{ text }] },
    },
    stopReason: 'end_turn' as const,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    metrics: { latencyMs: 100 },
  };
}

beforeEach(() => {
  dynamoMock.reset();
  s3Mock.reset();
  bedrockMock.reset();
  process.env.TABLE_NAME  = 'pulp-table';
  process.env.BUCKET_NAME = BUCKET;
});

test('duplicate delivery — condition fails, no Bedrock calls', async () => {
  const { ConditionalCheckFailedException } = await import('@aws-sdk/client-dynamodb');
  dynamoMock.on(UpdateItemCommand).rejects(
    new ConditionalCheckFailedException({ message: 'Condition failed', $metadata: {} }),
  );

  await handler(makeEvent());

  expect(dynamoMock.commandCalls(UpdateItemCommand)).toHaveLength(1);
  expect(bedrockMock.commandCalls(ConverseCommand)).toHaveLength(0);
  expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
});

test('primary delivery — valid responses → Topic written, job complete, S3 deleted', async () => {
  dynamoMock.on(UpdateItemCommand).resolves({});
  dynamoMock.on(PutItemCommand).resolves({});
  s3Mock.on(DeleteObjectCommand).resolves({});
  s3Mock.on(PutObjectCommand).resolves({});
  // Processor runs summary first (to prime the Bedrock prompt cache),
  // then quiz + keyTerms in parallel. Mock order must match.
  bedrockMock
    .on(ConverseCommand).resolvesOnce(bedrockResponse(validSummary))
    .resolvesOnce(bedrockResponse(validQuiz))
    .resolvesOnce(bedrockResponse(validKeyTerms));

  await handler(makeEvent());

  // pending → processing (promotes TTL), then complete = 2 updates.
  expect(dynamoMock.commandCalls(UpdateItemCommand)).toHaveLength(2);
  const processingUpdate = dynamoMock.commandCalls(UpdateItemCommand)[0].args[0].input;
  expect(processingUpdate.ExpressionAttributeValues![':processing'].S).toBe('processing');
  expect(processingUpdate.ExpressionAttributeValues![':ttl'].N).toBeDefined(); // TTL promoted on processing
  const completeUpdate = dynamoMock.commandCalls(UpdateItemCommand)[1].args[0].input;
  expect(completeUpdate.ExpressionAttributeValues![':complete'].S).toBe('complete');

  // Content written to S3 (summary / quiz / keyTerms); the Topic row holds metadata only.
  expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
  const contentPut = s3Mock.commandCalls(PutObjectCommand)[0].args[0].input;
  expect(contentPut.Key).toBe(`topics/${USER_ID}/${JOB_ID}.json`);
  const content = JSON.parse(contentPut.Body as string);
  expect(content.quizQuestions).toHaveLength(25);
  expect(content.summary.title).toBe('Test Document');

  expect(dynamoMock.commandCalls(PutItemCommand)).toHaveLength(1);
  const topicItem = dynamoMock.commandCalls(PutItemCommand)[0].args[0].input.Item!;
  expect(topicItem.title.S).toBe('Test Document');
  expect(topicItem.topicId.S).toBe(JOB_ID);
  expect(topicItem.contentKey.S).toBe(`topics/${USER_ID}/${JOB_ID}.json`);
  expect(topicItem.summary).toBeUndefined();

  // Source PDF deleted after successful Topic write.
  expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  expect(s3Mock.commandCalls(DeleteObjectCommand)[0].args[0].input.Key).toBe(S3_KEY);
});

test('malformed JSON — job marked failed, S3 object retained', async () => {
  dynamoMock.on(UpdateItemCommand).resolves({});
  bedrockMock.on(ConverseCommand).resolves(bedrockResponse('not valid json'));

  await handler(makeEvent());

  // pending → processing, then failed = 2 updates.
  expect(dynamoMock.commandCalls(UpdateItemCommand)).toHaveLength(2);
  const failedUpdate = dynamoMock.commandCalls(UpdateItemCommand)[1].args[0].input;
  expect(failedUpdate.ExpressionAttributeValues![':failed'].S).toBe('failed');
  expect(JSON.parse(failedUpdate.ExpressionAttributeValues![':errors'].S!)).toHaveProperty('quiz');

  // No Topic written, no S3 delete.
  expect(dynamoMock.commandCalls(PutItemCommand)).toHaveLength(0);
  expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
});

// Route ConverseCommand responses by which base prompt is in the message.
function routeBedrock(map: { quiz: string; keyTerms: string; summary: string }) {
  bedrockMock.on(ConverseCommand).callsFake((input) => {
    const text = input.messages?.[0]?.content?.find((b: unknown): b is { text: string } =>
      typeof b === 'object' && b !== null && 'text' in b,
    )?.text ?? '';
    if (text.includes('multiple-choice'))       return bedrockResponse(map.quiz);
    if (text.includes('glossary'))              return bedrockResponse(map.keyTerms);
    if (text.includes('comprehensive summary')) return bedrockResponse(map.summary);
    throw new Error(`unrecognized prompt: ${text.slice(0, 80)}`);
  });
}

test('schema validation failure — quiz invalid on every attempt → job failed', async () => {
  dynamoMock.on(UpdateItemCommand).resolves({});
  const tooFewQuestions = JSON.stringify(
    Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}?`, options: ['A', 'B', 'C', 'D'], correctIndex: 0 })),
  );
  routeBedrock({ quiz: tooFewQuestions, keyTerms: validKeyTerms, summary: validSummary });

  await handler(makeEvent());

  const failedUpdate = dynamoMock.commandCalls(UpdateItemCommand)[1].args[0].input;
  expect(failedUpdate.ExpressionAttributeValues![':failed'].S).toBe('failed');
  const errors = JSON.parse(failedUpdate.ExpressionAttributeValues![':errors'].S!);
  expect(errors).toHaveProperty('quiz');
  expect(errors).not.toHaveProperty('keyTerms');
  expect(errors).not.toHaveProperty('summary');
  // Original + 3 retries for quiz, 1 each for keyTerms and summary = 6.
  expect(bedrockMock.commandCalls(ConverseCommand)).toHaveLength(6);
  expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
});

test('schema retry recovery — invalid then valid quiz → job complete', async () => {
  dynamoMock.on(UpdateItemCommand).resolves({});
  dynamoMock.on(PutItemCommand).resolves({});
  s3Mock.on(DeleteObjectCommand).resolves({});

  const tooFewQuestions = JSON.stringify(
    Array.from({ length: 5 }, (_, i) => ({ question: `Q${i}?`, options: ['A', 'B', 'C', 'D'], correctIndex: 0 })),
  );
  let quizAttempts = 0;
  bedrockMock.on(ConverseCommand).callsFake((input) => {
    const text = input.messages?.[0]?.content?.find((b: unknown): b is { text: string } =>
      typeof b === 'object' && b !== null && 'text' in b,
    )?.text ?? '';
    if (text.includes('multiple-choice')) {
      quizAttempts++;
      return bedrockResponse(quizAttempts === 1 ? tooFewQuestions : validQuiz);
    }
    if (text.includes('glossary'))              return bedrockResponse(validKeyTerms);
    if (text.includes('comprehensive summary')) return bedrockResponse(validSummary);
    throw new Error(`unrecognized prompt: ${text.slice(0, 80)}`);
  });

  await handler(makeEvent());

  // Job completed, not failed.
  const finalUpdate = dynamoMock.commandCalls(UpdateItemCommand)[1].args[0].input;
  expect(finalUpdate.ExpressionAttributeValues![':complete'].S).toBe('complete');
  expect(dynamoMock.commandCalls(PutItemCommand)).toHaveLength(1);
  expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  expect(quizAttempts).toBe(2);
});

test('schema retry prompt — includes validator error on re-prompt', async () => {
  dynamoMock.on(UpdateItemCommand).resolves({});
  dynamoMock.on(PutItemCommand).resolves({});
  s3Mock.on(DeleteObjectCommand).resolves({});

  const threeOpts = JSON.stringify(
    Array.from({ length: 25 }, (_, i) => ({
      question: `Q${i}?`,
      options: i === 8 ? ['A', 'B', 'C'] : ['A', 'B', 'C', 'D'],
      correctIndex: 0,
    })),
  );
  const quizPrompts: string[] = [];
  bedrockMock.on(ConverseCommand).callsFake((input) => {
    const text = input.messages?.[0]?.content?.find((b: unknown): b is { text: string } =>
      typeof b === 'object' && b !== null && 'text' in b,
    )?.text ?? '';
    if (text.includes('multiple-choice')) {
      quizPrompts.push(text);
      return bedrockResponse(quizPrompts.length === 1 ? threeOpts : validQuiz);
    }
    if (text.includes('glossary'))              return bedrockResponse(validKeyTerms);
    if (text.includes('comprehensive summary')) return bedrockResponse(validSummary);
    throw new Error(`unrecognized prompt: ${text.slice(0, 80)}`);
  });

  await handler(makeEvent());

  expect(quizPrompts).toHaveLength(2);
  expect(quizPrompts[0]).not.toMatch(/previous attempt was rejected/);
  expect(quizPrompts[1]).toMatch(/previous attempt was rejected/);
  expect(quizPrompts[1]).toMatch(/exactly 4 options/);
});
