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
      pointInTimeRecovery: true,
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
        emailBody: 'You have been invited to Chalk. Your temporary password is {####}.',
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.userPoolClient = this.userPool.addClient('ChalkWebClient', {
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      generateSecret: false,
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
    const lambdaDefaults: Omit<lambda.FunctionProps, 'handler' | 'functionName'> = {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset('dist/lambda'),
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      environment: lambdaEnvironment,
    };

    const roomFn = new lambda.Function(this, 'RoomFunction', {
      ...lambdaDefaults,
      handler: 'room.handler',
      functionName: 'chalk-room',
    });

    const threadFn = new lambda.Function(this, 'ThreadFunction', {
      ...lambdaDefaults,
      handler: 'thread.handler',
      functionName: 'chalk-thread',
    });

    const aiFn = new lambda.Function(this, 'AIFunction', {
      ...lambdaDefaults,
      handler: 'ai.handler',
      functionName: 'chalk-ai',
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
    });

    const adrFn = new lambda.Function(this, 'ADRFunction', {
      ...lambdaDefaults,
      handler: 'adr.handler',
      functionName: 'chalk-adr',
      timeout: cdk.Duration.seconds(60),
    });

    const searchFn = new lambda.Function(this, 'SearchFunction', {
      ...lambdaDefaults,
      handler: 'search.handler',
      functionName: 'chalk-search',
    });

    const diagramFn = new lambda.Function(this, 'DiagramFunction', {
      ...lambdaDefaults,
      handler: 'diagram.handler',
      functionName: 'chalk-diagram',
      timeout: cdk.Duration.seconds(60),
    });

    const teamFn = new lambda.Function(this, 'TeamFunction', {
      ...lambdaDefaults,
      handler: 'team.handler',
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
      authorizer,
    });
    this.httpApi.addRoutes({
      path: '/rooms/{roomId}',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('RoomByIdIntegration', roomFn),
      authorizer,
    });

    // Thread routes
    this.httpApi.addRoutes({
      path: '/rooms/{roomId}/threads',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('ThreadCreateIntegration', threadFn),
      authorizer,
    });
    this.httpApi.addRoutes({
      path: '/threads/{threadId}/transition',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('ThreadTransitionIntegration', threadFn),
      authorizer,
    });

    // AI / Messaging routes
    this.httpApi.addRoutes({
      path: '/threads/{threadId}/messages',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('AIMessageIntegration', aiFn),
      authorizer,
    });

    // ADR routes
    this.httpApi.addRoutes({
      path: '/threads/{threadId}/decide',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('ADRDecideIntegration', adrFn),
      authorizer,
    });
    this.httpApi.addRoutes({
      path: '/rooms/{roomId}/adrs',
      methods: [apigatewayv2.HttpMethod.GET],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('ADRListIntegration', adrFn),
      authorizer,
    });

    // Search routes
    this.httpApi.addRoutes({
      path: '/rooms/{roomId}/search',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('SearchIntegration', searchFn),
      authorizer,
    });

    // Diagram routes
    this.httpApi.addRoutes({
      path: '/threads/{threadId}/diagram',
      methods: [apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('DiagramIntegration', diagramFn),
      authorizer,
    });

    // Team management routes
    this.httpApi.addRoutes({
      path: '/teams/{teamId}/members',
      methods: [apigatewayv2.HttpMethod.GET, apigatewayv2.HttpMethod.POST],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('TeamMembersIntegration', teamFn),
      authorizer,
    });
    this.httpApi.addRoutes({
      path: '/teams/{teamId}/members/{userId}',
      methods: [apigatewayv2.HttpMethod.DELETE, apigatewayv2.HttpMethod.PATCH],
      integration: new apigatewayv2Integrations.HttpLambdaIntegration('TeamMemberIntegration', teamFn),
      authorizer,
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
  }
}
