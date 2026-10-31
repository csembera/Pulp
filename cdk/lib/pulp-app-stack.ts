import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Auth from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as apigwv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudfrontOrigins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambdaBase from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as lambdaNodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { PulpDataStack } from './pulp-data-stack';

const APP_DOMAIN     = 'pulp.sembasolutions.com';
const ROOT_DOMAIN    = 'sembasolutions.com';

export interface PulpAppStackProps extends cdk.StackProps {
  dataStack: PulpDataStack;
}

/**
 * PulpAppStack — compute + edge: frontend bucket, CloudFront, WAF, API, Lambdas, alarms.
 * (The account budget is not here: it belongs to the account, not to Pulp.)
 * Frontend bucket is co-located here (not PulpDataStack) — its OAC policy references the
 * distribution ARN, which would otherwise create a cross-stack cycle.
 */
export class PulpAppStack extends cdk.Stack {
  // Exposed so individual Lambda tasks can add routes.
  public readonly api: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: PulpAppStackProps) {
    super(scope, id, props);

    const { dataStack } = props;

    // ── S3: static frontend ────────────────────────────────────────────────
    const frontendBucket = new s3.Bucket(this, 'FrontendBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: false,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    frontendBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyNonTLS',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:*'],
      resources: [frontendBucket.bucketArn, `${frontendBucket.bucketArn}/*`],
      conditions: { Bool: { 'aws:SecureTransport': 'false' } },
    }));

    new cdk.CfnOutput(this, 'FrontendBucketName', {
      value: frontendBucket.bucketName,
      exportName: 'PulpFrontendBucketName',
    });

    // ── WAF WebACL ─────────────────────────────────────────────────────────
    // Per-IP rate limit (100 / 5 min) on /api/auth/* to blunt join-request abuse.
    // Evaluated at the edge before the /api strip, so it sees the real path.
    // scope CLOUDFRONT must be in us-east-1.
    const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: 'pulp-waf',
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        sampledRequestsEnabled: true,
        cloudWatchMetricsEnabled: true,
        metricName: 'pulp-waf',
      },
      rules: [
        {
          name: 'AuthRateLimit',
          priority: 1,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 100,
              aggregateKeyType: 'IP',
              evaluationWindowSec: 300,
              scopeDownStatement: {
                byteMatchStatement: {
                  searchString: '/api/auth/',
                  fieldToMatch: { uriPath: {} },
                  textTransformations: [{ priority: 0, type: 'NONE' }],
                  positionalConstraint: 'STARTS_WITH',
                },
              },
            },
          },
          visibilityConfig: {
            sampledRequestsEnabled: true,
            cloudWatchMetricsEnabled: true,
            metricName: 'AuthRateLimit',
          },
        },
      ],
    });

    // ── Response headers policy ────────────────────────────────────────────
    // CSP limits XSS blast radius: connect-src blocks JWT exfiltration, script-src
    // blocks foreign code. 'unsafe-inline' is unavoidable (inline module + style,
    // no build step); esm.sh allowlisted for the preact/htm/cognito imports.
    const csp = [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' https://esm.sh",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "img-src 'self' data:",
      // pulp.sembasolutions.com is allowed so the TICK demo, served from the
      // landing distribution under /tick-demo, can POST the join-request form
      // cross-origin. It must go via CloudFront rather than execute-api direct:
      // only CloudFront injects the x-origin-verify header the handler checks.
      "connect-src 'self' https://pulp.sembasolutions.com https://*.execute-api.us-east-1.amazonaws.com https://cognito-idp.us-east-1.amazonaws.com https://*.s3.amazonaws.com https://*.s3.us-east-1.amazonaws.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      "upgrade-insecure-requests",
    ].join('; ');

    // HSTS 2y; includeSubdomains/preload off — the apex has other non-HTTPS subdomains.
    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
      comment: 'Pulp SPA security headers',
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: csp, override: true },
        contentTypeOptions: { override: true },
        frameOptions: {
          frameOption: cloudfront.HeadersFrameOption.DENY,
          override: true,
        },
        referrerPolicy: {
          referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
          override: true,
        },
        strictTransportSecurity: {
          accessControlMaxAge: cdk.Duration.days(730),
          includeSubdomains: false,
          preload: false,
          override: true,
        },
      },
    });

    // ── ACM certificate ────────────────────────────────────────────────────
    // Must be in us-east-1 (already our region) for CloudFront. DNS validation
    // records are auto-created in the Route 53 hosted zone by CDK.
    const hostedZone = route53.HostedZone.fromLookup(this, 'Zone', {
      domainName: ROOT_DOMAIN,
    });

    const cert = new acm.Certificate(this, 'Cert', {
      domainName: APP_DOMAIN,
      validation: acm.CertificateValidation.fromDns(hostedZone),
    });

    // ── CloudFront Distribution ────────────────────────────────────────────
    // OAC restricts the bucket to CloudFront only; HTTPS_ONLY for viewers.
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: cloudfrontOrigins.S3BucketOrigin.withOriginAccessControl(frontendBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        responseHeadersPolicy: securityHeaders,
      },
      defaultRootObject: 'index.html',
      domainNames: [APP_DOMAIN],
      certificate: cert,
      webAclId: webAcl.attrArn,
    });

    new cdk.CfnOutput(this, 'DistributionDomainName', {
      value: distribution.distributionDomainName,
      exportName: 'PulpDistributionDomainName',
    });

    new cdk.CfnOutput(this, 'DistributionId', {
      value: distribution.distributionId,
      exportName: 'PulpDistributionId',
    });

    new cdk.CfnOutput(this, 'AppUrl', {
      value: `https://${APP_DOMAIN}`,
      exportName: 'PulpAppUrl',
    });

    // ── Route 53 alias ─────────────────────────────────────────────────────
    // pulp.sembasolutions.com → CloudFront distribution.
    new route53.ARecord(this, 'AppAliasRecord', {
      zone: hostedZone,
      recordName: APP_DOMAIN,
      target: route53.RecordTarget.fromAlias(
        new route53Targets.CloudFrontTarget(distribution),
      ),
    });

    // ── JWT authorizer ─────────────────────────────────────────────────────
    // Validates the Cognito ID token on every request; /auth/join-request opts out.
    const jwtAuthorizer = new apigwv2Auth.HttpJwtAuthorizer(
      'CognitoAuthorizer',
      `https://cognito-idp.${this.region}.amazonaws.com/${dataStack.userPool.userPoolId}`,
      {
        jwtAudience: [dataStack.userPoolClient.userPoolClientId],
      },
    );

    // ── HTTP API ───────────────────────────────────────────────────────────
    this.api = new apigwv2.HttpApi(this, 'Api', {
      apiName: 'pulp-api',
      defaultAuthorizer: jwtAuthorizer,
      corsPreflight: {
        allowHeaders: ['Content-Type', 'Authorization'],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowOrigins: [`https://${APP_DOMAIN}`],
      },
    });

    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.api.apiEndpoint,
      exportName: 'PulpApiUrl',
    });

    // ── Route the API through CloudFront so the WAF applies ─────────────────
    // SPA calls /api/* same-origin → CloudFront → HTTP API, so every request hits
    // the WebACL. The origin-verify header CloudFront injects lets the join-request
    // Lambda reject direct (un-WAF'd) hits. From SSM at deploy; seed once:
    //   aws ssm put-parameter --name /pulp/origin-verify-secret \
    //     --type String --value "$(openssl rand -hex 32)"
    const originVerifySecret = ssm.StringParameter.valueForStringParameter(
      this, '/pulp/origin-verify-secret',
    );

    // Strip /api before the HTTP API (routes live at root). Runs after the WebACL.
    const apiPathRewrite = new cloudfront.Function(this, 'ApiPathRewriteFn', {
      code: cloudfront.FunctionCode.fromInline(`
        function handler(event) {
          var request = event.request;
          if (request.uri.startsWith('/api/')) {
            request.uri = request.uri.substring(4);
          }
          return request;
        }
      `),
    });

    distribution.addBehavior(
      '/api/*',
      new cloudfrontOrigins.HttpOrigin(
        `${this.api.apiId}.execute-api.${this.region}.amazonaws.com`,
        {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
          customHeaders: { 'X-Origin-Verify': originVerifySecret },
        },
      ),
      {
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        // Per-user, authenticated, dynamic — never cache.
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        // All viewer headers except Host (execute-api rejects a mismatched Host).
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        functionAssociations: [{
          function: apiPathRewrite,
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
        }],
      },
    );

    // ── SNS: alarms topic ─────────────────────────────────────────────────
    // Single sink for alarms, budget notifications, and invite-request pings.
    const alarmsTopic = new sns.Topic(this, 'AlarmsTopic', {
      topicName: 'pulp-alarms',
    });

    // Email is sourced from SSM at deploy time so it never lands in source.
    // Seed once: aws ssm put-parameter --name /pulp/alarms-email --type String --value you@example.com
    new sns.Subscription(this, 'AlarmsEmailSubscription', {
      topic: alarmsTopic,
      protocol: sns.SubscriptionProtocol.EMAIL,
      endpoint: ssm.StringParameter.valueForStringParameter(this, '/pulp/alarms-email'),
    });

    // ── join-request Lambda ────────────────────────────────────────────────
    // Public (no JWT); always 200 (no enumeration); pings the alarms topic on new requests.
    const joinRequestFn = new lambdaNodejs.NodejsFunction(this, 'JoinRequestFn', {
      functionName: 'pulp-join-request-handler',
      entry: 'lambdas/join-request.ts',
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_22_X,
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      tracing: lambdaBase.Tracing.ACTIVE,
      environment: {
        TABLE_NAME:           dataStack.table.tableName,
        ALARMS_TOPIC_ARN:     alarmsTopic.topicArn,
        ORIGIN_VERIFY_SECRET: originVerifySecret,
      },
    });

    dataStack.table.grantWriteData(joinRequestFn);
    alarmsTopic.grantPublish(joinRequestFn);

    this.api.addRoutes({
      path: '/auth/join-request',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration('JoinRequestIntegration', joinRequestFn),
      // authorizer: undefined overrides the default JWT authorizer — public endpoint.
      authorizer: new apigwv2.HttpNoneAuthorizer(),
    });

    // Service principals need explicit resource-policy grants (account IAM doesn't cover them).
    alarmsTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowCloudWatchPublish',
      principals: [new iam.ServicePrincipal('cloudwatch.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [alarmsTopic.topicArn],
    }));

    alarmsTopic.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'AllowBudgetsPublish',
      principals: [new iam.ServicePrincipal('budgets.amazonaws.com')],
      actions: ['sns:Publish'],
      resources: [alarmsTopic.topicArn],
    }));

    const alarmAction = new cloudwatchActions.SnsAction(alarmsTopic);

    // ── CloudWatch Alarms ─────────────────────────────────────────────────
    // 1. DLQ depth > 0 — any message in DLQ means processor failures
    const dlqDepthAlarm = new cloudwatch.Alarm(this, 'DlqDepthAlarm', {
      alarmName: 'pulp-dlq-depth',
      alarmDescription: 'Messages visible in DLQ — processor is failing consistently',
      metric: dataStack.dlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    dlqDepthAlarm.addAlarmAction(alarmAction);

    // 2. Main queue oldest-message age > 300 s — messages stuck, processor lagging
    const queueAgeAlarm = new cloudwatch.Alarm(this, 'QueueAgeAlarm', {
      alarmName: 'pulp-queue-age',
      alarmDescription: 'Oldest message in main queue older than 5 minutes',
      metric: dataStack.mainQueue.metricApproximateAgeOfOldestMessage({
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }),
      threshold: 300,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    queueAgeAlarm.addAlarmAction(alarmAction);

    // 3. Processor Lambda errors > 5 in 5 min.
    // Lambda doesn't exist until Task 4.3 — alarm is INSUFFICIENT_DATA until then.
    const processorErrorsAlarm = new cloudwatch.Alarm(this, 'ProcessorErrorsAlarm', {
      alarmName: 'pulp-processor-errors',
      alarmDescription: 'Processor Lambda error count > 5 in 5 minutes',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Lambda',
        metricName: 'Errors',
        dimensionsMap: { FunctionName: 'pulp-processor-handler' },
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 5,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    processorErrorsAlarm.addAlarmAction(alarmAction);

    // 4. Bedrock throttles > 3 in 5 min — guards against quota exhaustion
    const bedrockThrottlesAlarm = new cloudwatch.Alarm(this, 'BedrockThrottlesAlarm', {
      alarmName: 'pulp-bedrock-throttles',
      alarmDescription: 'Bedrock invocation throttles > 3 in 5 minutes',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Bedrock',
        metricName: 'InvocationThrottles',
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    bedrockThrottlesAlarm.addAlarmAction(alarmAction);

    // 5. Pulp/JobsFailed > 1 in 5 min — Lambda Errors miss this (the job fails, no throw).
    const jobsFailedAlarm = new cloudwatch.Alarm(this, 'JobsFailedAlarm', {
      alarmName: 'pulp-jobs-failed',
      alarmDescription: 'Processor marked > 1 job as failed in 5 minutes',
      metric: new cloudwatch.Metric({
        namespace: 'Pulp',
        metricName: 'JobsFailed',
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    jobsFailedAlarm.addAlarmAction(alarmAction);

    // 6. SES bounce rate > 5% — fires below AWS's 10% enforcement. Fraction (0.05 = 5%).
    const sesBounceRateAlarm = new cloudwatch.Alarm(this, 'SesBounceRateAlarm', {
      alarmName: 'pulp-ses-bounce-rate',
      alarmDescription: 'SES account bounce rate > 5% — reputation at risk',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SES',
        metricName: 'Reputation.BounceRate',
        period: cdk.Duration.minutes(15),
        statistic: 'Maximum',
      }),
      threshold: 0.05,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    sesBounceRateAlarm.addAlarmAction(alarmAction);

    // 7. SES complaint rate > 0.1% — AWS pauses sending at >0.5%.
    const sesComplaintRateAlarm = new cloudwatch.Alarm(this, 'SesComplaintRateAlarm', {
      alarmName: 'pulp-ses-complaint-rate',
      alarmDescription: 'SES account complaint rate > 0.1% — recipients flagging as spam',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/SES',
        metricName: 'Reputation.ComplaintRate',
        period: cdk.Duration.minutes(15),
        statistic: 'Maximum',
      }),
      threshold: 0.001,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    sesComplaintRateAlarm.addAlarmAction(alarmAction);


    // ── upload Lambda ─────────────────────────────────────────────────────
    // POST /uploads — presigned PUT URL + pending job row. JWT (default).
    const uploadFn = new lambdaNodejs.NodejsFunction(this, 'UploadFn', {
      functionName: 'pulp-upload-handler',
      entry: 'lambdas/upload.ts',
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_22_X,
      memorySize: 128,
      timeout: cdk.Duration.seconds(10),
      tracing: lambdaBase.Tracing.ACTIVE,
      environment: {
        TABLE_NAME: dataStack.table.tableName,
        BUCKET_NAME: dataStack.uploadsBucket.bucketName,
      },
    });

    // Read for the per-user topic-count check (Select: 'COUNT' query against
    // TOPIC# keys); write for the pending JOB row.
    dataStack.table.grantReadWriteData(uploadFn);
    dataStack.uploadsBucket.grantPut(uploadFn);

    this.api.addRoutes({
      path: '/uploads',
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration('UploadIntegration', uploadFn),
    });

    // ── processor Lambda ──────────────────────────────────────────────────
    // SQS-triggered: batch 1, maxConcurrency 5, 300 s, 1024 MB. 1024 MB buys CPU
    // (linear with memory) — smaller sizes timed out on larger PDFs.
    const processorFn = new lambdaNodejs.NodejsFunction(this, 'ProcessorFn', {
      functionName: 'pulp-processor-handler',
      entry: 'lambdas/processor.ts',
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_22_X,
      memorySize: 1024,
      timeout: cdk.Duration.seconds(300),
      tracing: lambdaBase.Tracing.ACTIVE,
      environment: {
        TABLE_NAME: dataStack.table.tableName,
      },
    });

    dataStack.table.grantReadWriteData(processorFn);
    dataStack.uploadsBucket.grantRead(processorFn);
    dataStack.uploadsBucket.grantDelete(processorFn);
    // Write topic content JSON under topics/<userId>/<topicId>.json.
    processorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:PutObject'],
      resources: [`${dataStack.uploadsBucket.bucketArn}/topics/*`],
    }));

    processorFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel'],
      resources: [
        // Inference profile (account-scoped).
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/us.amazon.nova-2-lite-v1:0`,
        // Profile routes to any US region.
        'arn:aws:bedrock:us-*::foundation-model/amazon.nova-2-lite-v1:0',
      ],
    }));

    processorFn.addEventSource(new lambdaEventSources.SqsEventSource(dataStack.mainQueue, {
      batchSize: 1,
      maxConcurrency: 5,
    }));

    // ── results Lambda — GET /jobs/{jobId} ────────────────────────────────
    const resultsFn = new lambdaNodejs.NodejsFunction(this, 'ResultsFn', {
      functionName: 'pulp-results-handler',
      entry: 'lambdas/results.ts',
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_22_X,
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      tracing: lambdaBase.Tracing.ACTIVE,
      environment: { TABLE_NAME: dataStack.table.tableName },
    });
    dataStack.table.grantReadData(resultsFn);
    this.api.addRoutes({
      path: '/jobs/{jobId}',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration('ResultsIntegration', resultsFn),
    });

    // ── topics Lambda — GET /topics  and  GET /topics/{topicId} ───────────
    const topicsFn = new lambdaNodejs.NodejsFunction(this, 'TopicsFn', {
      functionName: 'pulp-topics-handler',
      entry: 'lambdas/topics.ts',
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_22_X,
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      tracing: lambdaBase.Tracing.ACTIVE,
      environment: {
        TABLE_NAME:  dataStack.table.tableName,
        BUCKET_NAME: dataStack.uploadsBucket.bucketName,
      },
    });
    dataStack.table.grantReadWriteData(topicsFn);
    // Read/delete topic content under topics/ — getDetail proxies it, delete removes it.
    topicsFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:DeleteObject'],
      resources: [`${dataStack.uploadsBucket.bucketArn}/topics/*`],
    }));
    this.api.addRoutes({
      path: '/topics',
      methods: [apigwv2.HttpMethod.GET],
      integration: new apigwv2Integrations.HttpLambdaIntegration('TopicsListIntegration', topicsFn),
    });
    this.api.addRoutes({
      path: '/topics/{topicId}',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH, apigwv2.HttpMethod.DELETE],
      integration: new apigwv2Integrations.HttpLambdaIntegration('TopicsDetailIntegration', topicsFn),
    });
    this.api.addRoutes({
      path: '/jobs/{jobId}',
      methods: [apigwv2.HttpMethod.DELETE],
      integration: new apigwv2Integrations.HttpLambdaIntegration('JobCancelIntegration', topicsFn),
    });

    // ── attempts Lambda — POST + GET /topics/{topicId}/attempts ──────────
    const attemptsFn = new lambdaNodejs.NodejsFunction(this, 'AttemptsFn', {
      functionName: 'pulp-attempts-handler',
      entry: 'lambdas/attempts.ts',
      handler: 'handler',
      runtime: lambdaBase.Runtime.NODEJS_22_X,
      memorySize: 128,
      timeout: cdk.Duration.seconds(5),
      tracing: lambdaBase.Tracing.ACTIVE,
      environment: { TABLE_NAME: dataStack.table.tableName },
    });
    dataStack.table.grantReadWriteData(attemptsFn);
    this.api.addRoutes({
      path: '/topics/{topicId}/attempts',
      methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration('AttemptsIntegration', attemptsFn),
    });
  }
}
