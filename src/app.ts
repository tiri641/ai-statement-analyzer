import { Hono } from "hono";
import type { Context } from "hono";
import { randomUUID } from "node:crypto";
import {
  MAX_UPLOAD_BYTES,
  createStatementRequestSchema,
  statementIdSchema,
} from "./api/schemas.js";
import { StatementConflictError } from "./api/errors.js";
import type {
  CreateStatementInput,
  StatementRecord,
} from "./database/statement-repository.js";

export interface HealthDatabase {
  query(text: string): Promise<unknown>;
}

export interface StatementStore {
  create(input: CreateStatementInput): Promise<StatementRecord>;
  findById(id: string): Promise<StatementRecord | null>;
}

export interface AppDependencies {
  database: HealthDatabase;
  statements: StatementStore;
}

type ApiErrorStatus = 400 | 404 | 409 | 413 | 503;

function errorResponse(
  context: Context,
  status: ApiErrorStatus,
  code: string,
  message: string,
) {
  return context.json(
    {
      error: {
        code,
        message,
      },
    },
    status,
  );
}

function logDependencyFailure(event: string) {
  console.error(
    JSON.stringify({
      event,
      errorCode: "DEPENDENCY_UNAVAILABLE",
    }),
  );
}

function isTooLargeContentLength(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    "contentLength" in body &&
    typeof body.contentLength === "number" &&
    body.contentLength > MAX_UPLOAD_BYTES
  );
}

function toPublicStatement(statement: StatementRecord) {
  return {
    statementId: statement.id,
    targetMonth: statement.targetMonth.slice(0, 7),
    status: statement.status,
    processedAt: statement.processedAt?.toISOString() ?? null,
    failure: statement.failureCode
      ? {
          code: statement.failureCode,
          message:
            statement.failureMessage ?? "明細を処理できませんでした。",
        }
      : null,
  };
}

export function createApp({ database, statements }: AppDependencies) {
  const app = new Hono();

  app.get("/health", (context) => {
    return context.json({
      status: "ok",
      service: "api",
    });
  });

  app.get("/health/db", async (context) => {
    try {
      await database.query("SELECT 1");

      return context.json({
        status: "ok",
        database: "ok",
      });
    } catch {
      console.error(
        JSON.stringify({
          event: "database_health_check_failed",
          errorCode: "DATABASE_UNAVAILABLE",
        }),
      );

      return context.json(
        {
          status: "error",
          database: "unavailable",
        },
        503,
      );
    }
  });

  app.post("/statements", async (context) => {
    let body: unknown;

    try {
      body = await context.req.json();
    } catch {
      return errorResponse(
        context,
        400,
        "INVALID_REQUEST",
        "入力内容が不正です。",
      );
    }

    if (isTooLargeContentLength(body)) {
      return errorResponse(
        context,
        413,
        "FILE_TOO_LARGE",
        "ファイルサイズが上限を超えています。",
      );
    }

    const parsed = createStatementRequestSchema.safeParse(body);

    if (!parsed.success) {
      return errorResponse(
        context,
        400,
        "INVALID_REQUEST",
        "入力内容が不正です。",
      );
    }

    const statementId = randomUUID();
    const createInput: CreateStatementInput = {
      id: statementId,
      ownerId: null,
      s3Key: `statements/${statementId}/source`,
      targetMonth: parsed.data.targetMonth,
      contentType: parsed.data.contentType,
      contentLength: parsed.data.contentLength,
      status: "UPLOAD_PENDING",
    };

    try {
      const statement = await statements.create(createInput);

      return context.json(
        {
          statementId: statement.id,
          status: statement.status,
          upload: null,
        },
        201,
      );
    } catch (error) {
      if (error instanceof StatementConflictError) {
        return errorResponse(
          context,
          409,
          "STATEMENT_CONFLICT",
          "明細の作成が競合しました。",
        );
      }

      logDependencyFailure("statement_create_failed");
      return errorResponse(
        context,
        503,
        "DEPENDENCY_UNAVAILABLE",
        "依存サービスを利用できません。",
      );
    }
  });

  app.get("/statements/:id", async (context) => {
    const parsedId = statementIdSchema.safeParse(context.req.param("id"));

    if (!parsedId.success) {
      return errorResponse(
        context,
        400,
        "INVALID_REQUEST",
        "入力内容が不正です。",
      );
    }

    try {
      const statement = await statements.findById(parsedId.data);

      if (!statement) {
        return errorResponse(
          context,
          404,
          "STATEMENT_NOT_FOUND",
          "明細が見つかりません。",
        );
      }

      return context.json(toPublicStatement(statement));
    } catch {
      logDependencyFailure("statement_get_failed");
      return errorResponse(
        context,
        503,
        "DEPENDENCY_UNAVAILABLE",
        "依存サービスを利用できません。",
      );
    }
  });

  return app;
}
