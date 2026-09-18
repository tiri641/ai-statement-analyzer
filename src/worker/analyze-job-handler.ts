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
  classifyAnalyzeJobError,
  type AnalyzeJobErrorStage,
} from "./analyze-job-error.js";

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

export function createAnalyzeJobHandler(
  dependencies: AnalyzeJobHandlerDependencies,
): AnalyzeJobHandler {
  const leaseSeconds = dependencies.leaseSeconds;
  const tokenGenerator = dependencies.tokenGenerator ?? randomUUID;

  return async (job, options) => {
    const processingToken = tokenGenerator();
    const claim = await dependencies.statements.claimForProcessing(
      job.statementId,
      processingToken,
      leaseSeconds,
    );

    if (!claim) {
      return resolveUnclaimedJob(dependencies.statements, job.statementId);
    }

    let stage: AnalyzeJobErrorStage = "object-store";

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

      const image: OcrImageInput = {
        bytes: object.bytes,
        contentType: claim.contentType,
      };
      stage = "ocr";
      const analysis = await dependencies.analyzer.analyze(
        image,
        options?.signal ? { signal: options.signal } : undefined,
      );

      stage = "database";
      await dependencies.statements.saveTransactionsAndComplete(
        claim.statementId,
        claim.processingToken,
        toCreateTransactionInputs(analysis),
      );

      return "ACK";
    } catch (error) {
      const classification = classifyAnalyzeJobError(stage, error);

      if (classification.disposition === "RETRYABLE") {
        return "RETRY";
      }

      const markedFailed = await dependencies.statements.markFailed(
        claim.statementId,
        claim.processingToken,
        classification.failureCode,
        classification.failureMessage,
      );

      return markedFailed ? "ACK" : "RETRY";
    }
  };
}
