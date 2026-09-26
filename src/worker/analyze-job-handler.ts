import { randomUUID } from "node:crypto";
import type {
  AnalyzeJobDisposition,
  AnalyzeJobHandler,
} from "./analyze-worker.js";
import type {
  OcrAnalysisResult,
  OcrAnalyzeOptions,
  OcrImageInput,
} from "../ai/bedrock-ocr.js";
import {
  InvalidOcrImageError,
  InvalidOcrResponseError,
} from "../ai/bedrock-ocr.js";
import type {
  CreateTransactionInput,
  ProcessingClaim,
  StatementFailureCode,
  StatementRecord,
} from "../database/statement-repository.js";
import {
  InvalidSourceObjectError,
  type StatementObjectStore,
} from "../storage/object-store.js";
import {
  annotateAnalyzeJobError,
  classifyAnalyzeJobError,
  type AnalyzeJobErrorStage,
} from "./analyze-job-error.js";
import type { StructuredLogger } from "../observability/logger.js";

export interface ProcessingStatementStore {
  findById(id: string): Promise<StatementRecord | null>;
  claimForProcessing(
    statementId: string,
    processingToken: string,
    leaseSeconds?: number,
  ): Promise<ProcessingClaim | null>;
  saveTransactionsAndComplete(
    statementId: string,
    processingToken: string,
    transactions: CreateTransactionInput[],
  ): Promise<void>;
  markFailed(
    statementId: string,
    processingToken: string,
    failureCode: StatementFailureCode,
    failureMessage: string,
  ): Promise<boolean>;
}

export interface OcrAnalyzer {
  analyze(
    image: OcrImageInput,
    options?: OcrAnalyzeOptions,
  ): Promise<OcrAnalysisResult>;
}

export interface AnalyzeJobHandlerDependencies {
  statements: ProcessingStatementStore;
  objectStore: StatementObjectStore;
  analyzer: OcrAnalyzer;
  leaseSeconds?: number;
  tokenGenerator?: () => string;
  logger?: StructuredLogger;
  modelId?: string;
}

function isTerminalStatus(status: StatementRecord["status"]): boolean {
  return status === "COMPLETED" || status === "FAILED";
}

function toCreateTransactionInputs(
  result: OcrAnalysisResult,
): CreateTransactionInput[] {
  return result.transactions.map((transaction) => ({
    lineNumber: transaction.lineNumber,
    transactionDate: transaction.transactionDate,
    merchantRaw: transaction.merchantRaw,
    merchantName: transaction.merchantName,
    amount: transaction.amount,
    category: transaction.category,
    subcategory: transaction.subcategory,
  }));
}

async function resolveUnclaimedJob(
  statements: ProcessingStatementStore,
  statementId: string,
): Promise<AnalyzeJobDisposition> {
  const statement = await statements.findById(statementId);
  return !statement || isTerminalStatus(statement.status) ? "ACK" : "RETRY";
}

function getSafeErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return "UNKNOWN_ERROR";
  }

  const candidate = error as { name?: unknown; code?: unknown };
  if (typeof candidate.name === "string" && candidate.name.length > 0) {
    return candidate.name;
  }

  if (typeof candidate.code === "string" && candidate.code.length > 0) {
    return candidate.code;
  }

  return "UNKNOWN_ERROR";
}

function isBedrockRequestFailure(stage: AnalyzeJobErrorStage, error: unknown) {
  return (
    stage === "ocr" &&
    !(error instanceof InvalidOcrImageError) &&
    !(error instanceof InvalidOcrResponseError)
  );
}

export function createAnalyzeJobHandler(
  dependencies: AnalyzeJobHandlerDependencies,
): AnalyzeJobHandler {
  const leaseSeconds = dependencies.leaseSeconds;
  const tokenGenerator = dependencies.tokenGenerator ?? randomUUID;
  const logger = dependencies.logger;

  return async (job, options) => {
    const startedAt = Date.now();
    const processingToken = tokenGenerator();
    const claimStartedAt = Date.now();
    logger?.info({
      event: "worker_stage_started",
      statementId: job.statementId,
      messageId: job.messageId,
      receiveCount: job.receiveCount,
      stage: "claim",
      status: "started",
    });

    let claim: ProcessingClaim | null;
    try {
      claim = await dependencies.statements.claimForProcessing(
        job.statementId,
        processingToken,
        leaseSeconds,
      );
    } catch (error) {
      logger?.error({
        event: "worker_stage_failed",
        statementId: job.statementId,
        messageId: job.messageId,
        receiveCount: job.receiveCount,
        stage: "claim",
        status: "failed",
        disposition: "RETRYABLE",
        errorCode: getSafeErrorCode(error),
        durationMs: Date.now() - claimStartedAt,
      });
      return "RETRY";
    }

    if (!claim) {
      let disposition: AnalyzeJobDisposition;
      try {
        disposition = await resolveUnclaimedJob(
          dependencies.statements,
          job.statementId,
        );
      } catch (error) {
        logger?.error({
          event: "worker_stage_failed",
          statementId: job.statementId,
          messageId: job.messageId,
          receiveCount: job.receiveCount,
          stage: "claim",
          status: "failed",
          disposition: "RETRYABLE",
          errorCode: getSafeErrorCode(error),
          durationMs: Date.now() - claimStartedAt,
        });
        return "RETRY";
      }
      logger?.info({
        event: disposition === "ACK" ? "worker_job_skipped" : "worker_job_retry",
        statementId: job.statementId,
        messageId: job.messageId,
        receiveCount: job.receiveCount,
        stage: "claim",
        disposition,
        durationMs: Date.now() - startedAt,
      });
      return disposition;
    }

    logger?.info({
      event: "worker_stage_completed",
      statementId: job.statementId,
      messageId: job.messageId,
      receiveCount: job.receiveCount,
      stage: "claim",
      status: "completed",
      durationMs: Date.now() - claimStartedAt,
    });

    logger?.info({
      event: "worker_job_claimed",
      statementId: job.statementId,
      messageId: job.messageId,
      receiveCount: job.receiveCount,
      stage: "claim",
      status: "completed",
      durationMs: Date.now() - claimStartedAt,
    });

    let stage: AnalyzeJobErrorStage = "object-store";
    let stageStartedAt = Date.now();
    logger?.info({
      event: "worker_stage_started",
      statementId: job.statementId,
      messageId: job.messageId,
      receiveCount: job.receiveCount,
      stage,
      status: "started",
    });

    try {
      const object = await dependencies.objectStore.getObject(
        claim.s3Key,
        options?.signal ? { signal: options.signal } : undefined,
      );

      if (
        object.contentType !== claim.contentType ||
        object.contentLength !== claim.contentLength ||
        object.bytes.byteLength !== claim.contentLength
      ) {
        throw new InvalidSourceObjectError(
          "S3 object metadata does not match statement",
        );
      }

      logger?.info({
        event: "worker_stage_completed",
        statementId: job.statementId,
        messageId: job.messageId,
        receiveCount: job.receiveCount,
        stage: "object-store",
        status: "completed",
        durationMs: Date.now() - stageStartedAt,
      });

      const image: OcrImageInput = {
        bytes: object.bytes,
        contentType: claim.contentType,
      };
      stage = "ocr";
      stageStartedAt = Date.now();
      logger?.info({
        event: "worker_stage_started",
        statementId: job.statementId,
        messageId: job.messageId,
        receiveCount: job.receiveCount,
        stage,
        status: "started",
      });
      const analysis = await dependencies.analyzer.analyze(
        image,
        options?.signal ? { signal: options.signal } : undefined,
      );

      logger?.info({
        event: "worker_stage_completed",
        statementId: job.statementId,
        messageId: job.messageId,
        receiveCount: job.receiveCount,
        stage: "ocr",
        status: "completed",
        modelId: dependencies.modelId,
        durationMs: Date.now() - stageStartedAt,
      });

      stage = "database";
      stageStartedAt = Date.now();
      logger?.info({
        event: "worker_stage_started",
        statementId: job.statementId,
        messageId: job.messageId,
        receiveCount: job.receiveCount,
        stage,
        status: "started",
      });
      await dependencies.statements.saveTransactionsAndComplete(
        claim.statementId,
        claim.processingToken,
        toCreateTransactionInputs(analysis),
      );

      logger?.info({
        event: "worker_stage_completed",
        statementId: job.statementId,
        messageId: job.messageId,
        receiveCount: job.receiveCount,
        stage: "database",
        status: "completed",
        durationMs: Date.now() - stageStartedAt,
      });

      return "ACK";
    } catch (error) {
      const classification = classifyAnalyzeJobError(stage, error);
      const errorCode = getSafeErrorCode(error);

      logger?.error({
        event: "worker_stage_failed",
        statementId: job.statementId,
        messageId: job.messageId,
        receiveCount: job.receiveCount,
        stage,
        status: "failed",
        disposition: classification.disposition,
        errorCode,
        durationMs: Date.now() - stageStartedAt,
      });

      if (stage === "ocr" && error instanceof InvalidOcrResponseError) {
        logger?.error({
          event: "bedrock_response_invalid",
          statementId: job.statementId,
          messageId: job.messageId,
          receiveCount: job.receiveCount,
          stage,
          status: "failed",
          disposition: "PERMANENT",
          errorCode,
          modelId: dependencies.modelId,
          durationMs: Date.now() - stageStartedAt,
        });
      } else if (isBedrockRequestFailure(stage, error)) {
        logger?.error({
          event: "bedrock_request_failed",
          statementId: job.statementId,
          messageId: job.messageId,
          receiveCount: job.receiveCount,
          stage,
          status: "failed",
          disposition: classification.disposition,
          errorCode,
          modelId: dependencies.modelId,
          durationMs: Date.now() - stageStartedAt,
        });
      }

      if (classification.disposition === "RETRYABLE") {
        logger?.error({
          event: "worker_job_retry",
          statementId: job.statementId,
          messageId: job.messageId,
          receiveCount: job.receiveCount,
          stage,
          status: "retry",
          disposition: "RETRYABLE",
          errorCode,
          durationMs: Date.now() - startedAt,
        });
        return "RETRY";
      }

      let markedFailed: boolean;
      try {
        markedFailed = await dependencies.statements.markFailed(
          claim.statementId,
          claim.processingToken,
          classification.failureCode,
          classification.failureMessage,
        );
      } catch (markFailedError) {
        logger?.error({
          event: "worker_stage_failed",
          statementId: job.statementId,
          messageId: job.messageId,
          receiveCount: job.receiveCount,
          stage: "database",
          status: "failed",
          disposition: "RETRYABLE",
          errorCode: getSafeErrorCode(markFailedError),
          durationMs: Date.now() - startedAt,
        });
        throw annotateAnalyzeJobError(markFailedError, "database");
      }

      if (markedFailed) {
        logger?.error({
          event: "worker_job_failed",
          statementId: job.statementId,
          messageId: job.messageId,
          receiveCount: job.receiveCount,
          stage,
          status: "failed",
          disposition: "PERMANENT",
          errorCode: classification.failureCode,
          durationMs: Date.now() - startedAt,
        });
        return "ACK";
      }

      logger?.error({
        event: "worker_job_retry",
        statementId: job.statementId,
        messageId: job.messageId,
        receiveCount: job.receiveCount,
        stage: "database",
        status: "retry",
        disposition: "RETRYABLE",
        errorCode: "PROCESSING_CLAIM_LOST",
        durationMs: Date.now() - startedAt,
      });
      return "RETRY";
    }
  };
}
