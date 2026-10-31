import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as lambdaBase from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

const SENDER_DOMAIN = 'sembasolutions.com';
const SENDER_EMAIL  = `support@${SENDER_DOMAIN}`;
const DEFAULT_SIGN_IN_URL = 'https://pulp.sembasolutions.com';

/**
 * PulpDataStack — stateful resources (removalPolicy: RETAIN): uploads bucket,
 * DynamoDB table, Cognito user pool, SQS queues. The S3 → SQS notification is
 * wired here so the queue stays co-located with the bucket — CDK puts the
 * notification handler in the bucket's stack, otherwise a cross-stack cycle.
 */
export class PulpDataStack extends cdk.Stack {
  public readonly uploadsBucket: s3.Bucket;
  public readonly table: dynamodb.Table;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly dlq: sqs.Queue;
  public readonly mainQueue: sqs.Queue;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── S3: PDF uploads ────────────────────────────────────────────────────
    this.uploadsBucket = new s3.Bucket(this, 'UploadsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      // Wildcard origin is safe — the presigned URL's signature is the gate, not Origin.
      cors: [{
        allowedMethods: [s3.HttpMethods.PUT],
        allowedOrigins: ['*'],
        allowedHeaders: ['*'],
        maxAge: 3000,
      }],
    });

    this.uploadsBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyNonTLS',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:*'],
      resources: [
        this.uploadsBucket.bucketArn,
        `${this.uploadsBucket.bucketArn}/*`,
      ],
      conditions: { Bool: { 'aws:SecureTransport': 'false' } },
    }));

    new cdk.CfnOutput(this, 'UploadsBucketName', {
      value: this.uploadsBucket.bucketName,
      exportName: 'PulpUploadsBucketName',
    });

    // ── DynamoDB: single-table design ──────────────────────────────────────
    this.table = new dynamodb.Table(this, 'Table', {
      tableName: 'pulp-table',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey:      { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: this.table.tableName,
      exportName: 'PulpTableName',
    });

    // ── SQS: DLQ + main processing queue ──────────────────────────────────
    // Co-located with the uploads bucket so the S3 → SQS notification avoids a cross-stack cycle.
    this.dlq = new sqs.Queue(this, 'Dlq', {
      retentionPeriod: cdk.Duration.days(14),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // visibilityTimeout ≥ 6× the processor timeout; maxReceiveCount 3 → 4 tries before DLQ.
    this.mainQueue = new sqs.Queue(this, 'Queue', {
      visibilityTimeout: cdk.Duration.seconds(720),
      deadLetterQueue: { queue: this.dlq, maxReceiveCount: 3 },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cdk.CfnOutput(this, 'QueueUrl', {
      value: this.mainQueue.queueUrl,
    });

    new cdk.CfnOutput(this, 'DlqUrl', {
      value: this.dlq.queueUrl,
    });

    // ── S3 → SQS event notification ────────────────────────────────────────
    // Fires on every PDF PUT under uploads/. SqsDestination grants S3 sqs:SendMessage.
    this.uploadsBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED_PUT,
      new s3n.SqsDestination(this.mainQueue),
      { prefix: 'uploads/', suffix: '.pdf' },
    );

    // ── SES sender identity ───────────────────────────────────────────────
    // The sembasolutions.com domain identity (and its DKIM records) is owned by
    // the SembaPlatform stack (Semba-Solutions/infra), shared by every product.
    // The user pool below sends through it by domain name (sesVerifiedDomain).

    // ── Cognito CustomMessage trigger ──────────────────────────────────────
    // Renders the Pulp welcome email for AdminCreateUser; other sources fall through.
    const customMessageFn = new lambdaNodejs.NodejsFunction(this, 'CustomMessageFn', {
      functionName: 'pulp-custom-message-trigger',
      entry: 'lambdas/cognito-custom-message.ts',
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_22_X,
      memorySize: 256,
      timeout: cdk.Duration.seconds(5),
      tracing: lambdaBase.Tracing.ACTIVE,
      environment: {
        SIGN_IN_URL: DEFAULT_SIGN_IN_URL,
      },
    });

    // ── Cognito user pool ──────────────────────────────────────────────────
    // Self-signup OFF — accounts created via `make admin-create-user` (AdminCreateUser
    // + temp password → NEW_PASSWORD_REQUIRED on first sign-in).
    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: 'pulp-user-pool',
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      featurePlan: cognito.FeaturePlan.PLUS,
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      // Send via SES (verified domain) instead of Cognito's capped built-in mailer.
      email: cognito.UserPoolEmail.withSES({
        fromEmail: SENDER_EMAIL,
        fromName:  'Pulp',
        sesRegion: this.region,
        // SourceArn must point at the domain identity; else CDK derives it from
        // fromEmail and Cognito's preflight check fails.
        sesVerifiedDomain: SENDER_DOMAIN,
      }),
      lambdaTriggers: {
        customMessage: customMessageFn,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.userPoolClient = new cognito.UserPoolClient(this, 'UserPoolClient', {
      userPool: this.userPool,
      userPoolClientName: 'pulp-app-client',
      generateSecret: false,
      // userPassword needed for the NEW_PASSWORD_REQUIRED challenge (amazon-cognito-identity-js).
      authFlows: { userSrp: true, userPassword: true },
      // Generic responses for unknown emails — no account enumeration via sign-in/reset.
      preventUserExistenceErrors: true,
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      exportName: 'PulpUserPoolId',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      exportName: 'PulpUserPoolClientId',
    });
  }
}
