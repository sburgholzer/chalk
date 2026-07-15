#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ChalkStack } from './chalk-stack';

const app = new cdk.App();

new ChalkStack(app, 'ChalkStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
});
