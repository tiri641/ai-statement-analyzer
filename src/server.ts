import "dotenv/config";
import { serve } from "@hono/node-server";
import { Pool } from "pg";
import { BedrockInsightsAnalyzer } from "./ai/bedrock-insights.js";
import { createApp } from "./app.js";
import { StatementRepository } from "./database/statement-repository.js";
import { MonthlyInsightsService } from "./insights/monthly-insights-service.js";
import { isLoopbackHost } from "./server-safety.js";
import { S3ObjectStore } from "./storage/s3-object-store.js";
import { SqsJobQueue } from "./queue/sqs-job-queue.js";
import { createStructuredLogger } from "./observability/logger.js";

const logger = createStructuredLogger({ service: "api" });

const port = Number(process.env.PORT ?? "3000");
const host = process.env.HOST ?? "127.0.0.1";
const databaseUrl = process.env.DATABASE_URL;
const awsRegion = process.env.AWS_REGION ?? "ap-northeast-1";
const s3BucketName = process.env.S3_BUCKET_NAME;
const sqsQueueUrl = process.env.SQS_QUEUE_URL;
const insightsModelId = process.env.BEDROCK_INSIGHTS_MODEL_ID;
const insightsPromptVersion = process.env.INSIGHTS_PROMPT_VERSION ?? "v1";
const presignedUrlExpiresSeconds = Number(
  process.env.S3_PRESIGNED_URL_EXPIRES_SECONDS ?? "300",
);

if (!isLoopbackHost(host)) {
  logger.error({
    event: "api_start_failed",
    errorCode: "AUTH_REQUIRED_FOR_NON_LOOPBACK_HOST",
  });
  process.exit(1);
}

if (!databaseUrl) {
  logger.error({
    event: "api_start_failed",
    errorCode: "DATABASE_URL_MISSING",
  });
  process.exit(1);
}

if (!s3BucketName) {
  logger.error({
    event: "api_start_failed",
    errorCode: "S3_BUCKET_NAME_MISSING",
  });
  process.exit(1);
}

if (!sqsQueueUrl) {
  logger.error({
    event: "api_start_failed",
    errorCode: "SQS_QUEUE_URL_MISSING",
  });
  process.exit(1);
}

if (
  !Number.isInteger(presignedUrlExpiresSeconds) ||
  presignedUrlExpiresSeconds < 1 ||
  presignedUrlExpiresSeconds > 604800
) {
  logger.error({
    event: "api_start_failed",
    errorCode: "S3_PRESIGNED_URL_EXPIRES_SECONDS_INVALID",
  });
  process.exit(1);
}

const pool = new Pool({
  connectionString: databaseUrl,
  connectionTimeoutMillis: 2_000,
  query_timeout: 2_000,
});
const statements = new StatementRepository(pool);
const monthlyInsights = insightsModelId
  ? new MonthlyInsightsService({
      analytics: statements,
      cache: statements,
      analyzer: new BedrockInsightsAnalyzer({
        region: awsRegion,
        modelId: insightsModelId,
      }),
      modelId: insightsModelId,
      promptVersion: insightsPromptVersion,
      logger,
    })
  : undefined;
const app = createApp({
  database: pool,
  statements,
  analytics: statements,
  objectStore: new S3ObjectStore({
    bucketName: s3BucketName,
    region: awsRegion,
  }),
  jobQueue: new SqsJobQueue({
    queueUrl: sqsQueueUrl,
    region: awsRegion,
  }),
  presignedUrlExpiresSeconds,
  logger,
  ...(monthlyInsights ? { monthlyInsights } : {}),
});
const server = serve(
  {
    fetch: app.fetch,
    hostname: host,
    port,
  },
  (info) => {
    logger.info({
      event: "api_started",
      status: "started",
      host: info.address,
      port: info.port,
    });
  },
);

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  logger.info({ event: "api_shutdown_started", signal, status: "started" });
  server.close();
  await pool.end();
  logger.info({ event: "api_shutdown_completed", status: "completed" });
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});
