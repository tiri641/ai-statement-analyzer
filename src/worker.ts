import "dotenv/config";
import { BedrockOcrAnalyzer } from "./ai/bedrock-ocr.js";
import { Pool } from "pg";
import { StatementRepository } from "./database/statement-repository.js";
import { SqsJobQueue } from "./queue/sqs-job-queue.js";
import {
  AnalyzeWorker,
  registerWorkerShutdownHandlers,
  type WorkerLogger,
} from "./worker/analyze-worker.js";
import { createAnalyzeJobHandler } from "./worker/analyze-job-handler.js";
import { S3ObjectStore } from "./storage/s3-object-store.js";

const queueUrl = process.env.SQS_QUEUE_URL;
const region = process.env.AWS_REGION ?? "ap-northeast-1";
const databaseUrl = process.env.DATABASE_URL;
const s3BucketName = process.env.S3_BUCKET_NAME;
const modelId =
  process.env.BEDROCK_OCR_MODEL_ID ?? "jp.amazon.nova-2-lite-v1:0";
const processingLeaseSeconds = Number(
  process.env.PROCESSING_LEASE_SECONDS ?? "600",
);

if (!queueUrl || !databaseUrl || !s3BucketName) {
  console.error(
    JSON.stringify({
      event: "worker_start_failed",
      errorCode: !queueUrl
        ? "SQS_QUEUE_URL_MISSING"
        : !databaseUrl
          ? "DATABASE_URL_MISSING"
          : "S3_BUCKET_NAME_MISSING",
    }),
  );
  process.exitCode = 1;
} else if (
  !Number.isInteger(processingLeaseSeconds) ||
  processingLeaseSeconds <= 0
) {
  console.error(
    JSON.stringify({
      event: "worker_start_failed",
      errorCode: "PROCESSING_LEASE_SECONDS_INVALID",
    }),
  );
  process.exitCode = 1;
} else {
  const logger: WorkerLogger = {
    info: (fields) => console.log(JSON.stringify(fields)),
    error: (fields) => console.error(JSON.stringify(fields)),
  };
  const pool = new Pool({ connectionString: databaseUrl });
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
    }),
  });

  registerWorkerShutdownHandlers(worker);
  try {
    await worker.run();
  } finally {
    await pool.end();
  }
}
