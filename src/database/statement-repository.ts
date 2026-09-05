import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { UniqueConstraintError } from "./errors.js";

export const STATEMENT_STATUSES = [
  "UPLOAD_PENDING",
  "UPLOADED",
  "QUEUED",
  "PROCESSING",
  "COMPLETED",
  "FAILED",
] as const;

export type StatementStatus = (typeof STATEMENT_STATUSES)[number];

export interface CreateStatementInput {
  id?: string;
  ownerId?: string | null;
  s3Key: string;
  targetMonth: string;
  contentType: "image/jpeg" | "image/png";
  contentLength: number;
  status?: StatementStatus;
}

export interface StatementRecord {
  id: string;
  ownerId: string | null;
  s3Key: string;
  targetMonth: string;
  status: StatementStatus;
  contentType: "image/jpeg" | "image/png";
  contentLength: number;
  processingStartedAt: Date | null;
  processedAt: Date | null;
  failureCode: string | null;
  failureMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTransactionInput {
  lineNumber: number;
  transactionDate: string;
  merchantRaw: string;
  merchantName: string;
  amount: number;
  category: string;
  subcategory: string | null;
}

export interface TransactionRecord extends CreateTransactionInput {
  id: number;
  statementId: string;
  createdAt: Date;
}

interface StatementDatabaseRow {
  id: string;
  owner_id: string | null;
  s3_key: string;
  target_month: string;
  status: StatementStatus;
  content_type: "image/jpeg" | "image/png";
  content_length: string | number;
  processing_started_at: Date | null;
  processed_at: Date | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: Date;
  updated_at: Date;
}

interface TransactionDatabaseRow {
  id: string | number;
  statement_id: string;
  line_number: number;
  transaction_date: string;
  merchant_raw: string;
  merchant_name: string;
  amount: string | number;
  category: string;
  subcategory: string | null;
  created_at: Date;
}

export function normalizeTargetMonth(value: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new Error("targetMonth must be in YYYY-MM format");
  }

  return `${value}-01`;
}

function mapStatement(row: StatementDatabaseRow): StatementRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    s3Key: row.s3_key,
    targetMonth: row.target_month,
    status: row.status,
    contentType: row.content_type,
    contentLength: Number(row.content_length),
    processingStartedAt: row.processing_started_at,
    processedAt: row.processed_at,
    failureCode: row.failure_code,
    failureMessage: row.failure_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTransaction(row: TransactionDatabaseRow): TransactionRecord {
  return {
    id: Number(row.id),
    statementId: row.statement_id,
    lineNumber: row.line_number,
    transactionDate: row.transaction_date,
    merchantRaw: row.merchant_raw,
    merchantName: row.merchant_name,
    amount: Number(row.amount),
    category: row.category,
    subcategory: row.subcategory,
    createdAt: row.created_at,
  };
}

function getFirstRow<T>(result: { rows: T[] }, message: string): T {
  const row = result.rows[0];

  if (!row) {
    throw new Error(message);
  }

  return row;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

async function rollbackTransaction(
  client: PoolClient,
  originalError: unknown,
): Promise<never> {
  try {
    await client.query("ROLLBACK");
  } catch (rollbackError) {
    throw new AggregateError(
      [originalError, rollbackError],
      "DB TransactionとRollbackの両方に失敗しました",
    );
  }

  throw originalError;
}

export class StatementRepository {
  private readonly pool: Pool;

  public constructor(pool: Pool) {
    this.pool = pool;
  }

  public async create(input: CreateStatementInput): Promise<StatementRecord> {
    try {
      const result = await this.pool.query<StatementDatabaseRow>(
        `
          INSERT INTO statements (
            id,
            owner_id,
            s3_key,
            target_month,
            status,
            content_type,
            content_length
          ) VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING
            id,
            owner_id,
            s3_key,
            target_month::text,
            status,
            content_type,
            content_length,
            processing_started_at,
            processed_at,
            failure_code,
            failure_message,
            created_at,
            updated_at
        `,
        [
          input.id ?? randomUUID(),
          input.ownerId ?? null,
          input.s3Key,
          normalizeTargetMonth(input.targetMonth),
          input.status ?? "UPLOAD_PENDING",
          input.contentType,
          input.contentLength,
        ],
      );

      return mapStatement(getFirstRow(result, "statementの作成結果がありません"));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new UniqueConstraintError();
      }

      throw error;
    }
  }

  public async findById(id: string): Promise<StatementRecord | null> {
    const result = await this.pool.query<StatementDatabaseRow>(
      `
        SELECT
          id,
          owner_id,
          s3_key,
          target_month::text,
          status,
          content_type,
          content_length,
          processing_started_at,
          processed_at,
          failure_code,
          failure_message,
          created_at,
          updated_at
        FROM statements
        WHERE id = $1
      `,
      [id],
    );

    const row = result.rows[0];
    return row ? mapStatement(row) : null;
  }

  public async markUploaded(id: string): Promise<StatementRecord | null> {
    const result = await this.pool.query<StatementDatabaseRow>(
      `
        UPDATE statements
        SET
          status = 'UPLOADED',
          updated_at = NOW()
        WHERE id = $1
          AND status = 'UPLOAD_PENDING'
        RETURNING
          id,
          owner_id,
          s3_key,
          target_month::text,
          status,
          content_type,
          content_length,
          processing_started_at,
          processed_at,
          failure_code,
          failure_message,
          created_at,
          updated_at
      `,
      [id],
    );

    const row = result.rows[0];
    return row ? mapStatement(row) : null;
  }

  public async updateStatus(
    id: string,
    status: StatementStatus,
  ): Promise<StatementRecord | null> {
    const result = await this.pool.query<StatementDatabaseRow>(
      `
        UPDATE statements
        SET status = $2, updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          owner_id,
          s3_key,
          target_month::text,
          status,
          content_type,
          content_length,
          processing_started_at,
          processed_at,
          failure_code,
          failure_message,
          created_at,
          updated_at
      `,
      [id, status],
    );

    const row = result.rows[0];
    return row ? mapStatement(row) : null;
  }

  public async findTransactions(statementId: string): Promise<TransactionRecord[]> {
    const result = await this.pool.query<TransactionDatabaseRow>(
      `
        SELECT
          id,
          statement_id,
          line_number,
          transaction_date::text,
          merchant_raw,
          merchant_name,
          amount,
          category,
          subcategory,
          created_at
        FROM transactions
        WHERE statement_id = $1
        ORDER BY line_number ASC
      `,
      [statementId],
    );

    return result.rows.map(mapTransaction);
  }

  public async saveTransactionsAndComplete(
    statementId: string,
    transactions: CreateTransactionInput[],
  ): Promise<void> {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const statement = await client.query<{ status: StatementStatus }>(
        "SELECT status FROM statements WHERE id = $1 FOR UPDATE",
        [statementId],
      );
      const statementRow = statement.rows[0];

      if (!statementRow) {
        throw new Error("statement_not_found");
      }

      if (statementRow.status !== "PROCESSING") {
        throw new Error("statement_must_be_processing");
      }

      for (const transaction of transactions) {
        await client.query(
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
          [
            statementId,
            transaction.lineNumber,
            transaction.transactionDate,
            transaction.merchantRaw,
            transaction.merchantName,
            transaction.amount,
            transaction.category,
            transaction.subcategory,
          ],
        );
      }

      await client.query(
        `
          UPDATE statements
          SET
            status = 'COMPLETED',
            processed_at = NOW(),
            updated_at = NOW()
          WHERE id = $1
        `,
        [statementId],
      );

      await client.query("COMMIT");
    } catch (error) {
      await rollbackTransaction(client, error);
    } finally {
      client.release();
    }
  }
}
