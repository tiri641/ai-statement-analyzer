import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InvalidOcrImageError,
  InvalidOcrResponseError,
} from "../src/ai/bedrock-ocr.ts";
import { ProcessingClaimLostError } from "../src/database/errors.ts";
import {
  classifyAnalyzeJobError,
  type AnalyzeJobErrorStage,
} from "../src/worker/analyze-job-error.ts";
import {
  InvalidSourceObjectError,
  ObjectNotFoundError,
} from "../src/storage/object-store.ts";

function classify(stage: AnalyzeJobErrorStage, error: unknown) {
  return classifyAnalyzeJobError(stage, error);
}

test("S3のObjectNotFoundは恒久エラーとして分類する", () => {
  assert.deepEqual(classify("object-store", new ObjectNotFoundError()), {
    disposition: "PERMANENT",
    failureCode: "SOURCE_OBJECT_NOT_FOUND",
    failureMessage: "明細画像が見つかりません。",
  });
});

test("S3の画像情報不正は恒久エラーとして分類する", () => {
  assert.deepEqual(
    classify("object-store", new InvalidSourceObjectError("secret=hidden")),
    {
      disposition: "PERMANENT",
      failureCode: "SOURCE_OBJECT_INVALID",
      failureMessage: "明細画像の情報が不正です。",
    },
  );
});

test("S3の未知の障害は再試行可能として分類する", () => {
  assert.deepEqual(classify("object-store", new Error("network failure")), {
    disposition: "RETRYABLE",
  });
});

test("対応外画像は恒久エラーとして分類する", () => {
  assert.deepEqual(
    classify("ocr", new InvalidOcrImageError("unsupported image")),
    {
      disposition: "PERMANENT",
      failureCode: "UNSUPPORTED_IMAGE",
      failureMessage: "対応していない画像形式です。",
    },
  );
});

test("OCR応答のValidation失敗は恒久エラーとして分類する", () => {
  assert.deepEqual(
    classify("ocr", new InvalidOcrResponseError("raw model response")),
    {
      disposition: "PERMANENT",
      failureCode: "INVALID_OCR_RESPONSE",
      failureMessage: "OCR結果を検証できませんでした。",
    },
  );
});

test("BedrockのThrottlingは再試行可能として分類する", () => {
  const error = new Error("throttled");
  error.name = "ThrottlingException";

  assert.deepEqual(classify("ocr", error), {
    disposition: "RETRYABLE",
  });
});

test("Bedrockの非再試行エラーは恒久エラーとして分類する", () => {
  const error = new Error("access denied");
  error.name = "AccessDeniedException";

  assert.deepEqual(classify("ocr", error), {
    disposition: "PERMANENT",
    failureCode: "OCR_NON_RETRYABLE",
    failureMessage: "OCRサービスが明細を処理できませんでした。",
  });
});

test("処理権を失ったDB処理は再試行可能として分類する", () => {
  assert.deepEqual(
    classify("database", new ProcessingClaimLostError()),
    { disposition: "RETRYABLE" },
  );
});

test("未知のDB障害は再試行可能として分類する", () => {
  assert.deepEqual(classify("database", new Error("database unavailable")), {
    disposition: "RETRYABLE",
  });
});
