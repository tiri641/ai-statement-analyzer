import assert from "node:assert/strict";
import { test } from "node:test";
import { createAnalyzeJobHandler } from "../src/worker/analyze-job-handler.ts";
import type {
  OcrAnalysisResult,
  OcrImageInput,
} from "../src/ai/bedrock-ocr.ts";
import type {
  CreateTransactionInput,
  ProcessingClaim,
  StatementRecord,
} from "../src/database/statement-repository.ts";
import type { StatementObjectStore } from "../src/storage/object-store.ts";
import {
  AnalyzeWorker,
  type WorkerLogger,
} from "../src/worker/analyze-worker.ts";
import type {
  AnalyzeJobQueue,
  ReceivedAnalyzeJob,
} from "../src/queue/analyze-job.ts";

const statementId = "019abc00-0000-7000-8000-000000000001";

const claim: ProcessingClaim = {
  statementId,
  s3Key: `statements/${statementId}/source`,
  contentType: "image/jpeg",
  contentLength: 4,
  processingStartedAt: new Date("2026-09-06T00:00:00.000Z"),
  processingLeaseExpiresAt: new Date("2026-09-06T00:10:00.000Z"),
  processingToken: "00000000-0000-4000-8000-000000000011",
};

const job: ReceivedAnalyzeJob = {
  messageId: "message-1",
  receiptHandle: "receipt-1",
  statementId,
  receiveCount: 1,
};

function createStatement(status: StatementRecord["status"]): StatementRecord {
  return {
    id: statementId,
    ownerId: null,
    s3Key: claim.s3Key,
    targetMonth: "2026-08-01",
    status,
    contentType: "image/jpeg",
    contentLength: 4,
    processingStartedAt: claim.processingStartedAt,
    processingLeaseExpiresAt: claim.processingLeaseExpiresAt,
    processingToken: claim.processingToken,
    processedAt: null,
    failureCode: null,
    failureMessage: null,
    createdAt: claim.processingStartedAt,
    updatedAt: claim.processingStartedAt,
  };
}

function createObjectStore(
  getObject: StatementObjectStore["getObject"],
): StatementObjectStore {
  return {
    createPresignedPutUrl: async () => "https://s3.example.test/upload",
    headObject: async () => ({
      contentType: "image/jpeg",
      contentLength: 4,
    }),
    getObject,
  };
}

function createAnalyzer(
  analyze: (image: OcrImageInput) => Promise<OcrAnalysisResult>,
) {
  return { analyze };
}

function createLogger(): WorkerLogger {
  return {
    info: () => undefined,
    error: () => undefined,
  };
}

test("Analyze Job HandlerはclaimからCOMMITまでの依存呼び出し順を守る", async () => {
  const events: string[] = [];
  let receivedImage: OcrImageInput | undefined;
  const processingToken = claim.processingToken;
  const handler = createAnalyzeJobHandler({
    statements: {
      findById: async () => createStatement("PROCESSING"),
      claimForProcessing: async (_id, token) => {
        events.push(`claim:${token}`);
        return claim;
      },
      saveTransactionsAndComplete: async (
        id: string,
        token: string,
        transactions: CreateTransactionInput[],
      ) => {
        events.push(`save:${id}:${token}:${transactions.length}`);
      },
    },
    objectStore: createObjectStore(async (key, options) => {
      events.push(`get:${key}`);
      assert.equal(options?.signal, abortController.signal);
      return {
        bytes: new Uint8Array([1, 2, 3, 4]),
        contentType: "image/jpeg",
        contentLength: 4,
      };
    }),
    analyzer: createAnalyzer(async (image) => {
      events.push("ocr");
      receivedImage = image;
      return {
        transactions: [
          {
            lineNumber: 1,
            transactionDate: "2026-08-20",
            merchantRaw: "AMAZON.CO.JP",
            merchantName: "Amazon",
            amount: 3980,
            category: "買い物",
            subcategory: "EC",
          },
        ],
        usage: null,
      };
    }),
    tokenGenerator: () => processingToken,
  });
  const abortController = new AbortController();

  const result = await handler(job, { signal: abortController.signal });

  assert.equal(result, "ACK");
  assert.deepEqual(events, [
    `claim:${processingToken}`,
    `get:${claim.s3Key}`,
    "ocr",
    `save:${statementId}:${processingToken}:1`,
  ]);
  assert.deepEqual(receivedImage, {
    bytes: new Uint8Array([1, 2, 3, 4]),
    contentType: "image/jpeg",
  });
});

test("Analyze Job HandlerはCOMPLETEDの重複Messageを追加処理せずACKする", async () => {
  let getCount = 0;
  let ocrCount = 0;
  const handler = createAnalyzeJobHandler({
    statements: {
      findById: async () => createStatement("COMPLETED"),
      claimForProcessing: async () => null,
      saveTransactionsAndComplete: async () => undefined,
    },
    objectStore: createObjectStore(async () => {
      getCount += 1;
      return {
        bytes: new Uint8Array([1, 2, 3, 4]),
        contentType: "image/jpeg",
        contentLength: 4,
      };
    }),
    analyzer: createAnalyzer(async () => {
      ocrCount += 1;
      return { transactions: [], usage: null };
    }),
  });

  assert.equal(await handler(job), "ACK");
  assert.equal(getCount, 0);
  assert.equal(ocrCount, 0);
});

test("Analyze Job Handlerは存在しないstatementの孤立MessageをACKする", async () => {
  const handler = createAnalyzeJobHandler({
    statements: {
      findById: async () => null,
      claimForProcessing: async () => null,
      saveTransactionsAndComplete: async () => undefined,
    },
    objectStore: createObjectStore(async () => {
      throw new Error("S3 must not be called");
    }),
    analyzer: createAnalyzer(async () => {
      throw new Error("OCR must not be called");
    }),
  });

  assert.equal(await handler(job), "ACK");
});

test("Analyze Job Handlerは有効なPROCESSINGの重複MessageをACKしない", async () => {
  const handler = createAnalyzeJobHandler({
    statements: {
      findById: async () => createStatement("PROCESSING"),
      claimForProcessing: async () => null,
      saveTransactionsAndComplete: async () => undefined,
    },
    objectStore: createObjectStore(async () => {
      throw new Error("S3 must not be called");
    }),
    analyzer: createAnalyzer(async () => {
      throw new Error("OCR must not be called");
    }),
  });

  assert.equal(await handler(job), "RETRY");
});

test("Analyze Job HandlerはS3 Metadata不一致時にOCRを呼ばない", async () => {
  let ocrCount = 0;
  const handler = createAnalyzeJobHandler({
    statements: {
      findById: async () => createStatement("PROCESSING"),
      claimForProcessing: async () => claim,
      saveTransactionsAndComplete: async () => undefined,
    },
    objectStore: createObjectStore(async () => ({
      bytes: new Uint8Array([1, 2, 3, 4]),
      contentType: "image/png",
      contentLength: 4,
    })),
    analyzer: createAnalyzer(async () => {
      ocrCount += 1;
      return { transactions: [], usage: null };
    }),
    tokenGenerator: () => claim.processingToken,
  });

  await assert.rejects(handler(job), /S3 object metadata does not match/);
  assert.equal(ocrCount, 0);
});

test("AnalyzeWorkerはhandlerのRETRY結果でMessageを削除しない", async () => {
  let worker!: AnalyzeWorker;
  let deleteCount = 0;
  const queue: AnalyzeJobQueue = {
    sendAnalyzeJob: async () => undefined,
    receiveOne: async () => {
      worker.requestShutdown();
      return job;
    },
    deleteMessage: async () => {
      deleteCount += 1;
    },
  };
  worker = new AnalyzeWorker({
    queue,
    logger: createLogger(),
    handleJob: async () => "RETRY",
  });

  await worker.run();

  assert.equal(deleteCount, 0);
});
