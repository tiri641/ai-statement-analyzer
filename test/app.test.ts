import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, type HealthDatabase } from "../src/app.ts";

function createTestDatabase(
  query: HealthDatabase["query"],
): HealthDatabase {
  return { query };
}

function createTestApp(database: HealthDatabase) {
  return createApp({
    database,
    statements: {
      create: async () => {
        throw new Error("test-only repository");
      },
      findById: async () => null,
      markUploaded: async () => null,
      markQueued: async () => null,
      resetQueuedToUploaded: async () => null,
    },
    objectStore: {
      createPresignedPutUrl: async () => "https://s3.example.test/upload",
      headObject: async () => ({
        contentType: "image/jpeg",
        contentLength: 1024,
      }),
    },
    jobQueue: {
      sendAnalyzeJob: async () => undefined,
      receiveOne: async () => null,
      deleteMessage: async () => undefined,
    },
  });
}

test("GET /healthはデータベースへ接続せずAPIの生存状態を返す", async () => {
  let queryCalled = false;
  const db = createTestDatabase(async () => {
    queryCalled = true;
    return { rows: [] };
  });
  const app = createTestApp(db);

  const response = await app.request("/health");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "api",
  });
  assert.equal(queryCalled, false);
});

test("GET /health/dbはデータベースへの問い合わせ成功時に200を返す", async () => {
  let queryText: string | undefined;
  const db = createTestDatabase(async (text) => {
    queryText = text;
    return { rows: [{ result: 1 }] };
  });
  const app = createTestApp(db);

  const response = await app.request("/health/db");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    database: "ok",
  });
  assert.equal(queryText, "SELECT 1");
});

test("GET /health/dbはデータベースへの問い合わせ失敗時に503を返す", async () => {
  const dbError = new Error("password=should-not-leak");
  const db = createTestDatabase(async () => {
    throw dbError;
  });
  const app = createTestApp(db);

  const response = await app.request("/health/db");
  const body = await response.text();

  assert.equal(response.status, 503);
  assert.deepEqual(JSON.parse(body), {
    status: "error",
    database: "unavailable",
  });
  assert.equal(body.includes("should-not-leak"), false);
});

test("未定義のパスは404を返す", async () => {
  const db = createTestDatabase(async () => ({ rows: [] }));
  const app = createTestApp(db);

  const response = await app.request("/unknown");

  assert.equal(response.status, 404);
});
