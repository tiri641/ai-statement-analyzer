import assert from "node:assert/strict";
import { test } from "node:test";
import { createStructuredLogger } from "../src/observability/logger.ts";

test("Structured Loggerは安全なJSONイベントを出力する", () => {
  const lines: string[] = [];
  const logger = createStructuredLogger({
    service: "test-service",
    now: () => new Date("2026-09-25T00:00:00.000Z"),
    writeInfo: (line) => lines.push(line),
    writeError: (line) => lines.push(line),
  });

  logger.info({
    event: "test_completed",
    requestId: "request-1",
    statementId: "statement-1",
    status: "ok",
    durationMs: 12,
  });

  assert.deepEqual(JSON.parse(lines[0] ?? ""), {
    event: "test_completed",
    timestamp: "2026-09-25T00:00:00.000Z",
    service: "test-service",
    requestId: "request-1",
    statementId: "statement-1",
    status: "ok",
    durationMs: 12,
  });
});

test("Structured Loggerは許可されていない機密情報とraw errorを出力しない", () => {
  const lines: string[] = [];
  const logger = createStructuredLogger({
    service: "test-service",
    writeError: (line) => lines.push(line),
  });

  logger.error({
    event: "dependency_failed",
    errorCode: "DEPENDENCY_UNAVAILABLE",
    error: new Error("DATABASE_URL=postgres://user:password@example.test/db"),
    presignedUrl: "https://s3.example.test/signed-secret",
    s3Key: "statements/private/source",
    cardNumber: "4111111111111111",
  });

  const parsed = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
  assert.equal(parsed.event, "dependency_failed");
  assert.equal(parsed.errorCode, "DEPENDENCY_UNAVAILABLE");
  assert.equal("error" in parsed, false);
  assert.equal("presignedUrl" in parsed, false);
  assert.equal("s3Key" in parsed, false);
  assert.equal("cardNumber" in parsed, false);
  assert.equal(JSON.stringify(parsed).includes("password"), false);
});
