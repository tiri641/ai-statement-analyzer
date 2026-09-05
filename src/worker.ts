import "dotenv/config";
import { SqsJobQueue } from "./queue/sqs-job-queue.js";
import {
  AnalyzeWorker,
  registerWorkerShutdownHandlers,
  type WorkerLogger,
} from "./worker/analyze-worker.js";

const queueUrl = process.env.SQS_QUEUE_URL;
const region = process.env.AWS_REGION ?? "ap-northeast-1";

if (!queueUrl) {
  console.error(
    JSON.stringify({
      event: "worker_start_failed",
      errorCode: "SQS_QUEUE_URL_MISSING",
    }),
  );
  process.exitCode = 1;
} else {
  const logger: WorkerLogger = {
    info: (fields) => console.log(JSON.stringify(fields)),
    error: (fields) => console.error(JSON.stringify(fields)),
  };
  const queue = new SqsJobQueue({ queueUrl, region });
  const worker = new AnalyzeWorker({
    queue,
    logger,
    handleJob: async (job) => {
      logger.info({
        event: "worker_job_handler_recorded",
        messageId: job.messageId,
        statementId: job.statementId,
        receiveCount: job.receiveCount,
      });
    },
  });

  registerWorkerShutdownHandlers(worker);
  await worker.run();
}
