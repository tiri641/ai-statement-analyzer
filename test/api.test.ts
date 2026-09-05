import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, type StatementStore } from "../src/app.ts";
import { UniqueConstraintError } from "../src/database/errors.ts";
import type {
  CreateStatementInput,
  StatementRecord,
} from "../src/database/statement-repository.ts";
import type { StatementObjectStore } from "../src/storage/object-store.ts";

const statementId = "019abc00-0000-7000-8000-000000000001";

function createStatementRecord(
  overrides: Partial<StatementRecord> = {},
): StatementRecord {
  return {
    id: statementId,
    ownerId: null,
    s3Key: `statements/${statementId}/source`,
    targetMonth: "2026-08-01",
    status: "UPLOAD_PENDING" as const,
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
  create?: (input: CreateStatementInput) => Promise<StatementRecord>;
  findById?: (id: string) => Promise<StatementRecord | null>;
  markUploaded?: (id: string) => Promise<StatementRecord | null>;
  objectStore?: Partial<StatementObjectStore>;
} = {}) {
  const objectStore: StatementObjectStore = {
    createPresignedPutUrl: async () => "https://s3.example.test/upload",
    headObject: async () => ({
      contentType: "image/jpeg",
      contentLength: 5242880,
    }),
    ...options.objectStore,
  };
  const statements: StatementStore = {
    create: options.create ?? (async () => createStatementRecord()),
    findById: options.findById ?? (async () => createStatementRecord()),
    markUploaded:
      options.markUploaded ??
      (async () => createStatementRecord({ status: "UPLOADED" })),
    markQueued: async () => createStatementRecord({ status: "QUEUED" }),
    resetQueuedToUploaded: async () =>
      createStatementRecord({ status: "UPLOADED" }),
  };

  return createApp({
    database: {
      query: async () => ({ rows: [] }),
    },
    statements,
    objectStore,
    jobQueue: {
      sendAnalyzeJob: async () => undefined,
      receiveOne: async () => null,
      deleteMessage: async () => undefined,
    },
  });
}

test("POST /statementsは入力を検証してstatementを作成する", async () => {
  let receivedInput: CreateStatementInput | undefined;
  let presignedInput:
    | {
        key: string;
        contentType: "image/jpeg" | "image/png";
        expiresInSeconds: number;
      }
    | undefined;
  const app = createTestApp({
    create: async (input) => {
      receivedInput = input;
      assert.ok(input.id);
      return createStatementRecord({
        id: input.id,
        s3Key: input.s3Key,
      });
    },
    objectStore: {
      createPresignedPutUrl: async (input) => {
        presignedInput = input;
        return "https://s3.example.test/upload";
      },
    },
  });

  const response = await app.request("/statements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetMonth: "2026-08",
      fileName: "statement.jpg",
      contentType: "image/jpeg",
      contentLength: 5242880,
    }),
  });

  assert.equal(response.status, 201);
  const responseBody = await response.json();

  assert.ok(receivedInput);
  assert.match(receivedInput.id ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(responseBody.statementId, receivedInput.id);
  assert.deepEqual(responseBody, {
    statementId: receivedInput.id,
    status: "UPLOAD_PENDING",
    upload: {
      method: "PUT",
      url: "https://s3.example.test/upload",
      headers: { "Content-Type": "image/jpeg" },
      expiresInSeconds: 300,
    },
  });
  assert.equal(receivedInput.ownerId, null);
  assert.equal(receivedInput.s3Key, `statements/${receivedInput.id}/source`);
  assert.equal(receivedInput.targetMonth, "2026-08");
  assert.equal(receivedInput.contentType, "image/jpeg");
  assert.equal(receivedInput.contentLength, 5242880);
  assert.equal(receivedInput.status, "UPLOAD_PENDING");
  assert.deepEqual(presignedInput, {
    key: receivedInput.s3Key,
    contentType: "image/jpeg",
    expiresInSeconds: 300,
  });
});

test("POST /statementsはfilenameをS3 keyに使用しない", async () => {
  let receivedInput: CreateStatementInput | undefined;
  const app = createTestApp({
    create: async (input) => {
      receivedInput = input;
      return createStatementRecord();
    },
  });

  await app.request("/statements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetMonth: "2026-08",
      fileName: "../../card-number-1234.jpg",
      contentType: "image/jpeg",
      contentLength: 1024,
    }),
  });

  assert.ok(receivedInput?.s3Key);
  assert.equal(receivedInput.s3Key.includes("card-number"), false);
  assert.match(receivedInput.s3Key, /^statements\/[0-9a-f-]+\/source$/);
});

test("POST /statementsは不正な入力に400を返す", async () => {
  const app = createTestApp();

  const response = await app.request("/statements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetMonth: "2026-13",
      fileName: "statement.jpg",
      contentType: "image/gif",
      contentLength: 0,
      unexpected: true,
    }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: {
      code: "INVALID_REQUEST",
      message: "入力内容が不正です。",
    },
  });
});

test("POST /statementsは10MiBを超える画像に413を返す", async () => {
  const app = createTestApp();

  const response = await app.request("/statements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetMonth: "2026-08",
      fileName: "statement.jpg",
      contentType: "image/jpeg",
      contentLength: 10 * 1024 * 1024 + 1,
    }),
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: {
      code: "FILE_TOO_LARGE",
      message: "ファイルサイズが上限を超えています。",
    },
  });
});

test("POST /statementsは不正なJSONに400を返す", async () => {
  const app = createTestApp();

  const response = await app.request("/statements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{invalid-json",
  });

  assert.equal(response.status, 400);
});

test("POST /statementsはJSON以外のContent-Typeに400を返す", async () => {
  const app = createTestApp();

  const response = await app.request("/statements", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: JSON.stringify({
      targetMonth: "2026-08",
      fileName: "statement.jpg",
      contentType: "image/jpeg",
      contentLength: 1024,
    }),
  });

  assert.equal(response.status, 400);
});

test("POST /statementsは大きすぎるJSON bodyに413を返す", async () => {
  const app = createTestApp();

  const response = await app.request("/statements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetMonth: "2026-08",
      fileName: "statement.jpg",
      contentType: "image/jpeg",
      contentLength: 1024,
      unexpected: "x".repeat(64 * 1024),
    }),
  });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), {
    error: {
      code: "REQUEST_TOO_LARGE",
      message: "リクエストが大きすぎます。",
    },
  });
});

test("GET /statements/{id}は公開用DTOを返す", async () => {
  const app = createTestApp({
    findById: async () => createStatementRecord(),
  });

  const response = await app.request(`/statements/${statementId}`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    statementId,
    targetMonth: "2026-08",
    status: "UPLOAD_PENDING",
    processedAt: null,
    failure: null,
  });
});

test("GET /statements/{id}は存在しないstatementに404を返す", async () => {
  const app = createTestApp({
    findById: async () => null,
  });

  const response = await app.request(`/statements/${statementId}`);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: {
      code: "STATEMENT_NOT_FOUND",
      message: "明細が見つかりません。",
    },
  });
});

test("GET /statements/{id}は不正なUUIDに400を返す", async () => {
  const app = createTestApp();

  const response = await app.request("/statements/not-a-uuid");

  assert.equal(response.status, 400);
});

test("statement作成の競合に409を返す", async () => {
  const app = createTestApp({
    create: async () => {
      throw new UniqueConstraintError();
    },
  });

  const response = await app.request("/statements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetMonth: "2026-08",
      fileName: "statement.jpg",
      contentType: "image/jpeg",
      contentLength: 1024,
    }),
  });

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      code: "STATEMENT_CONFLICT",
      message: "明細の作成が競合しました。",
    },
  });
});

test("DB障害の詳細を返さず503にする", async () => {
  const app = createTestApp({
    create: async () => {
      throw new Error("password=should-not-leak");
    },
  });

  const response = await app.request("/statements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetMonth: "2026-08",
      fileName: "statement.jpg",
      contentType: "image/jpeg",
      contentLength: 1024,
    }),
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
});

test("Presigned URL発行の障害を503にして詳細を返さない", async () => {
  const app = createTestApp({
    objectStore: {
      createPresignedPutUrl: async () => {
        throw new Error("secret=should-not-leak");
      },
    },
  });

  const response = await app.request("/statements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      targetMonth: "2026-08",
      fileName: "statement.jpg",
      contentType: "image/jpeg",
      contentLength: 1024,
    }),
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
});

test("POST /statements/{id}/upload/completeはS3のMetadata一致時にUPLOADEDへ更新する", async () => {
  let headObjectKey: string | undefined;
  let markedUploadedId: string | undefined;
  const app = createTestApp({
    findById: async () => createStatementRecord(),
    objectStore: {
      headObject: async (key) => {
        headObjectKey = key;
        return { contentType: "image/jpeg", contentLength: 1024 };
      },
    },
    markUploaded: async (id) => {
      markedUploadedId = id;
      return createStatementRecord({ status: "UPLOADED" });
    },
  });

  const response = await app.request(
    `/statements/${statementId}/upload/complete`,
    { method: "POST" },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    statementId,
    status: "UPLOADED",
  });
  assert.equal(headObjectKey, `statements/${statementId}/source`);
  assert.equal(markedUploadedId, statementId);
});

test("upload/completeはS3オブジェクトがない場合に404を返す", async () => {
  const app = createTestApp({
    objectStore: {
      headObject: async () => {
        const error = new Error("not found");
        error.name = "ObjectNotFoundError";
        throw error;
      },
    },
  });

  const response = await app.request(
    `/statements/${statementId}/upload/complete`,
    { method: "POST" },
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_NOT_FOUND",
      message: "アップロードされた画像が見つかりません。",
    },
  });
});

test("upload/completeはContent-Type不一致を409で拒否する", async () => {
  const app = createTestApp({
    objectStore: {
      headObject: async () => ({
        contentType: "image/png",
        contentLength: 1024,
      }),
    },
  });

  const response = await app.request(
    `/statements/${statementId}/upload/complete`,
    { method: "POST" },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_METADATA_MISMATCH",
      message: "アップロードされた画像の情報が登録内容と一致しません。",
    },
  });
});

test("upload/completeはContent-Length不一致を409で拒否する", async () => {
  const app = createTestApp({
    objectStore: {
      headObject: async () => ({
        contentType: "image/jpeg",
        contentLength: 2048,
      }),
    },
  });

  const response = await app.request(
    `/statements/${statementId}/upload/complete`,
    { method: "POST" },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      code: "UPLOAD_METADATA_MISMATCH",
      message: "アップロードされた画像の情報が登録内容と一致しません。",
    },
  });
});

test("upload/completeはS3の一時障害を503にして詳細を返さない", async () => {
  const app = createTestApp({
    objectStore: {
      headObject: async () => {
        throw new Error("aws-request-id=should-not-leak");
      },
    },
  });

  const response = await app.request(
    `/statements/${statementId}/upload/complete`,
    { method: "POST" },
  );
  const body = await response.text();

  assert.equal(response.status, 503);
  assert.equal(body.includes("should-not-leak"), false);
  assert.deepEqual(JSON.parse(body), {
    error: {
      code: "DEPENDENCY_UNAVAILABLE",
      message: "依存サービスを利用できません。",
    },
  });
});

test("upload/completeは既にUPLOADEDならS3を再確認せず同じ結果を返す", async () => {
  let headCalled = false;
  const app = createTestApp({
    findById: async () => createStatementRecord({ status: "UPLOADED" }),
    objectStore: {
      headObject: async () => {
        headCalled = true;
        throw new Error("should not call S3");
      },
    },
  });

  const response = await app.request(
    `/statements/${statementId}/upload/complete`,
    { method: "POST" },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { statementId, status: "UPLOADED" });
  assert.equal(headCalled, false);
});

test("upload/completeはFAILEDのstatementを409で拒否する", async () => {
  const app = createTestApp({
    findById: async () => createStatementRecord({ status: "FAILED" }),
  });

  const response = await app.request(
    `/statements/${statementId}/upload/complete`,
    { method: "POST" },
  );

  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: {
      code: "STATEMENT_NOT_UPLOADABLE",
      message: "この明細はアップロード完了にできません。",
    },
  });
});

test("upload/completeは存在しないstatementに404を返す", async () => {
  const app = createTestApp({ findById: async () => null });

  const response = await app.request(
    `/statements/${statementId}/upload/complete`,
    { method: "POST" },
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: {
      code: "STATEMENT_NOT_FOUND",
      message: "明細が見つかりません。",
    },
  });
});

test("FAILEDのstatementは安全なfailure情報だけを返す", async () => {
  const app = createTestApp({
    findById: async () =>
      createStatementRecord({
        status: "FAILED",
        failureCode: "UNSUPPORTED_IMAGE",
        failureMessage: "password=should-not-leak",
      }),
  });

  const response = await app.request(`/statements/${statementId}`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    statementId,
    targetMonth: "2026-08",
    status: "FAILED",
    processedAt: null,
    failure: {
      code: "UNSUPPORTED_IMAGE",
      message: "対応していない画像形式です。",
    },
  });
});

test("未知のfailure codeと内部failure messageを公開しない", async () => {
  const app = createTestApp({
    findById: async () =>
      createStatementRecord({
        failureCode: "password=should-not-leak",
        failureMessage: "Presigned URL should-not-leak",
      }),
  });

  const response = await app.request(`/statements/${statementId}`);
  const body = await response.text();

  assert.equal(response.status, 200);
  assert.equal(body.includes("should-not-leak"), false);
  assert.deepEqual(JSON.parse(body).failure, {
    code: "PROCESSING_FAILED",
    message: "明細を処理できませんでした。",
  });
});
