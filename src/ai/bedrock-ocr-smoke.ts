import "dotenv/config";
import {
  BedrockOcrAnalyzer,
  classifyBedrockError,
  InvalidOcrResponseError,
} from "./bedrock-ocr.js";
import { SYNTHETIC_STATEMENT_PNG } from "./synthetic-statement-fixture.js";

const region = process.env.AWS_REGION ?? "ap-northeast-1";
const modelId = process.env.BEDROCK_OCR_MODEL_ID ?? "jp.amazon.nova-2-lite-v1:0";

const analyzer = new BedrockOcrAnalyzer({ region, modelId });

try {
  const result = await analyzer.analyze({
    bytes: SYNTHETIC_STATEMENT_PNG,
    contentType: "image/png",
  });

  console.log(
    JSON.stringify({
      event: "bedrock_ocr_smoke_succeeded",
      modelId,
      transactionCount: result.transactions.length,
      usage: result.usage,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      event: "bedrock_ocr_smoke_failed",
      modelId,
      disposition: classifyBedrockError(error),
      errorCode:
        typeof error === "object" && error !== null && "name" in error
          ? error.name
          : "UNKNOWN_ERROR",
      reason: error instanceof InvalidOcrResponseError ? error.message : undefined,
    }),
  );
  process.exitCode = 1;
}
