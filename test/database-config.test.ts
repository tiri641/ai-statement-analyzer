import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DatabaseConfigurationError,
  getDatabasePoolConfig,
} from "../src/config/database.ts";

test("DATABASE_URLを指定した場合は従来の接続方式を維持する", () => {
  const config = getDatabasePoolConfig({
    DATABASE_URL: "postgres://app:password@127.0.0.1:5432/statement_analyzer",
  });

  assert.deepEqual(config, {
    connectionString:
      "postgres://app:password@127.0.0.1:5432/statement_analyzer",
  });
});

test("ECS用の個別DB設定からPool設定を構築する", () => {
  const config = getDatabasePoolConfig({
    DB_HOST: "database.internal",
    DB_PORT: "5433",
    DB_NAME: "statement_analyzer",
    DB_USER: "app",
    DB_PASSWORD: "secret-password",
  });

  assert.deepEqual(config, {
    host: "database.internal",
    port: 5433,
    database: "statement_analyzer",
    user: "app",
    password: "secret-password",
  });
});

test("ECS用DB設定のPort未指定時は5432を使う", () => {
  const config = getDatabasePoolConfig({
    DB_HOST: "database.internal",
    DB_NAME: "statement_analyzer",
    DB_USER: "app",
    DB_PASSWORD: "secret-password",
  });

  assert.equal(config.port, 5432);
});

test("DB設定が不足している場合は秘密値を含まないエラーにする", () => {
  assert.throws(
    () =>
      getDatabasePoolConfig({
        DB_HOST: "database.internal",
        DB_PASSWORD: "do-not-leak",
      }),
    (error: unknown) => {
      assert.equal(error instanceof DatabaseConfigurationError, true);
      assert.equal(String(error).includes("do-not-leak"), false);
      return true;
    },
  );
});

test("DB Portが不正な場合は接続設定を拒否する", () => {
  assert.throws(
    () =>
      getDatabasePoolConfig({
        DB_HOST: "database.internal",
        DB_PORT: "not-a-port",
        DB_NAME: "statement_analyzer",
        DB_USER: "app",
        DB_PASSWORD: "secret-password",
      }),
    DatabaseConfigurationError,
  );
});
