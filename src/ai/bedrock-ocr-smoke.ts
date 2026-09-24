import "dotenv/config";
import {
  BedrockOcrAnalyzer,
  classifyBedrockError,
  InvalidOcrResponseError,
} from "./bedrock-ocr.js";
import { SYNTHETIC_STATEMENT_PNG } from "./synthetic-statement-fixture.js";
import { createStructuredLogger } from "../observability/logger.js";

const region = process.env.AWS_REGION ?? "ap-northeast-1";
const modelId = process.env.BEDROCK_OCR_MODEL_ID ?? "jp.amazon.nova-2-lite-v1:0";
const logger = createStructuredLogger({ service: "bedrock-ocr-smoke" });

const analyzer = new BedrockOcrAnalyzer({ region, modelId });

try {
  const result = await analyzer.analyze({
    bytes: SYNTHETIC_STATEMENT_PNG,
    contentType: "image/png",
  });

  logger.info({
    event: "bedrock_ocr_smoke_succeeded",
    status: "completed",
    modelId,
    transactionCount: result.transactions.length,
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    totalTokens: result.usage?.totalTokens,
  });
} catch (error) {
  logger.error({
    event: "bedrock_ocr_smoke_failed",
    status: "failed",
    modelId,
    disposition: classifyBedrockError(error),
    errorCode:
      typeof error === "object" && error !== null && "name" in error
        ? error.name
        : error instanceof InvalidOcrResponseError
          ? "INVALID_OCR_RESPONSE"
          : "UNKNOWN_ERROR",
  });
  process.exitCode = 1;
}
