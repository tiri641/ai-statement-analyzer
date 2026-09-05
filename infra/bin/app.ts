import "dotenv/config";
import * as cdk from "aws-cdk-lib";
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
