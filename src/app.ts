import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { randomUUID } from "node:crypto";
import {
  buildMonthlyAnalytics,
  getMonthlyAnalyticsRanges,
} from "./analytics/monthly-analytics.js";
import type {
  MonthlyAnalyticsAggregates,
  MonthlyAnalyticsRanges,
} from "./analytics/monthly-analytics.js";
import type { MonthlyInsightsResponse } from "./insights/monthly-insights-service.js";
import {
  MAX_REQUEST_BODY_BYTES,
  MAX_UPLOAD_BYTES,
  createStatementRequestSchema,
  monthlyAnalyticsQuerySchema,
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
import {
  createStructuredLogger,
  type StructuredLogger,
} from "./observability/logger.js";

type ApiEnv = {
  Variables: {
    requestId: string;
  };
};

type ApiContext = Context<ApiEnv>;

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

export interface AnalyticsStore {
  findMonthlyAnalytics(
    ranges: MonthlyAnalyticsRanges,
  ): Promise<MonthlyAnalyticsAggregates>;
}

export interface MonthlyInsightsProvider {
  getMonthlyInsights(year: number, month: number): Promise<MonthlyInsightsResponse>;
}

export interface AppDependencies {
  database: HealthDatabase;
  statements: StatementStore;
  analytics: AnalyticsStore;
  monthlyInsights?: MonthlyInsightsProvider;
  objectStore: StatementObjectStore;
  jobQueue: AnalyzeJobQueue;
  presignedUrlExpiresSeconds?: number;
  logger?: StructuredLogger;
}

type ApiErrorStatus = 400 | 404 | 409 | 413 | 503;

function errorResponse(
  context: ApiContext,
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

function logDependencyFailure(
  logger: StructuredLogger,
  context: ApiContext,
  event: string,
  statementId?: string,
) {
  logger.error({
    event,
    requestId: context.get("requestId"),
    ...(statementId ? { statementId } : {}),
    status: "failed",
    disposition: "RETRYABLE",
    errorCode: "DEPENDENCY_UNAVAILABLE",
  });
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
  SOURCE_OBJECT_NOT_FOUND: "明細画像が見つかりません。",
  SOURCE_OBJECT_INVALID: "明細画像の情報が不正です。",
  UNSUPPORTED_IMAGE: "対応していない画像形式です。",
  INVALID_OCR_RESPONSE: "明細を解析できませんでした。",
  OCR_NON_RETRYABLE: "明細を解析できませんでした。",
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

function logStorageFailure(
  logger: StructuredLogger,
  context: ApiContext,
  event: string,
  statementId?: string,
) {
  logDependencyFailure(logger, context, event, statementId);
}

function logQueueFailure(
  logger: StructuredLogger,
  context: ApiContext,
  event: string,
  statementId?: string,
) {
  logDependencyFailure(logger, context, event, statementId);
}

function logInsightsFailure(
  logger: StructuredLogger,
  context: ApiContext,
  event: string,
  statementId?: string,
) {
  logger.error({
    event,
    requestId: context.get("requestId"),
    ...(statementId ? { statementId } : {}),
    status: "failed",
    disposition: event === "monthly_insights_config_missing" ? "PERMANENT" : "RETRYABLE",
    errorCode: "INSIGHTS_UNAVAILABLE",
  });
}

function getSafeErrorCode(error: unknown): string {
  return error instanceof Error && error.name ? error.name : "UNKNOWN_ERROR";
}

export function createApp({
  database,
  statements,
  analytics,
  monthlyInsights,
  objectStore,
  jobQueue,
  presignedUrlExpiresSeconds = 300,
  logger = createStructuredLogger({ service: "api" }),
}: AppDependencies) {
  const app = new Hono<ApiEnv>();

  app.use("*", async (context, next) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    context.set("requestId", requestId);
    context.header("X-Request-Id", requestId);
    logger.info({
      event: "api_request_started",
      requestId,
      method: context.req.method,
      route: context.req.path,
      status: "started",
    });

    try {
      await next();
    } catch (error) {
      logger.error({
        event: "api_request_failed",
        requestId,
        method: context.req.method,
        route: context.req.path,
        status: "failed",
        errorCode: getSafeErrorCode(error),
      });
      throw error;
    } finally {
      context.header("X-Request-Id", requestId);
      logger.info({
        event: "api_request_completed",
        requestId,
        method: context.req.method,
        route: context.req.path,
        status: context.res.status >= 500 ? "error" : "completed",
        httpStatus: context.res.status,
        durationMs: Date.now() - startedAt,
      });
    }
  });

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
      logger.error({
        event: "database_health_check_failed",
        requestId: context.get("requestId"),
        errorCode: "DATABASE_UNAVAILABLE",
      });

      return context.json(
        {
          status: "error",
          database: "unavailable",
        },
        503,
      );
    }
  });

  app.get("/analytics/monthly", async (context) => {
    const queryValues = context.req.queries();
    const hasDuplicateQueryParameter = Object.values(queryValues).some(
      (values) => values.length !== 1,
    );
    const query = hasDuplicateQueryParameter
      ? null
      : Object.fromEntries(
          Object.entries(queryValues).map(([key, values]) => [key, values[0]]),
        );
    const parsedQuery = monthlyAnalyticsQuerySchema.safeParse(query);

    if (!parsedQuery.success) {
      return errorResponse(
        context,
        400,
        "INVALID_REQUEST",
        "入力内容が不正です。",
      );
    }

    const { year, month } = parsedQuery.data;
    const ranges = getMonthlyAnalyticsRanges(year, month);

    try {
      const aggregates = await analytics.findMonthlyAnalytics(ranges);
      return context.json(
        buildMonthlyAnalytics(year, month, aggregates.current, aggregates.previous),
      );
    } catch {
      logDependencyFailure(logger, context, "monthly_analytics_failed");
      return errorResponse(
        context,
        503,
        "DEPENDENCY_UNAVAILABLE",
        "依存サービスを利用できません。",
      );
    }
  });

  app.get("/analytics/monthly/insights", async (context) => {
    const queryValues = context.req.queries();
    const hasDuplicateQueryParameter = Object.values(queryValues).some(
      (values) => values.length !== 1,
    );
    const query = hasDuplicateQueryParameter
      ? null
      : Object.fromEntries(
          Object.entries(queryValues).map(([key, values]) => [key, values[0]]),
        );
    const parsedQuery = monthlyAnalyticsQuerySchema.safeParse(query);

    if (!parsedQuery.success) {
      return errorResponse(
        context,
        400,
        "INVALID_REQUEST",
        "入力内容が不正です。",
      );
    }

    if (!monthlyInsights) {
      logInsightsFailure(logger, context, "monthly_insights_config_missing");
      return errorResponse(
        context,
        503,
        "INSIGHTS_UNAVAILABLE",
        "支出Insightsを利用できません。",
      );
    }

    try {
      const { year, month } = parsedQuery.data;
      return context.json(
        await monthlyInsights.getMonthlyInsights(year, month),
      );
    } catch {
      logInsightsFailure(logger, context, "monthly_insights_failed");
      return errorResponse(
        context,
        503,
        "INSIGHTS_UNAVAILABLE",
        "支出Insightsを利用できません。",
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
        logger.info({
          event: "statement_created",
          requestId: context.get("requestId"),
          statementId: statement.id,
          status: statement.status,
        });

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

        logDependencyFailure(
          logger,
          context,
          "statement_create_failed",
          createInput.id,
        );
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
      logDependencyFailure(
        logger,
        context,
        "upload_complete_statement_get_failed",
        parsedId.data,
      );
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
      logger.info({
        event: "statement_upload_already_completed",
        requestId: context.get("requestId"),
        statementId: statement.id,
        status: statement.status,
      });
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

      logStorageFailure(
        logger,
        context,
        "upload_complete_head_object_failed",
        statement.id,
      );
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
      logDependencyFailure(
        logger,
        context,
        "upload_complete_mark_uploaded_failed",
        statement.id,
      );
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

    logger.info({
      event: "statement_upload_completed",
      requestId: context.get("requestId"),
      statementId: uploadedStatement.id,
      status: uploadedStatement.status,
    });
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
      logQueueFailure(
        logger,
        context,
        "analyze_statement_get_failed",
        parsedId.data,
      );
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
      logger.info({
        event: "analyze_already_queued",
        requestId: context.get("requestId"),
        statementId: statement.id,
        status: statement.status,
      });
      return context.json(toUploadStatus(statement));
    }

    let queuedStatement: StatementRecord | null;

    try {
      queuedStatement = await statements.markQueued(statement.id);
    } catch {
      logQueueFailure(
        logger,
        context,
        "analyze_mark_queued_failed",
        statement.id,
      );
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
        logQueueFailure(
          logger,
          context,
          "analyze_statement_refetch_failed",
          statement.id,
        );
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
          logQueueFailure(
            logger,
            context,
            "analyze_queue_state_recovery_failed",
            queuedStatement.id,
          );
        }
      } catch {
        logQueueFailure(
          logger,
          context,
          "analyze_queue_state_recovery_failed",
          queuedStatement.id,
        );
      }

      logQueueFailure(
        logger,
        context,
        "analyze_job_send_failed",
        queuedStatement.id,
      );
      return errorResponse(
        context,
        503,
        "DEPENDENCY_UNAVAILABLE",
        "依存サービスを利用できません。",
      );
    }

    logger.info({
      event: "analyze_job_sent",
      requestId: context.get("requestId"),
      statementId: queuedStatement.id,
      status: queuedStatement.status,
    });
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
      logDependencyFailure(
        logger,
        context,
        "statement_get_failed",
        parsedId.data,
      );
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
