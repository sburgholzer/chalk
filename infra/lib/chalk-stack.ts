import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigatewayv2Integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as apigatewayv2Authorizers from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as path from 'path';

export class ChalkStack extends cdk.Stack {
  public readonly table: dynamodb.Table;
  public readonly bucket: s3.Bucket;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient;
  public readonly httpApi: apigatewayv2.HttpApi;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // =========================================================================
    // DynamoDB Single-Table Design
    // =========================================================================
    this.table = new dynamodb.Table(this, 'ChalkTable', {
      tableName: 'ChalkTable',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
    });

    // GSI1: Filter threads by status + date
    // PK = ROOM#{roomId}, SK = STATUS#{status}#DATE#{isoDate}
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI2: List rooms for a user
    // PK = USER#{userId}, SK = ROOM#{roomId}
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI3: Get next ADR sequential ID
    // PK = ROOM#{roomId}, SK = ADR_SEQ#{sequentialId}
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI3',
      partitionKey: { name: 'GSI3PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI3SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // =========================================================================
    // S3 Bucket for diagrams and ADR exports
    // =========================================================================
    this.bucket = new s3.Bucket(this, 'ChalkBucket', {
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
    });

    // =========================================================================
    // Cognito User Pool
    // =========================================================================
    this.userPool = new cognito.UserPool(this, 'ChalkUserPool', {
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: {
        email: { required: true, mutable: true },
      },
      passwordPolicy: {
        minLength: 8,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: false,
      },
      userInvitation: {
        emailSubject: 'Your Chalk workspace invitation',
        emailBody: 'You have been invited to Chalk. Your username is {username} and your temporary password is {####}.',
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient('ChalkWebClient', {
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false,
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: ['http://localhost:3000/login'],
        logoutUrls: ['http://localhost:3000/login'],
      },
    });

    // Cognito hosted UI domain
    const userPoolDomain = this.userPool.addDomain('ChalkDomain', {
      cognitoDomain: { domainPrefix: 'chalk-app' },
    });

    // Default team group
    new cognito.CfnUserPoolGroup(this, 'DefaultTeamGroup', {
      userPoolId: this.userPool.userPoolId,
      groupName: 'chalk-team',
      description: 'Default team for Chalk users',
    });

    // =========================================================================
    // Shared Lambda environment variables
    // =========================================================================
    const lambdaEnvironment: Record<string, string> = {
      CHALK_TABLE_NAME: this.table.tableName,
      CHALK_BUCKET_NAME: this.bucket.bucketName,
      AWS_REGION_NAME: cdk.Stack.of(this).region,
      BEDROCK_CLAUDE_MODEL_ID: 'us.anthropic.claude-sonnet-4-6',
      BEDROCK_TITAN_MODEL_ID: 'amazon.titan-embed-text-v1',
      USER_POOL_ID: this.userPool.userPoolId,
    };

    // =========================================================================
    // Lambda Functions
    // =========================================================================
    const lambdaDir = path.join(__dirname, '../../src/lambda');

    const nodejsDefaults: Partial<lambdaNode.NodejsFunctionProps> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: lambdaEnvironment,
      bundling: {
        minify: true,
        sourceMap: true,
        tsconfig: path.join(__dirname, '../../tsconfig.json'),
      },
    };

    const roomFn = new lambdaNode.NodejsFunction(this, 'RoomFunction', {
      ...nodejsDefaults,
      entry: path.join(lambdaDir, 'room.ts'),
      handler: 'handler',
      functionName: 'chalk-room',
    });

    const threadFn = new lambdaNode.NodejsFunction(this, 'ThreadFunction', {
      ...nodejsDefaults,
      entry: path.join(lambdaDir, 'thread.ts'),
      handler: 'handler',
      functionName: 'chalk-thread',
    });

    const aiFn = new lambdaNode.NodejsFunction(this, 'AIFunction', {
      ...nodejsDefaults,
      entry: path.join(lambdaDir, 'ai.ts'),
      handler: 'handler',
      functionName: 'chalk-ai',
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
    });

    const adrFn = new lambdaNode.NodejsFunction(this, 'ADRFunction', {
      ...nodejsDefaults,
      entry: path.join(lambdaDir, 'adr.ts'),
      handler: 'handler',
      functionName: 'chalk-adr',
      timeout: cdk.Duration.seconds(60),
    });

    const searchFn = new lambdaNode.NodejsFunction(this, 'SearchFunction', {
      ...nodejsDefaults,
      entry: path.join(lambdaDir, 'search.ts'),
      handler: 'handler',
      functionName: 'chalk-search',
    });

    const diagramFn = new lambdaNode.NodejsFunction(this, 'DiagramFunction', {
      ...nodejsDefaults,
      entry: path.join(lambdaDir, 'diagram.ts'),
      handler: 'handler',
      functionName: 'chalk-diagram',
      timeout: cdk.Duration.seconds(60),
    });

    const teamFn = new lambdaNode.NodejsFunction(this, 'TeamFunction', {
      ...nodejsDefaults,
      entry: path.join(lambdaDir, 'team.ts'),
      handler: 'handler',
      functionName: 'chalk-team',
    });

    const allLambdas = [roomFn, threadFn, aiFn, adrFn, searchFn, diagramFn, teamFn];

    // =========================================================================
    // IAM Permissions
    // =========================================================================

    // Lambda → DynamoDB
    for (const fn of allLambdas) {
      this.table.grantReadWriteData(fn);
    }

    // Lambda → S3 (ADR exports + diagrams)
    this.bucket.grantReadWrite(adrFn);
    this.bucket.grantReadWrite(diagramFn);
    this.bucket.grantRead(searchFn);

    // Lambda → Bedrock (AI, ADR generation, search embeddings, diagram generation)
    const bedrockPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
      ],
      resources: ['*'],
    });
    aiFn.addToRolePolicy(bedrockPolicy);
    adrFn.addToRolePolicy(bedrockPolicy);
    searchFn.addToRolePolicy(bedrockPolicy);
    diagramFn.addToRolePolicy(bedrockPolicy);

    // Lambda → Cognito (Team management operations)
    const cognitoPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:AdminCreateUser',
        'cognito-idp:AdminAddUserToGroup',
        'cognito-idp:AdminRemoveUserFromGroup',
        'cognito-idp:AdminGetUser',
        'cognito-idp:ListUsersInGroup',
        'cognito-idp:CreateGroup',
      ],
      resources: [this.userPool.userPoolArn],
    });
    teamFn.addToRolePolicy(cognitoPolicy);

    // =========================================================================
    // API Gateway HTTP API with Cognito Authorizer
    // =========================================================================
    const authorizer = new apigatewayv2Authorizers.HttpUserPoolAuthorizer(
      'ChalkAuthorizer',
      this.userPool,
      {
        userPoolClients: [this.userPoolClient],
      }
    );

    this.httpApi = new apigatewayv2.HttpApi(this, 'ChalkHttpApi', {
      apiName: 'chalk-api',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.PUT,
          apigatewayv2.CorsHttpMethod.PATCH,
          apigatewayv2.CorsHttpMethod.DELETE,
        ],
        allowHeaders: ['Authorization', 'Content-Type'],
      },
    });

    // Room routes
    this.httpApi.addRoutes({
      path: '/rooms',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('RoomIntegration', roomFn),

    });
    this.httpApi.addRoutes({
      path: '/rooms/{roomId}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('RoomByIdIntegration', roomFn),

    });

    // Thread routes
    this.httpApi.addRoutes({
      path: '/rooms/{roomId}/threads',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('ThreadCreateIntegration', threadFn),

    });
    this.httpApi.addRoutes({
      path: '/threads/{threadId}/transition',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('ThreadTransitionIntegration', threadFn),

    });

    // AI / Messaging routes
    this.httpApi.addRoutes({
      path: '/threads/{threadId}/messages',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('AIMessageIntegration', aiFn),

    });

    // ADR routes
    this.httpApi.addRoutes({
      path: '/threads/{threadId}/decide',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('ADRDecideIntegration', adrFn),

    });
    this.httpApi.addRoutes({
      path: '/rooms/{roomId}/adrs',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('ADRListIntegration', adrFn),

    });

    // Search routes
    this.httpApi.addRoutes({
      path: '/rooms/{roomId}/search',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('SearchIntegration', searchFn),

    });

    // Diagram routes
    this.httpApi.addRoutes({
      path: '/threads/{threadId}/diagram',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('DiagramIntegration', diagramFn),

    });

    // Team management routes
    this.httpApi.addRoutes({
      path: '/teams/{teamId}/members',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('TeamMembersIntegration', teamFn),

    });
    this.httpApi.addRoutes({
      path: '/teams/{teamId}/members/{userId}',
      methods: [apigatewayv2.HttpMethod.DELETE, apigatewayv2.HttpMethod.PATCH],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('TeamMemberIntegration', teamFn),

    });

    // =========================================================================
    // Stack Outputs
    // =========================================================================
    new cdk.CfnOutput(this, 'ApiUrl', {
      value: this.httpApi.apiEndpoint,
      description: 'HTTP API endpoint URL',
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Cognito User Pool ID',
    });

    new cdk.CfnOutput(this, 'UserPoolClientId', {
      value: this.userPoolClient.userPoolClientId,
      description: 'Cognito User Pool Client ID',
    });

    new cdk.CfnOutput(this, 'TableName', {
      value: this.table.tableName,
      description: 'DynamoDB table name',
    });

    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      description: 'S3 bucket name',
    });

    new cdk.CfnOutput(this, 'CognitoDomain', {
      value: `https://${userPoolDomain.domainName}.auth.${cdk.Stack.of(this).region}.amazoncognito.com`,
      description: 'Cognito hosted UI domain',
    });

    new cdk.CfnOutput(this, 'DefaultTeamId', {
      value: 'chalk-team',
      description: 'Default Cognito group (team ID)',
    });
  }
}
