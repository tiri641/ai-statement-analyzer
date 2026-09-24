import "dotenv/config";
import * as cdk from "aws-cdk-lib";
import { MessagingStack } from "../lib/messaging-stack.js";
import { ObservabilityStack } from "../lib/observability-stack.js";
import { StorageStack } from "../lib/storage-stack.js";

const app = new cdk.App();
const region =
  process.env.AWS_REGION ??
  process.env.CDK_DEFAULT_REGION ??
  app.node.tryGetContext("region") ??
  "ap-northeast-1";
const account = process.env.CDK_DEFAULT_ACCOUNT;
const frontendOrigin =
  process.env.FRONTEND_ORIGIN ??
  app.node.tryGetContext("frontendOrigin") ??
  "http://localhost:5173";
const rawRetentionDays = Number(
  process.env.S3_RAW_RETENTION_DAYS ??
    app.node.tryGetContext("rawRetentionDays") ??
    "7",
);

const env: cdk.Environment = account ? { account, region } : { region };

new StorageStack(app, "StorageStack", {
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

new ObservabilityStack(app, "ObservabilityStack", {
  env,
  analyzeQueue: messaging.analyzeQueue,
  alertsTopic: messaging.analyzeAlertsTopic,
  oldestMessageAgeSeconds,
  workerErrorThreshold,
  bedrockErrorThreshold,
});
