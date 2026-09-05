import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../src/app.ts";
import { StatementConflictError } from "../src/api/errors.ts";
import type {
  CreateStatementInput,
  StatementRecord,
} from "../src/database/statement-repository.ts";

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
} = {}) {
  return createApp({
    database: {
      query: async () => ({ rows: [] }),
    },
    statements: {
      create: options.create ?? (async () => createStatementRecord()),
      findById: options.findById ?? (async () => createStatementRecord()),
    },
  });
}

test("POST /statementsは入力を検証してstatementを作成する", async () => {
  let receivedInput: CreateStatementInput | undefined;
  const app = createTestApp({
    create: async (input) => {
      receivedInput = input;
      assert.ok(input.id);
      return createStatementRecord({
        id: input.id,
        s3Key: input.s3Key,
      });
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
    upload: null,
  });
  assert.equal(receivedInput.ownerId, null);
  assert.equal(receivedInput.s3Key, `statements/${receivedInput.id}/source`);
  assert.equal(receivedInput.targetMonth, "2026-08");
  assert.equal(receivedInput.contentType, "image/jpeg");
  assert.equal(receivedInput.contentLength, 5242880);
  assert.equal(receivedInput.status, "UPLOAD_PENDING");
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
      throw new StatementConflictError();
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

test("FAILEDのstatementは安全なfailure情報だけを返す", async () => {
  const app = createTestApp({
    findById: async () =>
      createStatementRecord({
        status: "FAILED",
        failureCode: "UNSUPPORTED_IMAGE",
        failureMessage: "画像を解析できませんでした。",
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
      message: "画像を解析できませんでした。",
    },
  });
});
