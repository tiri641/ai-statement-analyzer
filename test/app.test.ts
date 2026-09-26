import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, type HealthDatabase } from "../src/app.ts";
import {
  createStructuredLogger,
  type StructuredLogger,
} from "../src/observability/logger.ts";

function createTestDatabase(
  query: HealthDatabase["query"],
): HealthDatabase {
  return { query };
}

function createTestApp(
  database: HealthDatabase,
  logger?: StructuredLogger,
  frontendOrigin?: string,
) {
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
    analytics: {
      findMonthlyAnalytics: async () => ({
        current: {
          totalAmount: 0,
          transactionCount: 0,
          categories: [],
          merchants: [],
        },
        previous: {
          totalAmount: 0,
          transactionCount: 0,
          categories: [],
          merchants: [],
        },
      }),
    },
    objectStore: {
      createPresignedPutUrl: async () => "https://s3.example.test/upload",
      headObject: async () => ({
        contentType: "image/jpeg",
        contentLength: 1024,
      }),
      getObject: async () => ({
        bytes: new Uint8Array(1024),
        contentType: "image/jpeg",
        contentLength: 1024,
      }),
    },
    jobQueue: {
      sendAnalyzeJob: async () => undefined,
      receiveOne: async () => null,
      deleteMessage: async () => undefined,
    },
    ...(logger ? { logger } : {}),
    ...(frontendOrigin ? { frontendOrigin } : {}),
  });
}

test("APIはサーバー生成requestIdをHeaderと開始・完了ログへ記録する", async () => {
  const lines: string[] = [];
  const logger = createStructuredLogger({
    service: "api",
    now: () => new Date("2026-09-25T00:00:00.000Z"),
    writeInfo: (line) => lines.push(line),
    writeError: (line) => lines.push(line),
  });
  const app = createTestApp(
    createTestDatabase(async () => ({ rows: [] })),
    logger,
  );

  const response = await app.request("/health", {
    headers: { "X-Request-Id": "client-controlled-id" },
  });

  const requestId = response.headers.get("X-Request-Id");
  assert.match(requestId ?? "", /^[0-9a-f-]{36}$/);
  assert.notEqual(requestId, "client-controlled-id");

  const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const started = events.find((event) => event.event === "api_request_started");
  const completed = events.find(
    (event) => event.event === "api_request_completed",
  );
  assert.equal(started?.requestId, requestId);
  assert.equal(completed?.requestId, requestId);
  assert.equal(completed?.httpStatus, 200);
  assert.equal(typeof completed?.durationMs, "number");
});

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

test("APIは許可されたFrontend OriginへCORSヘッダーを返す", async () => {
  const app = createTestApp(
    createTestDatabase(async () => ({ rows: [] })),
    undefined,
    "http://localhost:5173",
  );

  const response = await app.request("/health", {
    headers: { Origin: "http://localhost:5173" },
  });

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "http://localhost:5173",
  );
  assert.equal(response.headers.get("Access-Control-Expose-Headers"), "X-Request-Id");
});

test("APIは許可OriginのPreflightへ応答する", async () => {
  const app = createTestApp(
    createTestDatabase(async () => ({ rows: [] })),
    undefined,
    "https://frontend.example.test",
  );

  const response = await app.request("/statements", {
    method: "OPTIONS",
    headers: {
      Origin: "https://frontend.example.test",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });

  assert.equal(response.status, 204);
  assert.equal(
    response.headers.get("Access-Control-Allow-Origin"),
    "https://frontend.example.test",
  );
  assert.match(response.headers.get("Access-Control-Allow-Methods") ?? "", /POST/);
  assert.match(
    response.headers.get("Access-Control-Allow-Headers") ?? "",
    /content-type/i,
  );
});

test("APIは許可していないOriginへCORS許可を返さない", async () => {
  const app = createTestApp(
    createTestDatabase(async () => ({ rows: [] })),
    undefined,
    "https://frontend.example.test",
  );

  const response = await app.request("/health", {
    headers: { Origin: "https://attacker.example.test" },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
});
