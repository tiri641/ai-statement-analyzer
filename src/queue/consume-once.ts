import "dotenv/config";
import { SqsJobQueue } from "./sqs-job-queue.js";
import { consumeOneAnalyzeJob } from "./analyze-job-consumer.js";
import { createStructuredLogger } from "../observability/logger.js";

const logger = createStructuredLogger({ service: "consume-once" });

const queueUrl = process.env.SQS_QUEUE_URL;
const region = process.env.AWS_REGION ?? "ap-northeast-1";

if (!queueUrl) {
  logger.error({
    event: "analyze_consumer_start_failed",
    errorCode: "SQS_QUEUE_URL_MISSING",
  });
  process.exitCode = 1;
} else {
  const queue = new SqsJobQueue({ queueUrl, region });

  try {
    const result = await consumeOneAnalyzeJob(queue);
    logger.info({
      event: "analyze_job_consumed",
      ...result,
    });
  } catch {
    logger.error({
      event: "analyze_consumer_failed",
      errorCode: "CONSUME_FAILED",
    });
    process.exitCode = 1;
  }
}
