import * as fs from 'fs';
import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import * as agentcore from 'aws-cdk-lib/aws-bedrockagentcore';

const POLICY_DIR = path.join(__dirname, '..', '..', 'policies');
const cedar = (file: string, gatewayArn: string) =>
  fs.readFileSync(path.join(POLICY_DIR, file), 'utf8').split('__GATEWAY_ARN__').join(gatewayArn);

type Tool = { name: string; description: string; properties: Record<string, { type: string; description: string }>; required: string[] };
const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });
const CID = { customer_id: str('the customer the request is for (checked against the verified token by policy)') };

const ACCOUNTS_TOOLS: Tool[] = [
  { name: 'get_balance', description: 'Get the balance of one of the customer\'s accounts',
    properties: { ...CID, account_id: str('account id') }, required: ['customer_id', 'account_id'] },
  { name: 'list_transactions', description: 'List recent transactions on one of the customer\'s accounts',
    properties: { ...CID, account_id: str('account id'), limit: int('max rows') }, required: ['customer_id', 'account_id'] },
];
const SERVICE_TOOLS: Tool[] = [
  { name: 'request_statement', description: 'Request a statement for an account',
    properties: { ...CID, account_id: str('account id'), months: int('months to cover') }, required: ['customer_id', 'account_id'] },
  { name: 'change_address', description: 'Change the customer\'s postal address (high risk)',
    properties: { ...CID, new_address: str('new postal address') }, required: ['customer_id', 'new_address'] },
  { name: 'order_chequebook', description: 'Order a cheque book', properties: { ...CID }, required: ['customer_id'] },
  { name: 'kyc_update', description: 'Update KYC documents (human-only, never callable by an agent)',
    properties: { ...CID, document_ref: str('document reference') }, required: ['customer_id'] },
];

export class BankingGatewaysStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const alertEmail = process.env.ALERT_EMAIL;
    if (!alertEmail) throw new Error('ALERT_EMAIL is required (budget alarm recipient); set it in the environment');

    // --- Identity: synthetic customers. "stepped-up" stands in for a real step-up/MFA claim. -------------
    const pool = new cognito.UserPool(this, 'Pool', {
      selfSignUpEnabled: false,
      signInAliases: { username: true },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const client = pool.addClient('DemoClient', {
      authFlows: { adminUserPassword: true },
      accessTokenValidity: cdk.Duration.hours(1),
      generateSecret: false,
    });
    new cognito.CfnUserPoolGroup(this, 'SteppedUpGroup', { userPoolId: pool.userPoolId, groupName: 'stepped-up' });

    // --- One mock Lambda for every tool, dispatching on the tool name the Gateway passes in. -------------
    const ledger = new dynamodb.Table(this, 'Ledger', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const fn = new lambda.Function(this, 'BankingTools', {
      runtime: lambda.Runtime.PYTHON_3_13,
      handler: 'banking_tools.handler',
      code: lambda.Code.fromAsset('../lambda'),
      environment: { LEDGER: ledger.tableName },
      timeout: cdk.Duration.seconds(10),
    });
    ledger.grantWriteData(fn);

    const gwRole = new iam.Role(this, 'GatewayRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*` },
        },
      }),
    });
    fn.grantInvoke(gwRole);
    gwRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:GetPolicyEngine', 'bedrock-agentcore:AuthorizeAction', 'bedrock-agentcore:PartiallyAuthorizeActions'],
      resources: [
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:policy-engine/*`,
        `arn:aws:bedrock-agentcore:${this.region}:${this.account}:gateway/*`,
      ],
    }));
    const rolePolicy = gwRole.node.findChild('DefaultPolicy').node.defaultChild as cdk.CfnResource;

    const authorizer = {
      customJwtAuthorizer: {
        discoveryUrl: `https://cognito-idp.${this.region}.amazonaws.com/${pool.userPoolId}/.well-known/openid-configuration`,
        allowedClients: [client.userPoolClientId],
      },
    };

    // A Gateway + its target + its own policy engine (a policy is validated against the Gateway it names).
    const makeGateway = (key: string, name: string, target: string, tools: Tool[], policyFiles: string[]) => {
      const engine = new agentcore.CfnPolicyEngine(this, `${key}Engine`, { name: `${name.replace(/-/g, '_')}_engine` });
      const gw = new agentcore.CfnGateway(this, `${key}Gateway`, {
        name, protocolType: 'MCP', roleArn: gwRole.roleArn,
        authorizerType: 'CUSTOM_JWT', authorizerConfiguration: authorizer,
        policyEngineConfiguration: { arn: engine.attrPolicyEngineArn, mode: 'ENFORCE' },
      });
      gw.addResourceDependency(rolePolicy);
      const tgt = new agentcore.CfnGatewayTarget(this, `${key}Target`, {
        name: target, gatewayIdentifier: gw.attrGatewayIdentifier,
        targetConfiguration: { mcp: { lambda: { lambdaArn: fn.functionArn, toolSchema: { inlinePayload: tools.map((t) => ({
          name: t.name, description: t.description,
          inputSchema: { type: 'object', properties: t.properties, required: t.required },
        })) } } } },
        credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
      });
      policyFiles.forEach((file, i) => {
        const p = new agentcore.CfnPolicy(this, `${key}Policy${i}`, {
          name: `${name.replace(/-/g, '_')}_${path.basename(file, '.cedar').replace(/-/g, '_')}`,
          policyEngineId: engine.attrPolicyEngineId,
          definition: { cedar: { statement: cedar(file, gw.attrGatewayArn) } },
        });
        p.addResourceDependency(gw); p.addResourceDependency(tgt); // policy validation calls the gateway
      });
      return gw;
    };

    // The real pair, and a deliberately broken pair (missing owner check) that exists only so the gate test can prove
    // the scenario harness notices a bad policy. Never point an agent at the broken pair.
    const accounts = makeGateway('Accounts', 'bank-accounts', 'accounts', ACCOUNTS_TOOLS, ['accounts.cedar']);
    // kyc_update has no permit on purpose: default-deny. AgentCore rejects an unconditional forbid as
    // "Overly Restrictive", so the human-only rule is the absence of a permit (and the lint guards it).
    const service = makeGateway('Service', 'bank-service', 'service', SERVICE_TOOLS,
      ['service-own-customer.cedar', 'service-change-address.cedar']);
    const accountsBroken = makeGateway('AccountsBroken', 'bank-accounts-broken', 'accounts', ACCOUNTS_TOOLS, ['fixtures/broken-accounts.cedar']);
    const serviceBroken = makeGateway('ServiceBroken', 'bank-service-broken', 'service', SERVICE_TOOLS, ['fixtures/broken-service.cedar']);

    // --- Agents: ONE image, three AgentCore Runtimes (A2A). The user's Cognito token is the inbound bearer; ------
    // the Authorization header is allow-listed through to the container so it can be forwarded, not replaced.
    const image = new ecrAssets.DockerImageAsset(this, 'AgentImage', {
      directory: path.join(__dirname, '../../agents'),
      platform: ecrAssets.Platform.LINUX_ARM64, // AgentCore Runtime is arm64-only
    });
    const agentRole = new iam.Role(this, 'AgentRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${this.region}:${this.account}:*` },
        },
      }),
    });
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents', 'logs:DescribeLogStreams'],
      resources: ['*'],
    }));
    // Haiku 4.5 is reached through a cross-Region "us." inference profile: both resource types are needed.
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
      resources: ['arn:aws:bedrock:*::foundation-model/*', 'arn:aws:bedrock:*:*:inference-profile/*'],
    }));
    agentRole.addToPolicy(new iam.PolicyStatement({ actions: ['ecr:GetAuthorizationToken'], resources: ['*'] }));
    agentRole.addToPolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:GetWorkloadAccessToken', 'bedrock-agentcore:GetWorkloadAccessTokenForJWT'],
      resources: ['*'],
    }));
    image.repository.grantPull(agentRole);
    const agentRolePolicy = agentRole.node.findChild('DefaultPolicy');
    const discoveryUrl = `https://cognito-idp.${this.region}.amazonaws.com/${pool.userPoolId}/.well-known/openid-configuration`;
    const makeRuntime = (key: string, name: string, role: string, env: Record<string, string>) => {
      const rt = new agentcore.CfnRuntime(this, `${key}Runtime`, {
        agentRuntimeName: name,
        description: `Example Bank ${role} agent (demo, synthetic data)`,
        roleArn: agentRole.roleArn,
        protocolConfiguration: 'A2A',
        agentRuntimeArtifact: { containerConfiguration: { containerUri: image.imageUri } },
        authorizerConfiguration: { customJwtAuthorizer: { discoveryUrl, allowedClients: [client.userPoolClientId] } },
        requestHeaderConfiguration: { requestHeaderAllowlist: ['Authorization'] },
        networkConfiguration: { networkMode: 'PUBLIC' },
        environmentVariables: { AWS_REGION: this.region, AGENT_ROLE: role, ...env },
      });
      rt.node.addDependency(agentRolePolicy); // else ECR access races the policy attach (see a2a repo)
      return rt;
    };
    const accountsRt = makeRuntime('Accounts', 'bank_accounts_agent', 'accounts', { GATEWAY_URL: accounts.attrGatewayUrl });
    const serviceRt = makeRuntime('Service', 'bank_service_agent', 'service', { GATEWAY_URL: service.attrGatewayUrl });
    const coordinatorRt = makeRuntime('Coordinator', 'bank_coordinator_agent', 'coordinator', {
      ACCOUNTS_RUNTIME_ARN: accountsRt.attrAgentRuntimeArn, SERVICE_RUNTIME_ARN: serviceRt.attrAgentRuntimeArn });

    // --- Cost guard: this is a public demo in a personal account. -------------------------------------
    new budgets.CfnBudget(this, 'DemoBudget', {
      budget: { budgetName: 'agentcore-banking-gateways', budgetType: 'COST', timeUnit: 'MONTHLY',
        budgetLimit: { amount: 20, unit: 'USD' } },
      notificationsWithSubscribers: [{
        notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold: 80, thresholdType: 'PERCENTAGE' },
        subscribers: [{ subscriptionType: 'EMAIL', address: alertEmail }],
      }],
    });

    new cdk.CfnOutput(this, 'Region', { value: this.region });
    new cdk.CfnOutput(this, 'UserPoolId', { value: pool.userPoolId });
    new cdk.CfnOutput(this, 'ClientId', { value: client.userPoolClientId });
    new cdk.CfnOutput(this, 'AccountsGatewayUrl', { value: accounts.attrGatewayUrl });
    new cdk.CfnOutput(this, 'ServiceGatewayUrl', { value: service.attrGatewayUrl });
    new cdk.CfnOutput(this, 'AccountsBrokenGatewayUrl', { value: accountsBroken.attrGatewayUrl });
    new cdk.CfnOutput(this, 'ServiceBrokenGatewayUrl', { value: serviceBroken.attrGatewayUrl });
    new cdk.CfnOutput(this, 'CoordinatorRuntimeArn', { value: coordinatorRt.attrAgentRuntimeArn });
    new cdk.CfnOutput(this, 'LedgerTable', { value: ledger.tableName });
  }
}
