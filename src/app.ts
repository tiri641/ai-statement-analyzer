import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { randomUUID } from "node:crypto";
import {
  MAX_REQUEST_BODY_BYTES,
  MAX_UPLOAD_BYTES,
  createStatementRequestSchema,
  statementIdSchema,
} from "./api/schemas.js";
import { UniqueConstraintError } from "./database/errors.js";
import type {
  CreateStatementInput,
  StatementRecord,
} from "./database/statement-repository.js";
import { ObjectNotFoundError } from "./storage/object-store.js";
import type { StatementObjectStore } from "./storage/object-store.js";
import type { AnalyzeJobQueue } from "./queue/analyze-job.js";

export interface HealthDatabase {
  query(text: string): Promise<unknown>;
}

export interface StatementStore {
  create(input: CreateStatementInput): Promise<StatementRecord>;
  findById(id: string): Promise<StatementRecord | null>;
  markUploaded(id: string): Promise<StatementRecord | null>;
  markQueued(id: string): Promise<StatementRecord | null>;
  resetQueuedToUploaded(id: string): Promise<StatementRecord | null>;
}

export interface AppDependencies {
  database: HealthDatabase;
  statements: StatementStore;
  objectStore: StatementObjectStore;
  jobQueue: AnalyzeJobQueue;
  presignedUrlExpiresSeconds?: number;
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

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

const PUBLIC_FAILURE_MESSAGES: Record<string, string> = {
  UNSUPPORTED_IMAGE: "対応していない画像形式です。",
  INVALID_OCR_RESPONSE: "明細を解析できませんでした。",
  PROCESSING_FAILED: "明細を処理できませんでした。",
};

function toPublicFailure(statement: StatementRecord) {
  if (!statement.failureCode) {
    return null;
  }

  const message = PUBLIC_FAILURE_MESSAGES[statement.failureCode];

  if (!message) {
    return {
      code: "PROCESSING_FAILED",
      message: "明細を処理できませんでした。",
    };
  }

  return {
    code: statement.failureCode,
    message,
  };
}

function toPublicStatement(statement: StatementRecord) {
  return {
    statementId: statement.id,
    targetMonth: statement.targetMonth.slice(0, 7),
    status: statement.status,
    processedAt: statement.processedAt?.toISOString() ?? null,
    failure: toPublicFailure(statement),
  };
}

function toUploadStatus(statement: StatementRecord) {
  return {
    statementId: statement.id,
    status: statement.status,
  };
}

function logStorageFailure(event: string) {
  console.error(
    JSON.stringify({
      event,
      errorCode: "DEPENDENCY_UNAVAILABLE",
    }),
  );
}

function logQueueFailure(event: string) {
  console.error(
    JSON.stringify({
      event,
      errorCode: "DEPENDENCY_UNAVAILABLE",
    }),
  );
}

export function createApp({
  database,
  statements,
  objectStore,
  jobQueue,
  presignedUrlExpiresSeconds = 300,
}: AppDependencies) {
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

  app.post(
    "/statements",
    bodyLimit({
      maxSize: MAX_REQUEST_BODY_BYTES,
      onError: (context) =>
        errorResponse(
          context,
          413,
          "REQUEST_TOO_LARGE",
          "リクエストが大きすぎます。",
        ),
    }),
    async (context) => {
      if (!isJsonContentType(context.req.header("Content-Type"))) {
        return errorResponse(
          context,
          400,
          "INVALID_REQUEST",
          "Content-Typeはapplication/jsonを指定してください。",
        );
      }

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
        const uploadUrl = await objectStore.createPresignedPutUrl({
          key: createInput.s3Key,
          contentType: createInput.contentType,
          expiresInSeconds: presignedUrlExpiresSeconds,
        });
        const statement = await statements.create(createInput);

        return context.json(
          {
            statementId: statement.id,
            status: statement.status,
            upload: {
              method: "PUT",
              url: uploadUrl,
              headers: {
                "Content-Type": createInput.contentType,
              },
              expiresInSeconds: presignedUrlExpiresSeconds,
            },
          },
          201,
        );
      } catch (error) {
        if (error instanceof UniqueConstraintError) {
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
    },
  );

  app.post("/statements/:id/upload/complete", async (context) => {
    const parsedId = statementIdSchema.safeParse(context.req.param("id"));

    if (!parsedId.success) {
      return errorResponse(
        context,
        400,
        "INVALID_REQUEST",
        "入力内容が不正です。",
      );
    }

    let statement: StatementRecord | null;

    try {
      statement = await statements.findById(parsedId.data);
    } catch {
      logDependencyFailure("upload_complete_statement_get_failed");
      return errorResponse(
        context,
        503,
        "DEPENDENCY_UNAVAILABLE",
        "依存サービスを利用できません。",
      );
    }

    if (!statement) {
      return errorResponse(
        context,
        404,
        "STATEMENT_NOT_FOUND",
        "明細が見つかりません。",
      );
    }

    if (statement.status === "FAILED") {
      return errorResponse(
        context,
        409,
        "STATEMENT_NOT_UPLOADABLE",
        "この明細はアップロード完了にできません。",
      );
    }

    if (statement.status !== "UPLOAD_PENDING") {
      return context.json(toUploadStatus(statement));
    }

    let objectMetadata;

    try {
      objectMetadata = await objectStore.headObject(statement.s3Key);
    } catch (error) {
      if (
        error instanceof ObjectNotFoundError ||
        (error instanceof Error && error.name === "ObjectNotFoundError")
      ) {
        return errorResponse(
          context,
          404,
          "UPLOAD_NOT_FOUND",
          "アップロードされた画像が見つかりません。",
        );
      }

      logStorageFailure("upload_complete_head_object_failed");
      return errorResponse(
        context,
        503,
        "DEPENDENCY_UNAVAILABLE",
        "依存サービスを利用できません。",
      );
    }

    if (
      objectMetadata.contentType !== statement.contentType ||
      objectMetadata.contentLength !== statement.contentLength
    ) {
      return errorResponse(
        context,
        409,
        "UPLOAD_METADATA_MISMATCH",
        "アップロードされた画像の情報が登録内容と一致しません。",
      );
    }

    let uploadedStatement: StatementRecord | null;

    try {
      uploadedStatement = await statements.markUploaded(statement.id);

      if (!uploadedStatement) {
        uploadedStatement = await statements.findById(statement.id);
      }
    } catch {
      logDependencyFailure("upload_complete_mark_uploaded_failed");
      return errorResponse(
        context,
        503,
        "DEPENDENCY_UNAVAILABLE",
        "依存サービスを利用できません。",
      );
    }

    if (!uploadedStatement) {
      return errorResponse(
        context,
        404,
        "STATEMENT_NOT_FOUND",
        "明細が見つかりません。",
      );
    }

    if (uploadedStatement.status === "FAILED") {
      return errorResponse(
        context,
        409,
        "STATEMENT_NOT_UPLOADABLE",
        "この明細はアップロード完了にできません。",
      );
    }

    return context.json(toUploadStatus(uploadedStatement));
  });

  app.post("/statements/:id/analyze", async (context) => {
    const parsedId = statementIdSchema.safeParse(context.req.param("id"));

    if (!parsedId.success) {
      return errorResponse(
        context,
        400,
        "INVALID_REQUEST",
        "入力内容が不正です。",
      );
    }

    let statement: StatementRecord | null;

    try {
      statement = await statements.findById(parsedId.data);
    } catch {
      logQueueFailure("analyze_statement_get_failed");
      return errorResponse(
        context,
        503,
        "DEPENDENCY_UNAVAILABLE",
        "依存サービスを利用できません。",
      );
    }

    if (!statement) {
      return errorResponse(
        context,
        404,
        "STATEMENT_NOT_FOUND",
        "明細が見つかりません。",
      );
    }

    if (statement.status === "UPLOAD_PENDING") {
      return errorResponse(
        context,
        409,
        "STATEMENT_NOT_READY",
        "画像のアップロードが完了していません。",
      );
    }

    if (statement.status === "FAILED") {
      return errorResponse(
        context,
        409,
        "STATEMENT_NOT_ANALYZABLE",
        "この明細は解析対象にできません。",
      );
    }

    if (statement.status !== "UPLOADED") {
      return context.json(toUploadStatus(statement));
    }

    let queuedStatement: StatementRecord | null;

    try {
      queuedStatement = await statements.markQueued(statement.id);
    } catch {
      logQueueFailure("analyze_mark_queued_failed");
      return errorResponse(
        context,
        503,
        "DEPENDENCY_UNAVAILABLE",
        "依存サービスを利用できません。",
      );
    }

    if (!queuedStatement) {
      try {
        queuedStatement = await statements.findById(statement.id);
      } catch {
        logQueueFailure("analyze_statement_refetch_failed");
        return errorResponse(
          context,
          503,
          "DEPENDENCY_UNAVAILABLE",
          "依存サービスを利用できません。",
        );
      }

      if (!queuedStatement) {
        return errorResponse(
          context,
          404,
          "STATEMENT_NOT_FOUND",
          "明細が見つかりません。",
        );
      }

      if (queuedStatement.status !== "UPLOADED") {
        return context.json(toUploadStatus(queuedStatement));
      }

      return errorResponse(
        context,
        409,
        "ANALYZE_CONFLICT",
        "解析開始の競合が発生しました。",
      );
    }

    try {
      await jobQueue.sendAnalyzeJob(queuedStatement.id);
    } catch {
      try {
        const resetStatement = await statements.resetQueuedToUploaded(
          queuedStatement.id,
        );

        if (!resetStatement) {
          logQueueFailure("analyze_queue_state_recovery_failed");
        }
      } catch {
        logQueueFailure("analyze_queue_state_recovery_failed");
      }

      logQueueFailure("analyze_job_send_failed");
      return errorResponse(
        context,
        503,
        "DEPENDENCY_UNAVAILABLE",
        "依存サービスを利用できません。",
      );
    }

    return context.json(toUploadStatus(queuedStatement), 202);
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
