import { z } from "zod";

export const analyzeJobMessageSchema = z
  .object({
    statementId: z.string().uuid(),
  })
  .strict();

export type AnalyzeJobMessage = z.infer<typeof analyzeJobMessageSchema>;

export interface ReceivedAnalyzeJob extends AnalyzeJobMessage {
  messageId: string;
  receiptHandle: string;
  receiveCount: number;
}

export interface ReceiveAnalyzeJobOptions {
  signal?: AbortSignal;
}

export interface AnalyzeJobQueue {
  sendAnalyzeJob(statementId: string): Promise<void>;
  receiveOne(
    options?: ReceiveAnalyzeJobOptions,
  ): Promise<ReceivedAnalyzeJob | null>;
  deleteMessage(receiptHandle: string): Promise<void>;
}

export class InvalidAnalyzeJobMessageError extends Error {
  public constructor() {
    super("Analyze job message is invalid");
    this.name = "InvalidAnalyzeJobMessageError";
  }
}
