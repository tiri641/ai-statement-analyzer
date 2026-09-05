import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, type StatementStore } from "../src/app.ts";
import type {
  CreateStatementInput,
  StatementRecord,
} from "../src/database/statement-repository.ts";
import type { StatementObjectStore } from "../src/storage/object-store.ts";
import type { AnalyzeJobQueue } from "../src/queue/analyze-job.ts";

const statementId = "019abc00-0000-7000-8000-000000000001";

function createStatementRecord(
  overrides: Partial<StatementRecord> = {},
): StatementRecord {
  return {
    id: statementId,
    ownerId: null,
    s3Key: `statements/${statementId}/source`,
    targetMonth: "2026-08-01",
    status: "UPLOADED",
    contentType: "image/jpeg",
    contentLength: 1024,
    processingStartedAt: null,
    processedAt: null,
    failureCode: null,
    failureMessage: null,
    createdAt: new Date("2026-09-05T00:00:00.000Z"),
    updatedAt: new Date("2026-09-05T00:00:00.000Z"),
    ...overrides,
  };
}

function createTestApp(options: {
  statement?: StatementRecord | null;
  findById?: (id: string) => Promise<StatementRecord | null>;
  markQueued?: (id: string) => Promise<StatementRecord | null>;
  resetQueuedToUploaded?: (
    id: string,
  ) => Promise<StatementRecord | null>;
  sendAnalyzeJob?: (statementId: string) => Promise<void>;
} = {}) {
  const statements: StatementStore = {
    create: async (input: CreateStatementInput) =>
      createStatementRecord({
        id: input.id ?? statementId,
        status: input.status ?? "UPLOAD_PENDING",
      }),
    findById:
      options.findById ??
      (async () =>
        options.statement === undefined
          ? createStatementRecord()
          : options.statement),
    markUploaded: async () => null,
    markQueued:
      options.markQueued ??
      (async () => createStatementRecord({ status: "QUEUED" })),
    resetQueuedToUploaded:
      options.resetQueuedToUploaded ??
      (async () => createStatementRecord({ status: "UPLOADED" })),
  };
  const jobQueue: AnalyzeJobQueue = {
    sendAnalyzeJob: options.sendAnalyzeJob ?? (async () => undefined),
    receiveOne: async () => null,
    deleteMessage: async () => undefined,
  };
  const objectStore: StatementObjectStore = {
    createPresignedPutUrl: async () => "https://s3.example.test/upload",
    headObject: async () => ({
      contentType: "image/jpeg",
      contentLength: 1024,
    }),
  };

  return createApp({
    database: { query: async () => ({ rows: [] }) },
    statements,
    objectStore,
    jobQueue,
  });
}

test("Analyze APIはUPLOADEDのstatementをQUEUEDにしてSQSへ送信する", async () => {
  const events: string[] = [];
  const app = createTestApp({
    markQueued: async () => {
      events.push("markQueued");
      return createStatementRecord({ status: "QUEUED" });
    },
    sendAnalyzeJob: async (id) => {
      events.push(`send:${id}`);
    },
  });

  const response = await app.request(`/statements/${statementId}/analyze`, {
    method: "POST",
  });

  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), {
    statementId,
    status: "QUEUED",
  });
  assert.deepEqual(events, ["markQueued", `send:${statementId}`]);
});

test("Analyze APIはUPLOAD_PENDINGのstatementを拒否する", async () => {
  let sent = false;
  const app = createTestApp({
    statement: createStatementRecord({ status: "UPLOAD_PENDING" }),
    sendAnalyzeJob: async () => {
      sent = true;
    },
  });

  const response = await app.request(`/statements/${statementId}/analyze`, {
    method: "POST",
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      code: "STATEMENT_NOT_READY",
      message: "画像のアップロードが完了していません。",
    },
  });
  assert.equal(sent, false);
});

test("Analyze APIはQUEUED以降の再要求でSQSへ再送しない", async () => {
  let sent = false;
  const app = createTestApp({
    statement: createStatementRecord({ status: "QUEUED" }),
    sendAnalyzeJob: async () => {
      sent = true;
    },
  });

  const response = await app.request(`/statements/${statementId}/analyze`, {
    method: "POST",
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    statementId,
    status: "QUEUED",
  });
  assert.equal(sent, false);
});

test("Analyze APIへ同時に要求してもSQSへは1回だけ送信する", async () => {
  let currentStatus: StatementRecord["status"] = "UPLOADED";
  let findCount = 0;
  let releaseFind: (() => void) | undefined;
  const findBarrier = new Promise<void>((resolve) => {
    releaseFind = resolve;
  });
  let sendCount = 0;
  const app = createTestApp({
    findById: async () => {
      findCount += 1;
      if (findCount === 2) {
        releaseFind?.();
      }
      await findBarrier;
      return createStatementRecord({ status: currentStatus });
    },
    markQueued: async () => {
      if (currentStatus !== "UPLOADED") {
        return null;
      }

      currentStatus = "QUEUED";
      return createStatementRecord({ status: currentStatus });
    },
    sendAnalyzeJob: async () => {
      sendCount += 1;
    },
  });

  const [firstResponse, secondResponse] = await Promise.all([
    app.request(`/statements/${statementId}/analyze`, { method: "POST" }),
    app.request(`/statements/${statementId}/analyze`, { method: "POST" }),
  ]);

  assert.deepEqual(
    new Set([firstResponse.status, secondResponse.status]),
    new Set([202, 200]),
  );
  assert.equal(sendCount, 1);
  assert.equal(currentStatus, "QUEUED");
});

test("Analyze APIはSQS送信失敗時にQUEUEDから戻して503を返す", async () => {
  let resetId: string | undefined;
  const app = createTestApp({
    sendAnalyzeJob: async () => {
      throw new Error("sqs-request=should-not-leak");
    },
    resetQueuedToUploaded: async (id) => {
      resetId = id;
      return createStatementRecord({ status: "UPLOADED" });
    },
  });

  const response = await app.request(`/statements/${statementId}/analyze`, {
    method: "POST",
  });
  const body = await response.text();

  assert.equal(response.status, 503);
  assert.equal(body.includes("should-not-leak"), false);
  assert.deepEqual(JSON.parse(body), {
    error: {
      code: "DEPENDENCY_UNAVAILABLE",
      message: "依存サービスを利用できません。",
    },
  });
  assert.equal(resetId, statementId);
});

test("Analyze APIは存在しないstatementに404を返す", async () => {
  const app = createTestApp({ statement: null });

  const response = await app.request(`/statements/${statementId}/analyze`, {
    method: "POST",
  });

  assert.equal(response.status, 404);
});

test("Analyze APIは不正なUUIDに400を返す", async () => {
  const app = createTestApp();

  const response = await app.request("/statements/not-a-uuid/analyze", {
    method: "POST",
  });

  assert.equal(response.status, 400);
});

test("Analyze APIはFAILEDのstatementを再解析対象にしない", async () => {
  const app = createTestApp({
    statement: createStatementRecord({ status: "FAILED" }),
  });

  const response = await app.request(`/statements/${statementId}/analyze`, {
    method: "POST",
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      code: "STATEMENT_NOT_ANALYZABLE",
      message: "この明細は解析対象にできません。",
    },
  });
});
