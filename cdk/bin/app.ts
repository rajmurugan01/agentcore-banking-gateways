import * as cdk from 'aws-cdk-lib';
import { BankingGatewaysStack } from '../lib/stack';

const app = new cdk.App();
new BankingGatewaysStack(app, 'AgentcoreBankingGateways', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.DEMO_REGION ?? 'us-east-1' },
});
