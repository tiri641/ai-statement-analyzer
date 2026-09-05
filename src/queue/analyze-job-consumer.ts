import type {
  AnalyzeJobQueue,
  ReceivedAnalyzeJob,
} from "./analyze-job.js";

export type ConsumeOneAnalyzeJobResult =
  | { status: "EMPTY" }
  | {
      status: "DELETED";
      messageId: string;
      statementId: string;
      receiveCount: number;
    };

export async function consumeOneAnalyzeJob(
  queue: AnalyzeJobQueue,
): Promise<ConsumeOneAnalyzeJobResult> {
  const job: ReceivedAnalyzeJob | null = await queue.receiveOne();

  if (!job) {
    return { status: "EMPTY" };
  }

  await queue.deleteMessage(job.receiptHandle);

  return {
    status: "DELETED",
    messageId: job.messageId,
    statementId: job.statementId,
    receiveCount: job.receiveCount,
  };
}
