import "dotenv/config";
import { SqsJobQueue } from "./sqs-job-queue.js";
import { consumeOneAnalyzeJob } from "./analyze-job-consumer.js";

const queueUrl = process.env.SQS_QUEUE_URL;
const region = process.env.AWS_REGION ?? "ap-northeast-1";

if (!queueUrl) {
  console.error(
    JSON.stringify({
      event: "analyze_consumer_start_failed",
      errorCode: "SQS_QUEUE_URL_MISSING",
    }),
  );
  process.exitCode = 1;
} else {
  const queue = new SqsJobQueue({ queueUrl, region });

  try {
    const result = await consumeOneAnalyzeJob(queue);
    console.log(
      JSON.stringify({
        event: "analyze_job_consumed",
        ...result,
      }),
    );
  } catch {
    console.error(
      JSON.stringify({
        event: "analyze_consumer_failed",
        errorCode: "CONSUME_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}
