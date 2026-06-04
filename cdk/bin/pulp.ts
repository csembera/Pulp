#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { PulpDataStack } from '../lib/pulp-data-stack';
import { PulpAppStack } from '../lib/pulp-app-stack';

const app = new cdk.App();

const dataStack = new PulpDataStack(app, 'PulpDataStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  description: 'Pulp stateful resources — S3, DynamoDB, Cognito (RETAIN on delete)',
});

new PulpAppStack(app, 'PulpAppStack', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: 'us-east-1' },
  description: 'Pulp compute and API — CloudFront, WAF, API GW, Lambdas, SQS, alarms',
  dataStack,
});
