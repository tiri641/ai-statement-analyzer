import "dotenv/config";
import { BedrockOcrAnalyzer } from "./ai/bedrock-ocr.js";
import { getDatabasePoolConfig } from "./config/database.js";
import { Pool } from "pg";
import { StatementRepository } from "./database/statement-repository.js";
import { SqsJobQueue } from "./queue/sqs-job-queue.js";
import {
  AnalyzeWorker,
  registerWorkerShutdownHandlers,
} from "./worker/analyze-worker.js";
import { createAnalyzeJobHandler } from "./worker/analyze-job-handler.js";
import { S3ObjectStore } from "./storage/s3-object-store.js";
import { createStructuredLogger } from "./observability/logger.js";

const logger = createStructuredLogger({ service: "worker" });

const queueUrl = process.env.SQS_QUEUE_URL;
const region = process.env.AWS_REGION ?? "ap-northeast-1";
let databaseConfig: ReturnType<typeof getDatabasePoolConfig> | null = null;
try {
  databaseConfig = getDatabasePoolConfig(process.env);
} catch {
  databaseConfig = null;
}
const s3BucketName = process.env.S3_BUCKET_NAME;
const modelId =
  process.env.BEDROCK_OCR_MODEL_ID ?? "jp.amazon.nova-2-lite-v1:0";
const processingLeaseSeconds = Number(
  process.env.PROCESSING_LEASE_SECONDS ?? "600",
);

if (!queueUrl || !databaseConfig || !s3BucketName) {
  logger.error({
    event: "worker_start_failed",
    errorCode: !queueUrl
      ? "SQS_QUEUE_URL_MISSING"
      : !databaseConfig
        ? "DATABASE_CONFIG_MISSING"
        : "S3_BUCKET_NAME_MISSING",
  });
  process.exitCode = 1;
} else if (
  !Number.isInteger(processingLeaseSeconds) ||
  processingLeaseSeconds <= 0
) {
  logger.error({
    event: "worker_start_failed",
    errorCode: "PROCESSING_LEASE_SECONDS_INVALID",
  });
  process.exitCode = 1;
} else {
  const pool = new Pool(databaseConfig);
  const queue = new SqsJobQueue({ queueUrl, region });
  const statements = new StatementRepository(pool);
  const objectStore = new S3ObjectStore({
    bucketName: s3BucketName,
    region,
  });
  const analyzer = new BedrockOcrAnalyzer({ region, modelId });
  const worker = new AnalyzeWorker({
    queue,
    logger,
    handleJob: createAnalyzeJobHandler({
      statements,
      objectStore,
      analyzer,
      leaseSeconds: processingLeaseSeconds,
      logger,
      modelId,
    }),
  });

  registerWorkerShutdownHandlers(worker);
  try {
    await worker.run();
  } finally {
    await pool.end();
  }
}
