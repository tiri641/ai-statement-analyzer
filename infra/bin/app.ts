import "dotenv/config";
import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import { ApplicationStack } from "../lib/application-stack.js";
import { ContainerRegistryStack } from "../lib/container-registry-stack.js";
import { DatabaseStack } from "../lib/database-stack.js";
import { MessagingStack } from "../lib/messaging-stack.js";
import { NetworkStack } from "../lib/network-stack.js";
import { ObservabilityStack } from "../lib/observability-stack.js";
import { StorageStack } from "../lib/storage-stack.js";
import { normalizeFrontendOrigin } from "../lib/frontend-origin.js";

const app = new cdk.App();
const region =
  process.env.AWS_REGION ??
  process.env.CDK_DEFAULT_REGION ??
  app.node.tryGetContext("region") ??
  "ap-northeast-1";
const account = process.env.CDK_DEFAULT_ACCOUNT;
const frontendOrigin = normalizeFrontendOrigin(
  process.env.FRONTEND_ORIGIN ??
    app.node.tryGetContext("frontendOrigin") ??
    "http://localhost:5173",
);
const rawRetentionDays = Number(
  process.env.S3_RAW_RETENTION_DAYS ??
    app.node.tryGetContext("rawRetentionDays") ??
    "7",
);
const vpcCidr =
  process.env.VPC_CIDR ?? app.node.tryGetContext("vpcCidr") ?? "10.0.0.0/16";
const natGateways = Number(
  process.env.NAT_GATEWAYS ?? app.node.tryGetContext("natGateways") ?? "1",
);
const imageTag =
  process.env.ECR_IMAGE_TAG ?? app.node.tryGetContext("imageTag") ?? "local";
const apiDesiredCount = Number(
  process.env.ECS_API_DESIRED_COUNT ??
    app.node.tryGetContext("apiDesiredCount") ??
    "0",
);
const workerDesiredCount = Number(
  process.env.ECS_WORKER_DESIRED_COUNT ??
    app.node.tryGetContext("workerDesiredCount") ??
    "0",
);
const ocrModelId =
  process.env.BEDROCK_OCR_MODEL_ID ??
  app.node.tryGetContext("ocrModelId") ??
  "jp.amazon.nova-2-lite-v1:0";
const insightsModelId =
  process.env.BEDROCK_INSIGHTS_MODEL_ID ??
  app.node.tryGetContext("insightsModelId");
const ocrFoundationModelArns = parseCommaSeparatedList(
  process.env.BEDROCK_OCR_FOUNDATION_MODEL_ARNS,
);
const insightsFoundationModelArns = parseCommaSeparatedList(
  process.env.BEDROCK_INSIGHTS_FOUNDATION_MODEL_ARNS,
);
const certificateArn =
  process.env.INTERNAL_ALB_CERTIFICATE_ARN ??
  app.node.tryGetContext("certificateArn");
const processingLeaseSeconds = Number(
  process.env.PROCESSING_LEASE_SECONDS ??
    app.node.tryGetContext("processingLeaseSeconds") ??
    "600",
);

const env: cdk.Environment = account ? { account, region } : { region };

const storage = new StorageStack(app, "StorageStack", {
  env,
  frontendOrigin,
  rawRetentionDays,
});

const messaging = new MessagingStack(app, "MessagingStack", { env });

const oldestMessageAgeSeconds = Number(
  process.env.OBSERVABILITY_OLDEST_MESSAGE_AGE_SECONDS ??
    app.node.tryGetContext("observabilityOldestMessageAgeSeconds") ??
    "600",
);
const workerErrorThreshold = Number(
  process.env.OBSERVABILITY_WORKER_ERROR_THRESHOLD ??
    app.node.tryGetContext("observabilityWorkerErrorThreshold") ??
    "3",
);
const bedrockErrorThreshold = Number(
  process.env.OBSERVABILITY_BEDROCK_ERROR_THRESHOLD ??
    app.node.tryGetContext("observabilityBedrockErrorThreshold") ??
    "3",
);

const observability = new ObservabilityStack(app, "ObservabilityStack", {
  env,
  analyzeQueue: messaging.analyzeQueue,
  alertsTopic: messaging.analyzeAlertsTopic,
  oldestMessageAgeSeconds,
  workerErrorThreshold,
  bedrockErrorThreshold,
});

const network = new NetworkStack(app, "NetworkStack", {
  env,
  vpcCidr,
  natGateways,
});
const registry = new ContainerRegistryStack(app, "ContainerRegistryStack", {
  env,
});
const database = new DatabaseStack(app, "DatabaseStack", {
  env,
  vpc: network.vpc,
  databaseSecurityGroup: network.databaseSecurityGroup,
});

const applicationProps = {
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
  apiLogGroup: observability.apiLogGroup,
  workerLogGroup: observability.workerLogGroup,
  imageTag,
  frontendOrigin,
  apiDesiredCount,
  workerDesiredCount,
  ocrModelId,
  ...(ocrFoundationModelArns ? { ocrFoundationModelArns } : {}),
  processingLeaseSeconds,
  ...(insightsModelId ? { insightsModelId } : {}),
  ...(insightsFoundationModelArns ? { insightsFoundationModelArns } : {}),
  ...(certificateArn ? { certificateArn } : {}),
};

new ApplicationStack(app, "ApplicationStack", applicationProps);

function parseCommaSeparatedList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const values = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

  return values.length > 0 ? values : undefined;
}
