import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";
import os from "node:os";
import path from "node:path";
import "dotenv/config";
import { Pool } from "pg";
import { runMigrations } from "../src/database/migrate.ts";
import {
  StatementRepository,
  normalizeTargetMonth,
  type StatementStatus,
} from "../src/database/statement-repository.ts";

test("targetMonthを月初の日付へ正規化する", () => {
  assert.equal(normalizeTargetMonth("2026-08"), "2026-08-01");
});

test("不正なtargetMonthを拒否する", () => {
  assert.throws(
    () => normalizeTargetMonth("2026-13"),
    /targetMonth must be in YYYY-MM format/,
  );
});

const databaseUrl = process.env.DATABASE_URL;
const databaseTest = databaseUrl ? test : test.skip;
const migrationDirectory = path.resolve(process.cwd(), "migrations");
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : null;
const repository = pool ? new StatementRepository(pool) : null;

const statementId = "00000000-0000-4000-8000-000000000001";
const secondStatementId = "00000000-0000-4000-8000-000000000002";

before(async () => {
  if (!pool) {
    return;
  }

  await runMigrations(pool, migrationDirectory);
});

beforeEach(async () => {
  if (!pool) {
    return;
  }

  await pool.query("TRUNCATE transactions, statements CASCADE");
});

after(async () => {
  await pool?.end();
});

databaseTest("Migrationを再実行してもエラーにならない", async () => {
  assert.ok(pool);

  await runMigrations(pool, migrationDirectory);

  const result = await pool.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM schema_migrations
    `,
  );

  assert.equal(result.rows[0]?.count, "3");
});

databaseTest("月別・日付・merchant・category用のIndexが作成される", async () => {
  assert.ok(pool);

  const result = await pool.query<{ indexname: string }>(
    `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ANY($1::text[])
      ORDER BY indexname
    `,
    [
      [
        "statements_target_month_status_idx",
        "transactions_date_idx",
        "transactions_merchant_name_idx",
        "transactions_category_idx",
      ],
    ],
  );

  assert.deepEqual(
    result.rows.map((row) => row.indexname),
    [
      "statements_target_month_status_idx",
      "transactions_category_idx",
      "transactions_date_idx",
      "transactions_merchant_name_idx",
    ],
  );
});

databaseTest("Migration失敗時はMigration記録とDDLをRollbackする", async () => {
  assert.ok(pool);

  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "statement-analyzer-migrations-"),
  );

  try {
    await writeFile(
      path.join(temporaryDirectory, "999_create_rollback_target.sql"),
      "CREATE TABLE migration_rollback_target (id integer NOT NULL);",
    );
    await writeFile(
      path.join(temporaryDirectory, "1000_invalid_sql.sql"),
      "THIS IS NOT VALID SQL;",
    );

    await assert.rejects(runMigrations(pool, temporaryDirectory));

    const migration = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE version = $1",
      ["999_create_rollback_target"],
    );
    const table = await pool.query(
      `
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = 'migration_rollback_target'
      `,
    );

    assert.equal(migration.rowCount, 0);
    assert.equal(table.rowCount, 0);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

databaseTest("Migration 003は既存statementへ仮のMetadataを入れずに失敗する", async () => {
  assert.ok(pool);

  const schemaName = `phase3_migration_${process.pid}_${Date.now()}`;
  const temporaryDirectory = await mkdtemp(
    path.join(os.tmpdir(), "statement-analyzer-migration-"),
  );
  const client = await pool.connect();

  try {
    await client.query(`CREATE SCHEMA "${schemaName}"`);
    await client.query(`SET search_path TO "${schemaName}"`);
    const migrationClient = {
      query: client.query.bind(client),
      release: () => undefined,
    } as unknown as import("pg").PoolClient;

    await writeFile(
      path.join(temporaryDirectory, "001_create_statements.sql"),
      "CREATE TABLE statements (id integer PRIMARY KEY);",
    );
    await writeFile(
      path.join(temporaryDirectory, "002_insert_existing_statement.sql"),
      "INSERT INTO statements (id) VALUES (1);",
    );
    await writeFile(
      path.join(temporaryDirectory, "003_add_upload_metadata.sql"),
      await readFile(
        path.join(migrationDirectory, "003_add_upload_metadata.sql"),
        "utf8",
      ),
    );

    await assert.rejects(
      runMigrations(
        { connect: async () => migrationClient },
        temporaryDirectory,
      ),
    );

    const result = await pool.query(
      `
        SELECT COUNT(*)::text AS count
        FROM information_schema.tables
        WHERE table_schema = $1
      `,
      [schemaName],
    );
    assert.equal(result.rows[0]?.count, "0");
  } finally {
    await client.query("SET search_path TO public");
    client.release();
    await pool.query(`DROP SCHEMA "${schemaName}" CASCADE`);
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

databaseTest("statementsへ有効な状態の明細を登録して取得できる", async () => {
  assert.ok(repository);

  const created = await repository.create({
    id: statementId,
    s3Key: "statements/statement-1.jpg",
    targetMonth: "2026-08",
    contentType: "image/jpeg",
    contentLength: 1024,
    status: "UPLOAD_PENDING",
  });

  assert.equal(created.id, statementId);
  assert.equal(created.targetMonth, "2026-08-01");
  assert.equal(created.status, "UPLOAD_PENDING");
  assert.equal(created.contentType, "image/jpeg");
  assert.equal(created.contentLength, 1024);

  const found = await repository.findById(statementId);

  assert.equal(found?.s3Key, "statements/statement-1.jpg");
  assert.equal(found?.contentType, "image/jpeg");
  assert.equal(found?.contentLength, 1024);
});

databaseTest("statementsの状態を更新できる", async () => {
  assert.ok(repository);

  await repository.create({
    id: statementId,
    s3Key: "statements/statement-1.jpg",
    targetMonth: "2026-08",
    contentType: "image/jpeg",
    contentLength: 1024,
    status: "UPLOAD_PENDING",
  });

  const status: StatementStatus = "QUEUED";
  const updated = await repository.updateStatus(statementId, status);

  assert.equal(updated?.status, "QUEUED");
});

databaseTest("UPLOAD_PENDINGのstatementだけをUPLOAD済みに更新できる", async () => {
  assert.ok(repository);

  await repository.create({
    id: statementId,
    s3Key: "statements/statement-1.jpg",
    targetMonth: "2026-08",
    contentType: "image/jpeg",
    contentLength: 1024,
    status: "UPLOAD_PENDING",
  });

  const updated = await repository.markUploaded(statementId);
  assert.equal(updated?.status, "UPLOADED");

  const secondUpdate = await repository.markUploaded(statementId);
  assert.equal(secondUpdate, null);
});

databaseTest("同じs3_keyは重複登録できない", async () => {
  assert.ok(repository);

  await repository.create({
    id: statementId,
    s3Key: "statements/duplicate.jpg",
    targetMonth: "2026-08",
    contentType: "image/jpeg",
    contentLength: 1024,
    status: "UPLOAD_PENDING",
  });

  await assert.rejects(
    repository.create({
      id: secondStatementId,
      s3Key: "statements/duplicate.jpg",
      targetMonth: "2026-08",
      contentType: "image/jpeg",
      contentLength: 1024,
      status: "UPLOAD_PENDING",
    }),
  );
});

databaseTest("statementsは許可されていないstatusを拒否する", async () => {
  assert.ok(pool);

  await assert.rejects(
    pool.query(
      `
        INSERT INTO statements (
          id,
          s3_key,
          target_month,
          status,
          content_type,
          content_length
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        statementId,
        "statements/invalid-status.jpg",
        "2026-08-01",
        "INVALID",
        "image/jpeg",
        1024,
      ],
    ),
  );
});

databaseTest("statementsは許可されていないContent-Typeを拒否する", async () => {
  assert.ok(pool);

  await assert.rejects(
    pool.query(
      `
        INSERT INTO statements (
          id,
          s3_key,
          target_month,
          status,
          content_type,
          content_length
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        statementId,
        "statements/invalid-content-type.jpg",
        "2026-08-01",
        "UPLOAD_PENDING",
        "image/gif",
        1024,
      ],
    ),
  );
});

databaseTest("statementsは上限を超えるContent-Lengthを拒否する", async () => {
  assert.ok(pool);

  await assert.rejects(
    pool.query(
      `
        INSERT INTO statements (
          id,
          s3_key,
          target_month,
          status,
          content_type,
          content_length
        ) VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [
        statementId,
        "statements/too-large.jpg",
        "2026-08-01",
        "UPLOAD_PENDING",
        "image/jpeg",
        10 * 1024 * 1024 + 1,
      ],
    ),
  );
});

databaseTest("存在しないstatement_idの取引登録を拒否する", async () => {
  assert.ok(pool);

  await assert.rejects(
    pool.query(
      `
        INSERT INTO transactions (
          statement_id,
          line_number,
          transaction_date,
          merchant_raw,
          merchant_name,
          amount,
          category,
          subcategory
        ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7)
      `,
      [
        statementId,
        "2026-08-20",
        "AMAZON.CO.JP",
        "Amazon",
        3980,
        "買い物",
        "EC",
      ],
    ),
  );
});

databaseTest("同じstatement_idとline_numberの取引を重複登録できない", async () => {
  assert.ok(pool);
  assert.ok(repository);

  await repository.create({
    id: statementId,
    s3Key: "statements/statement-1.jpg",
    targetMonth: "2026-08",
    contentType: "image/jpeg",
    contentLength: 1024,
    status: "UPLOAD_PENDING",
  });

  const values = [
    statementId,
    1,
    "2026-08-20",
    "AMAZON.CO.JP",
    "Amazon",
    3980,
    "買い物",
    "EC",
  ];

  await pool.query(
    `
      INSERT INTO transactions (
        statement_id,
        line_number,
        transaction_date,
        merchant_raw,
        merchant_name,
        amount,
        category,
        subcategory
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    values,
  );

  await assert.rejects(
    pool.query(
      `
        INSERT INTO transactions (
          statement_id,
          line_number,
          transaction_date,
          merchant_raw,
          merchant_name,
          amount,
          category,
          subcategory
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `,
      values,
    ),
  );
});

databaseTest("transactionsはline_numberが0以下の場合に拒否する", async () => {
  assert.ok(pool);
  assert.ok(repository);

  await repository.create({
    id: statementId,
    s3Key: "statements/statement-1.jpg",
    targetMonth: "2026-08",
    contentType: "image/jpeg",
    contentLength: 1024,
    status: "COMPLETED",
  });

  await assert.rejects(
    pool.query(
      `
        INSERT INTO transactions (
          statement_id,
          line_number,
          transaction_date,
          merchant_raw,
          merchant_name,
          amount,
          category
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [statementId, 0, "2026-08-20", "raw", "merchant", 100, "その他"],
    ),
  );
});

databaseTest("transactionsはamountが0の場合に拒否する", async () => {
  assert.ok(pool);
  assert.ok(repository);

  await repository.create({
    id: statementId,
    s3Key: "statements/statement-1.jpg",
    targetMonth: "2026-08",
    contentType: "image/jpeg",
    contentLength: 1024,
    status: "COMPLETED",
  });

  await assert.rejects(
    pool.query(
      `
        INSERT INTO transactions (
          statement_id,
          line_number,
          transaction_date,
          merchant_raw,
          merchant_name,
          amount,
          category
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [statementId, 1, "2026-08-20", "raw", "merchant", 0, "その他"],
    ),
  );
});

databaseTest("取引保存と明細の完了更新を同じTransactionで確定できる", async () => {
  assert.ok(repository);

  await repository.create({
    id: statementId,
    s3Key: "statements/statement-1.jpg",
    targetMonth: "2026-08",
    contentType: "image/jpeg",
    contentLength: 1024,
    status: "PROCESSING",
  });

  await repository.saveTransactionsAndComplete(statementId, [
    {
      lineNumber: 1,
      transactionDate: "2026-08-20",
      merchantRaw: "AMAZON.CO.JP",
      merchantName: "Amazon",
      amount: 3980,
      category: "買い物",
      subcategory: "EC",
    },
  ]);

  const statement = await repository.findById(statementId);
  const transactions = await repository.findTransactions(statementId);

  assert.equal(statement?.status, "COMPLETED");
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0]?.amount, 3980);
});

databaseTest("取引保存に失敗した場合は取引と完了更新をRollbackする", async () => {
  assert.ok(pool);
  assert.ok(repository);

  await repository.create({
    id: statementId,
    s3Key: "statements/statement-1.jpg",
    targetMonth: "2026-08",
    contentType: "image/jpeg",
    contentLength: 1024,
    status: "PROCESSING",
  });

  await assert.rejects(
    repository.saveTransactionsAndComplete(statementId, [
      {
        lineNumber: 1,
        transactionDate: "2026-08-20",
        merchantRaw: "AMAZON.CO.JP",
        merchantName: "Amazon",
        amount: 3980,
        category: "買い物",
        subcategory: "EC",
      },
      {
        lineNumber: 1,
        transactionDate: "2026-08-21",
        merchantRaw: "duplicate",
        merchantName: "duplicate",
        amount: 100,
        category: "その他",
        subcategory: null,
      },
    ]),
  );

  const statement = await repository.findById(statementId);
  const transactionCount = await pool.query<{ count: string }>(
    "SELECT COUNT(*)::text AS count FROM transactions WHERE statement_id = $1",
    [statementId],
  );

  assert.equal(statement?.status, "PROCESSING");
  assert.equal(transactionCount.rows[0]?.count, "0");
});

databaseTest("明細を削除すると関連する取引も削除される", async () => {
  assert.ok(pool);
  assert.ok(repository);

  await repository.create({
    id: statementId,
    s3Key: "statements/statement-1.jpg",
    targetMonth: "2026-08",
    contentType: "image/jpeg",
    contentLength: 1024,
    status: "COMPLETED",
  });
  await pool.query(
    `
      INSERT INTO transactions (
        statement_id,
        line_number,
        transaction_date,
        merchant_raw,
        merchant_name,
        amount,
        category,
        subcategory
      ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7)
    `,
    [
      statementId,
      "2026-08-20",
      "AMAZON.CO.JP",
      "Amazon",
      3980,
      "買い物",
      "EC",
    ],
  );

  await pool.query("DELETE FROM statements WHERE id = $1", [statementId]);

  const result = await pool.query(
    "SELECT 1 FROM transactions WHERE statement_id = $1",
    [statementId],
  );

  assert.equal(result.rowCount, 0);
});
