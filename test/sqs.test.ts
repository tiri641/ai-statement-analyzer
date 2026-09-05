import assert from "node:assert/strict";
import { test } from "node:test";
import { SQSClient } from "@aws-sdk/client-sqs";
import { InvalidAnalyzeJobMessageError } from "../src/queue/analyze-job.ts";
import { SqsJobQueue } from "../src/queue/sqs-job-queue.ts";

const queueUrl = "https://sqs.ap-northeast-1.amazonaws.com/123456789012/analyze";
const statementId = "019abc00-0000-7000-8000-000000000001";

test("SqsJobQueueはstatementIdだけをMessage bodyへ入れて送信する", async () => {
  let commandInput: Record<string, unknown> | undefined;
  const client = {
    send: async (command: { input: Record<string, unknown> }) => {
      commandInput = command.input;
      return { MessageId: "message-1" };
    },
  } as unknown as SQSClient;
  const queue = new SqsJobQueue({
    queueUrl,
    region: "ap-northeast-1",
    client,
  });

  await queue.sendAnalyzeJob(statementId);

  assert.deepEqual(commandInput, {
    QueueUrl: queueUrl,
    MessageBody: JSON.stringify({ statementId }),
  });
});

test("SqsJobQueueはMessageを受信してstatementIdを取り出す", async () => {
  let commandInput: Record<string, unknown> | undefined;
  const client = {
    send: async (command: { input: Record<string, unknown> }) => {
      commandInput = command.input;
      return {
        Messages: [
          {
            MessageId: "message-1",
            ReceiptHandle: "receipt-1",
            Body: JSON.stringify({ statementId }),
            Attributes: { ApproximateReceiveCount: "2" },
          },
        ],
      };
    },
  } as unknown as SQSClient;
  const queue = new SqsJobQueue({
    queueUrl,
    region: "ap-northeast-1",
    client,
  });

  const result = await queue.receiveOne();

  assert.deepEqual(result, {
    messageId: "message-1",
    receiptHandle: "receipt-1",
    statementId,
    receiveCount: 2,
  });
  assert.deepEqual(commandInput, {
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 1,
    WaitTimeSeconds: 20,
    MessageSystemAttributeNames: ["ApproximateReceiveCount"],
  });
});

test("Messageが空のときSqsJobQueueはnullを返す", async () => {
  const client = {
    send: async () => ({ Messages: [] }),
  } as unknown as SQSClient;
  const queue = new SqsJobQueue({
    queueUrl,
    region: "ap-northeast-1",
    client,
  });

  assert.equal(await queue.receiveOne(), null);
});

test("不正なMessageは削除せずValidationエラーにする", async () => {
  const client = {
    send: async () => ({
      Messages: [
        {
          MessageId: "message-1",
          ReceiptHandle: "receipt-1",
          Body: JSON.stringify({ statementId: "not-a-uuid" }),
        },
      ],
    }),
  } as unknown as SQSClient;
  const queue = new SqsJobQueue({
    queueUrl,
    region: "ap-northeast-1",
    client,
  });

  await assert.rejects(
    queue.receiveOne(),
    InvalidAnalyzeJobMessageError,
  );
});

test("SqsJobQueueはReceiptHandleを使ってMessageを削除する", async () => {
  let commandInput: Record<string, unknown> | undefined;
  const client = {
    send: async (command: { input: Record<string, unknown> }) => {
      commandInput = command.input;
      return {};
    },
  } as unknown as SQSClient;
  const queue = new SqsJobQueue({
    queueUrl,
    region: "ap-northeast-1",
    client,
  });

  await queue.deleteMessage("receipt-1");

  assert.deepEqual(commandInput, {
    QueueUrl: queueUrl,
    ReceiptHandle: "receipt-1",
  });
});
