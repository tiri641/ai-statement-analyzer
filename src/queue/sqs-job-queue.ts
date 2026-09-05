import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import {
  analyzeJobMessageSchema,
  InvalidAnalyzeJobMessageError,
  type AnalyzeJobQueue,
  type ReceiveAnalyzeJobOptions,
  type ReceivedAnalyzeJob,
} from "./analyze-job.js";

export interface SqsJobQueueOptions {
  queueUrl: string;
  region: string;
  client?: SQSClient;
}

export class SqsJobQueue implements AnalyzeJobQueue {
  private readonly queueUrl: string;
  private readonly client: SQSClient;

  public constructor(options: SqsJobQueueOptions) {
    this.queueUrl = options.queueUrl;
    this.client =
      options.client ??
      new SQSClient({
        region: options.region,
      });
  }

  public async sendAnalyzeJob(statementId: string): Promise<void> {
    const message = analyzeJobMessageSchema.parse({ statementId });

    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message),
      }),
    );
  }

  public async receiveOne(
    options: ReceiveAnalyzeJobOptions = {},
  ): Promise<ReceivedAnalyzeJob | null> {
    const command = new ReceiveMessageCommand({
      QueueUrl: this.queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 20,
      MessageSystemAttributeNames: ["ApproximateReceiveCount"],
    });
    const result = options.signal
      ? await this.client.send(command, { abortSignal: options.signal })
      : await this.client.send(command);
    const message = result.Messages?.[0];

    if (!message) {
      return null;
    }

    if (!message.MessageId || !message.ReceiptHandle || !message.Body) {
      throw new InvalidAnalyzeJobMessageError();
    }

    let parsedBody: unknown;

    try {
      parsedBody = JSON.parse(message.Body);
    } catch {
      throw new InvalidAnalyzeJobMessageError();
    }

    const parsed = analyzeJobMessageSchema.safeParse(parsedBody);

    if (!parsed.success) {
      throw new InvalidAnalyzeJobMessageError();
    }

    const receiveCount = Number(
      message.Attributes?.ApproximateReceiveCount ?? "1",
    );

    return {
      ...parsed.data,
      messageId: message.MessageId,
      receiptHandle: message.ReceiptHandle,
      receiveCount:
        Number.isInteger(receiveCount) && receiveCount > 0 ? receiveCount : 1,
    };
  }

  public async deleteMessage(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }
}
