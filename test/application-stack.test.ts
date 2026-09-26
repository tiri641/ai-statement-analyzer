import assert from "node:assert/strict";
import { test } from "node:test";
import * as cdk from "aws-cdk-lib";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { Match, Template } from "aws-cdk-lib/assertions";
import { ApplicationStack } from "../infra/lib/application-stack.ts";
import { ContainerRegistryStack } from "../infra/lib/container-registry-stack.ts";
import { DatabaseStack } from "../infra/lib/database-stack.ts";
import { MessagingStack } from "../infra/lib/messaging-stack.ts";
import { NetworkStack } from "../infra/lib/network-stack.ts";
import { ObservabilityStack } from "../infra/lib/observability-stack.ts";
import { StorageStack } from "../infra/lib/storage-stack.ts";

function createApplicationStack(options: {
  certificateArn?: string;
  ocrModelId?: string;
  ocrFoundationModelArns?: string[];
  insightsModelId?: string;
  insightsFoundationModelArns?: string[];
} = {}) {
  const app = new cdk.App();
  const env = { account: "123456789012", region: "ap-northeast-1" };
  const network = new NetworkStack(app, "NetworkStack", { env });
  const registry = new ContainerRegistryStack(app, "ContainerRegistryStack", {
    env,
  });
  const database = new DatabaseStack(app, "DatabaseStack", {
    env,
    vpc: network.vpc,
    databaseSecurityGroup: network.databaseSecurityGroup,
  });
  const storage = new StorageStack(app, "StorageStack", {
    env,
    frontendOrigin: "http://localhost:5173",
    rawRetentionDays: 7,
  });
  const messaging = new MessagingStack(app, "MessagingStack", { env });
  const observability = new ObservabilityStack(app, "ObservabilityStack", {
    env,
    analyzeQueue: messaging.analyzeQueue,
    alertsTopic: messaging.analyzeAlertsTopic,
  });

  const stack = new ApplicationStack(app, "ApplicationStack", {
    env,
    vpc: network.vpc,
    albSecurityGroup: network.albSecurityGroup,
    apiSecurityGroup: network.apiSecurityGroup,
    workerSecurityGroup: network.workerSecurityGroup,
    database: database.database,
    databaseSecret: database.databaseSecret,
    repository: registry.repository,
    statementBucket: storage.statementBucket as unknown as s3.IBucket,
    analyzeQueue: messaging.analyzeQueue,
    apiLogGroup: observability.apiLogGroup as unknown as logs.ILogGroup,
    workerLogGroup: observability.workerLogGroup as unknown as logs.ILogGroup,
    imageTag: "test-image",
    frontendOrigin: "http://localhost:5173",
    insightsModelId: options.insightsModelId ??
      "arn:aws:bedrock:ap-northeast-1:123456789012:inference-profile/insights-profile",
    insightsFoundationModelArns: options.insightsFoundationModelArns ?? [
      "arn:aws:bedrock:ap-northeast-1::foundation-model/amazon.nova-2-lite-v1:0",
    ],
    ...options,
  });
  return stack;
}

test("ApplicationStackはAPI・Worker・MigrationのTaskとInternal ALBを定義する", () => {
  const stack = createApplicationStack();
  const template = Template.fromStack(stack);

  template.resourceCountIs("AWS::ECS::TaskDefinition", 3);
  template.resourceCountIs("AWS::ECS::Service", 2);
  template.resourceCountIs("AWS::ElasticLoadBalancingV2::LoadBalancer", 1);
  template.resourceCountIs("AWS::ElasticLoadBalancingV2::Listener", 1);
  template.resourceCountIs("AWS::S3::Bucket", 0);
  template.resourceCountIs("AWS::SQS::Queue", 0);
  template.hasResourceProperties("AWS::ElasticLoadBalancingV2::LoadBalancer", {
    Scheme: "internal",
  });
  template.hasResourceProperties("AWS::ECS::Service", {
    DesiredCount: 0,
    LaunchType: "FARGATE",
    NetworkConfiguration: {
      AwsvpcConfiguration: Match.objectLike({
        AssignPublicIp: "DISABLED",
        SecurityGroups: Match.anyValue(),
        Subnets: Match.anyValue(),
      }),
    },
  });
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    Cpu: "256",
    Memory: "512",
    RequiresCompatibilities: ["FARGATE"],
    NetworkMode: "awsvpc",
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        StopTimeout: 30,
        LogConfiguration: Match.objectLike({ LogDriver: "awslogs" }),
      }),
    ]),
  });
  template.hasResourceProperties("AWS::ECS::TaskDefinition", {
    ContainerDefinitions: Match.arrayWith([
      Match.objectLike({
        Command: ["node", "dist/migrate.js"],
        Secrets: Match.arrayWith([
          Match.objectLike({ Name: "DB_USER" }),
          Match.objectLike({ Name: "DB_PASSWORD" }),
        ]),
      }),
    ]),
  });
  template.hasOutput("InternalAlbDnsName", {});
  template.hasOutput("MigrationTaskDefinitionArn", {});
  template.hasOutput("ApiTaskDefinitionArn", {});
  template.hasOutput("WorkerTaskDefinitionArn", {});

  const policies = template.findResources("AWS::IAM::Policy");
  const apiPolicy = Object.entries(policies).find(([logicalId]) =>
    logicalId.startsWith("ApiTaskRoleDefaultPolicy"),
  )?.[1];
  const workerPolicy = Object.entries(policies).find(([logicalId]) =>
    logicalId.startsWith("WorkerTaskRoleDefaultPolicy"),
  )?.[1];
  assert.ok(apiPolicy);
  assert.ok(workerPolicy);
  const apiPolicyJson = JSON.stringify(apiPolicy.Properties.PolicyDocument);
  const workerPolicyJson = JSON.stringify(
    workerPolicy.Properties.PolicyDocument,
  );
  assert.match(apiPolicyJson, /bedrock:InvokeModel/);
  assert.match(apiPolicyJson, /inference-profile\/insights-profile/);
  assert.match(
    workerPolicyJson,
    /inference-profile\/jp.amazon.nova-2-lite-v1:0/,
  );
  assert.match(
    workerPolicyJson,
    /"Ref":"AWS::AccountId".*inference-profile\/jp.amazon.nova-2-lite-v1:0/,
  );
  assert.match(
    workerPolicyJson,
    /ap-northeast-1::foundation-model\/amazon.nova-2-lite-v1:0/,
  );
  assert.match(
    workerPolicyJson,
    /ap-northeast-3::foundation-model\/amazon.nova-2-lite-v1:0/,
  );
  assert.doesNotMatch(apiPolicyJson, /sqs:ReceiveMessage/);
  assert.doesNotMatch(apiPolicyJson, /sqs:GetQueueAttributes/);
  assert.doesNotMatch(workerPolicyJson, /sqs:ChangeMessageVisibility/);
  assert.doesNotMatch(workerPolicyJson, /s3:PutObject/);
  assert.doesNotMatch(workerPolicyJson, /sqs:SendMessage/);

  const executionPolicy = Object.entries(policies).find(([logicalId]) =>
    logicalId.startsWith("EcsExecutionRoleDefaultPolicy"),
  )?.[1];
  assert.ok(executionPolicy);
  assert.match(
    JSON.stringify(executionPolicy.Properties.PolicyDocument),
    /secretsmanager:GetSecretValue/,
  );

  const taskDefinitions = template.findResources("AWS::ECS::TaskDefinition");
  const taskDefinitionsJson = JSON.stringify(taskDefinitions);
  assert.match(taskDefinitionsJson, /Fn::ImportValue/);
  assert.match(taskDefinitionsJson, /ContainerRegistryStack/);
  assert.match(taskDefinitionsJson, /FRONTEND_ORIGIN/);
  assert.ok(stack.apiService);
  assert.ok(stack.workerService);
});

test("ApplicationStackはカスタムInference ProfileにFoundation Model ARNを要求する", () => {
  assert.throws(
    () =>
      createApplicationStack({
        ocrModelId: "apac.amazon.nova-2-lite-v1:0",
      }),
    /apac\.amazon\.nova-2-lite-v1:0 requires the Foundation Model ARNs used by its inference profile/,
  );
});

test("ApplicationStackはカスタムInference Profile ARNをアカウント付きで許可する", () => {
  const template = Template.fromStack(
    createApplicationStack({
      ocrModelId: "apac.amazon.nova-2-lite-v1:0",
      ocrFoundationModelArns: [
        "arn:aws:bedrock:ap-northeast-1::foundation-model/amazon.nova-2-lite-v1:0",
      ],
    }),
  );

  const policies = template.findResources("AWS::IAM::Policy");
  const workerPolicy = Object.entries(policies).find(([logicalId]) =>
    logicalId.startsWith("WorkerTaskRoleDefaultPolicy"),
  )?.[1];
  assert.ok(workerPolicy);
  assert.match(
    JSON.stringify(workerPolicy.Properties.PolicyDocument),
    /"Ref":"AWS::AccountId".*inference-profile\/apac.amazon.nova-2-lite-v1:0/,
  );
});

test("ApplicationStackは証明書ARNがある場合にHTTPS ListenerとHTTPリダイレクトを定義する", () => {
  const template = Template.fromStack(
    createApplicationStack({
      certificateArn: "arn:aws:acm:ap-northeast-1:123456789012:certificate/test",
    }),
  );

  template.resourceCountIs("AWS::ElasticLoadBalancingV2::Listener", 2);
  template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
    Port: 443,
    Protocol: "HTTPS",
    Certificates: [
      {
        CertificateArn:
          "arn:aws:acm:ap-northeast-1:123456789012:certificate/test",
      },
    ],
  });
  template.hasResourceProperties("AWS::ElasticLoadBalancingV2::Listener", {
    Port: 80,
    DefaultActions: [
      {
        Type: "redirect",
        RedirectConfig: {
          Port: "443",
          Protocol: "HTTPS",
          StatusCode: "HTTP_301",
        },
      },
    ],
  });
});
