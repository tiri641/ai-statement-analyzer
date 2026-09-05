import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AnalyzeWorker,
  registerWorkerShutdownHandlers,
  type WorkerLogger,
} from "../src/worker/analyze-worker.ts";
import {
  InvalidAnalyzeJobMessageError,
  type AnalyzeJobQueue,
  type ReceivedAnalyzeJob,
} from "../src/queue/analyze-job.ts";

const statementId = "019abc00-0000-7000-8000-000000000001";

function createJob(overrides: Partial<ReceivedAnalyzeJob> = {}): ReceivedAnalyzeJob {
  return {
    messageId: "message-1",
    receiptHandle: "receipt-1",
    statementId,
    receiveCount: 1,
    ...overrides,
  };
}

function createLogger() {
  const events: Array<{ level: "info" | "error"; fields: Record<string, unknown> }> = [];
  const logger: WorkerLogger = {
    info: (fields) => events.push({ level: "info", fields }),
    error: (fields) => events.push({ level: "error", fields }),
  };
  return { events, logger };
}

function createQueue(overrides: Partial<AnalyzeJobQueue>): AnalyzeJobQueue {
  return {
    sendAnalyzeJob: async () => undefined,
    receiveOne: async () => null,
    deleteMessage: async () => undefined,
    ...overrides,
  };
}

test("Workerは処理関数の成功後にMessageを削除する", async () => {
  const events: string[] = [];
  let worker!: AnalyzeWorker;
  const job = createJob();
  const queue = createQueue({
    receiveOne: async () => {
      worker.requestShutdown();
      return job;
    },
    deleteMessage: async (receiptHandle) => {
      events.push(`delete:${receiptHandle}`);
    },
  });
  worker = new AnalyzeWorker({
    queue,
    handleJob: async (receivedJob) => {
      events.push(`handle:${receivedJob.statementId}`);
    },
  });

  await worker.run();

  assert.deepEqual(events, [`handle:${statementId}`, "delete:receipt-1"]);
});

test("WorkerはMessageを1件ずつ順番に処理する", async () => {
  const events: string[] = [];
  let worker!: AnalyzeWorker;
  let receiveCount = 0;
  let activeHandlers = 0;
  let maximumActiveHandlers = 0;
  const queue = createQueue({
    receiveOne: async () => {
      receiveCount += 1;
      if (receiveCount === 1) {
        return createJob({ messageId: "message-1", receiptHandle: "receipt-1" });
      }
      if (receiveCount === 2) {
        worker.requestShutdown();
        return createJob({ messageId: "message-2", receiptHandle: "receipt-2" });
      }
      return null;
    },
    deleteMessage: async (receiptHandle) => {
      events.push(`delete:${receiptHandle}`);
    },
  });
  worker = new AnalyzeWorker({
    queue,
    handleJob: async (job) => {
      activeHandlers += 1;
      maximumActiveHandlers = Math.max(maximumActiveHandlers, activeHandlers);
      events.push(`start:${job.messageId}`);
      await Promise.resolve();
      events.push(`end:${job.messageId}`);
      activeHandlers -= 1;
    },
  });

  await worker.run();

  assert.equal(maximumActiveHandlers, 1);
  assert.deepEqual(events, [
    "start:message-1",
    "end:message-1",
    "delete:receipt-1",
    "start:message-2",
    "end:message-2",
    "delete:receipt-2",
  ]);
});

test("Workerは空のQueueでも受信を継続する", async () => {
  let worker!: AnalyzeWorker;
  let receiveCount = 0;
  const queue = createQueue({
    receiveOne: async () => {
      receiveCount += 1;
      if (receiveCount === 3) {
        worker.requestShutdown();
      }
      return null;
    },
  });
  worker = new AnalyzeWorker({
    queue,
    handleJob: async () => undefined,
  });

  await worker.run();

  assert.equal(receiveCount, 3);
});

test("Workerは処理関数が失敗したMessageを削除せず継続する", async () => {
  let worker!: AnalyzeWorker;
  let receiveCount = 0;
  let deleteCount = 0;
  const { events, logger } = createLogger();
  const queue = createQueue({
    receiveOne: async () => {
      receiveCount += 1;
      if (receiveCount === 1) {
        return createJob();
      }
      worker.requestShutdown();
      return null;
    },
    deleteMessage: async () => {
      deleteCount += 1;
    },
  });
  worker = new AnalyzeWorker({
    queue,
    logger,
    handleJob: async () => {
      throw new Error("database password must not be logged");
    },
  });

  await worker.run();

  assert.equal(deleteCount, 0);
  assert.equal(events.some(({ fields }) => fields.errorCode === "Error"), true);
  assert.equal(
    JSON.stringify(events).includes("database password"),
    false,
  );
});

test("WorkerはDeleteMessage失敗時も継続する", async () => {
  let worker!: AnalyzeWorker;
  let receiveCount = 0;
  const { events, logger } = createLogger();
  const queue = createQueue({
    receiveOne: async () => {
      receiveCount += 1;
      if (receiveCount === 1) {
        return createJob();
      }
      worker.requestShutdown();
      return null;
    },
    deleteMessage: async () => {
      throw new Error("receipt handle must not be logged");
    },
  });
  worker = new AnalyzeWorker({
    queue,
    logger,
    handleJob: async () => undefined,
  });

  await worker.run();

  assert.equal(
    events.some(({ fields }) => fields.event === "worker_delete_failed"),
    true,
  );
  assert.equal(JSON.stringify(events).includes("receipt handle"), false);
});

test("WorkerはReceiveエラー後にバックオフして受信を継続する", async () => {
  let worker!: AnalyzeWorker;
  let receiveCount = 0;
  const backoffValues: number[] = [];
  const queue = createQueue({
    receiveOne: async () => {
      receiveCount += 1;
      if (receiveCount === 1) {
        throw new Error("temporary network error");
      }
      worker.requestShutdown();
      return null;
    },
  });
  worker = new AnalyzeWorker({
    queue,
    handleJob: async () => undefined,
    sleep: async (milliseconds) => {
      backoffValues.push(milliseconds);
    },
  });

  await worker.run();

  assert.deepEqual(backoffValues, [1_000]);
});

test("WorkerのReceiveエラーのバックオフは30秒を上限にする", async () => {
  let worker!: AnalyzeWorker;
  let receiveCount = 0;
  const backoffValues: number[] = [];
  const queue = createQueue({
    receiveOne: async () => {
      receiveCount += 1;
      if (receiveCount <= 6) {
        throw new Error("temporary network error");
      }
      worker.requestShutdown();
      return null;
    },
  });
  worker = new AnalyzeWorker({
    queue,
    handleJob: async () => undefined,
    sleep: async (milliseconds) => {
      backoffValues.push(milliseconds);
    },
  });

  await worker.run();

  assert.deepEqual(backoffValues, [
    1_000,
    2_000,
    4_000,
    8_000,
    16_000,
    30_000,
  ]);
});

test("Workerはバックオフ中のShutdownで次のReceiveを開始しない", async () => {
  let worker!: AnalyzeWorker;
  let receiveCount = 0;
  const queue = createQueue({
    receiveOne: async () => {
      receiveCount += 1;
      throw new Error("temporary network error");
    },
  });
  worker = new AnalyzeWorker({
    queue,
    handleJob: async () => undefined,
    sleep: async () => {
      worker.requestShutdown();
      await new Promise<void>(() => undefined);
    },
  });

  await worker.run();

  assert.equal(receiveCount, 1);
});

test("Workerは不正Messageを削除せずLoopを継続する", async () => {
  let worker!: AnalyzeWorker;
  let receiveCount = 0;
  let deleteCount = 0;
  const { events, logger } = createLogger();
  const queue = createQueue({
    receiveOne: async () => {
      receiveCount += 1;
      if (receiveCount === 1) {
        throw new InvalidAnalyzeJobMessageError();
      }
      worker.requestShutdown();
      return null;
    },
    deleteMessage: async () => {
      deleteCount += 1;
    },
  });
  worker = new AnalyzeWorker({
    queue,
    logger,
    handleJob: async () => undefined,
  });

  await worker.run();

  assert.equal(deleteCount, 0);
  assert.equal(
    events.some(({ fields }) => fields.event === "worker_message_invalid"),
    true,
  );
});

test("WorkerはReceive中のShutdownでAbortされて終了する", async () => {
  let receiveCount = 0;
  let receivedSignal: AbortSignal | undefined;
  const queue = createQueue({
    receiveOne: async (options) => {
      receiveCount += 1;
      receivedSignal = options?.signal;
      return new Promise<null>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    },
  });
  const worker = new AnalyzeWorker({
    queue,
    handleJob: async () => undefined,
  });
  const running = worker.run();

  await new Promise<void>((resolve) => setImmediate(resolve));
  worker.requestShutdown();
  await running;

  assert.equal(receiveCount, 1);
  assert.equal(receivedSignal?.aborted, true);
});

test("Workerは処理中のShutdownで処理と削除の完了を待つ", async () => {
  const events: string[] = [];
  let worker!: AnalyzeWorker;
  const queue = createQueue({
    receiveOne: async () => createJob(),
    deleteMessage: async () => {
      events.push("delete");
    },
  });
  worker = new AnalyzeWorker({
    queue,
    handleJob: async () => {
      events.push("handle-start");
      worker.requestShutdown();
      await Promise.resolve();
      events.push("handle-end");
    },
  });

  await worker.run();

  assert.deepEqual(events, ["handle-start", "handle-end", "delete"]);
});

test("SIGTERMとSIGINTはWorkerへShutdownを要求する", () => {
  const registered = new Map<string, () => void>();
  const emitter = {
    once: (signal: "SIGTERM" | "SIGINT", listener: () => void) => {
      registered.set(signal, listener);
    },
  };
  let shutdownCount = 0;
  registerWorkerShutdownHandlers(
    {
      requestShutdown: () => {
        shutdownCount += 1;
      },
    },
    emitter,
  );

  registered.get("SIGTERM")?.();
  registered.get("SIGINT")?.();

  assert.equal(shutdownCount, 2);
});
