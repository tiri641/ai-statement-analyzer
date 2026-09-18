import {
  classifyBedrockError,
  InvalidOcrImageError,
  InvalidOcrResponseError,
} from "../ai/bedrock-ocr.js";
import { ProcessingClaimLostError } from "../database/errors.js";
import {
  STATEMENT_FAILURE_CODES,
  type StatementFailureCode,
} from "../database/statement-repository.js";
import {
  InvalidSourceObjectError,
  ObjectNotFoundError,
} from "../storage/object-store.js";

export const ANALYZE_FAILURE_CODES = STATEMENT_FAILURE_CODES;

export type AnalyzeFailureCode = StatementFailureCode;

export type AnalyzeJobErrorStage = "object-store" | "ocr" | "database";

export type AnalyzeJobErrorClassification =
  | { disposition: "RETRYABLE" }
  | {
      disposition: "PERMANENT";
      failureCode: AnalyzeFailureCode;
      failureMessage: string;
    };

function permanent(
  failureCode: AnalyzeFailureCode,
  failureMessage: string,
): AnalyzeJobErrorClassification {
  return {
    disposition: "PERMANENT",
    failureCode,
    failureMessage,
  };
}

export function classifyAnalyzeJobError(
  stage: AnalyzeJobErrorStage,
  error: unknown,
): AnalyzeJobErrorClassification {
  if (isAbortError(error)) {
    return { disposition: "RETRYABLE" };
  }

  if (stage === "object-store") {
    if (error instanceof ObjectNotFoundError) {
      return permanent(
        "SOURCE_OBJECT_NOT_FOUND",
        "明細画像が見つかりません。",
      );
    }

    if (error instanceof InvalidSourceObjectError) {
      return permanent(
        "SOURCE_OBJECT_INVALID",
        "明細画像の情報が不正です。",
      );
    }

    return { disposition: "RETRYABLE" };
  }

  if (stage === "ocr") {
    if (error instanceof InvalidOcrImageError) {
      return permanent("UNSUPPORTED_IMAGE", "対応していない画像形式です。");
    }

    if (error instanceof InvalidOcrResponseError) {
      return permanent(
        "INVALID_OCR_RESPONSE",
        "OCR結果を検証できませんでした。",
      );
    }

    return classifyBedrockError(error) === "RETRYABLE"
      ? { disposition: "RETRYABLE" }
      : permanent(
          "OCR_NON_RETRYABLE",
          "OCRサービスが明細を処理できませんでした。",
        );
  }

  if (error instanceof ProcessingClaimLostError) {
    return { disposition: "RETRYABLE" };
  }

  return { disposition: "RETRYABLE" };
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const candidate = error as { name?: unknown; code?: unknown };
  return candidate.name === "AbortError" || candidate.code === "ABORT_ERR";
}
