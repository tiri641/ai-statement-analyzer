import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  ConverseCommandOutput,
  ConverseCommandInput,
} from "@aws-sdk/client-bedrock-runtime";
import type { DocumentType } from "@smithy/types";
import {
  BedrockOcrAnalyzer,
  classifyBedrockError,
  InvalidOcrResponseError,
  OCR_TOOL_NAME,
  type BedrockRuntimeClientLike,
  type OcrImageInput,
} from "../src/ai/bedrock-ocr.js";
import {
  MAX_OCR_IMAGE_BYTES,
  parseOcrToolInput,
  type OcrToolInput,
} from "../src/ai/ocr-schema.js";
import { SYNTHETIC_STATEMENT_PNG } from "../src/ai/synthetic-statement-fixture.js";

const image: OcrImageInput = {
  bytes: new Uint8Array([137, 80, 78, 71]),
  contentType: "image/png",
};

const validInput: OcrToolInput = {
  transactions: [
    {
      transactionDate: "2026-08-20",
      merchantRaw: "AMAZON.CO.JP",
      merchantName: "Amazon",
      amount: 3980,
      category: "買い物",
      subcategory: "EC",
      lineNumber: 1,
    },
    {
      transactionDate: "2026-08-21",
      merchantRaw: "REFUND STORE",
      merchantName: "Refund Store",
      amount: -500,
      category: "その他",
      subcategory: "なし",
      lineNumber: 2,
    },
  ],
};

function createResponse(input: unknown): ConverseCommandOutput {
  return {
    output: {
      message: {
        role: "assistant",
        content: [
          {
            toolUse: {
              toolUseId: "tool-use-1",
              name: OCR_TOOL_NAME,
              input: input as DocumentType,
            },
          },
        ],
      },
    },
    stopReason: "tool_use",
    usage: {
      inputTokens: 100,
      outputTokens: 80,
      totalTokens: 180,
    },
    metrics: { latencyMs: 10 },
    $metadata: {},
  };
}

function createClient(response: ConverseCommandOutput) {
  let input: ConverseCommandInput | undefined;
  let abortSignal: AbortSignal | undefined;
  const client: BedrockRuntimeClientLike = {
    send: async (command, options) => {
      input = command.input;
      abortSignal = options?.abortSignal;
      return response;
    },
  };

  return {
    client,
    getInput: () => input,
    getAbortSignal: () => abortSignal,
  };
}

test("OCR Tool入力を検証し、なしをnullへ変換する", () => {
  const result = parseOcrToolInput(validInput);

  assert.deepEqual(result.transactions[0], {
    transactionDate: "2026-08-20",
    merchantRaw: "AMAZON.CO.JP",
    merchantName: "Amazon",
    amount: 3980,
    category: "買い物",
    subcategory: "EC",
    lineNumber: 1,
  });
  assert.equal(result.transactions[1]?.subcategory, null);
});

test("合成明細FixtureがPNGとして生成される", () => {
  assert.deepEqual(Array.from(SYNTHETIC_STATEMENT_PNG.slice(0, 8)), [
    137,
    80,
    78,
    71,
    13,
    10,
    26,
    10,
  ]);
  assert.ok(SYNTHETIC_STATEMENT_PNG.length > 1_000);
});

test("OCR Tool入力のカテゴリとsubcategoryの組み合わせを検証する", () => {
  assert.throws(
    () =>
      parseOcrToolInput({
        ...validInput,
        transactions: [
          {
            ...validInput.transactions[0],
            category: "交通",
            subcategory: "EC",
          },
        ],
      }),
    /カテゴリとsubcategoryの組み合わせが不正です/,
  );
});

test("OCR Tool入力の行番号重複、日付、金額を検証する", () => {
  assert.throws(
    () =>
      parseOcrToolInput({
        transactions: [
          { ...validInput.transactions[0], lineNumber: 1 },
          { ...validInput.transactions[1], lineNumber: 1 },
        ],
      }),
    /lineNumberが重複しています/,
  );

  assert.throws(
    () =>
      parseOcrToolInput({
        transactions: [
          { ...validInput.transactions[0], transactionDate: "2026-02-30" },
        ],
      }),
    /取引日が不正です/,
  );

  assert.throws(
    () =>
      parseOcrToolInput({
        transactions: [{ ...validInput.transactions[0], amount: 0 }],
      }),
    /金額は0以外の整数である必要があります/,
  );
});

test("Bedrockが返したOCR Tool入力を検証して結果を返す", async () => {
  const fake = createClient(createResponse(validInput));
  const analyzer = new BedrockOcrAnalyzer({
    client: fake.client,
    modelId: "jp.amazon.nova-2-lite-v1:0",
    region: "ap-northeast-1",
  });

  const result = await analyzer.analyze(image);

  assert.equal(result.transactions.length, 2);
  assert.equal(result.transactions[1]?.subcategory, null);
  assert.deepEqual(result.usage, {
    inputTokens: 100,
    outputTokens: 80,
    totalTokens: 180,
  });
});

test("Converseへ画像bytes、強制Tool選択、Tool schemaを渡す", async () => {
  const fake = createClient(createResponse(validInput));
  const analyzer = new BedrockOcrAnalyzer({
    client: fake.client,
    modelId: "jp.amazon.nova-2-lite-v1:0",
    region: "ap-northeast-1",
  });

  await analyzer.analyze(image);

  const input = fake.getInput();
  assert.equal(input?.modelId, "jp.amazon.nova-2-lite-v1:0");
  assert.equal(input?.messages?.[0]?.role, "user");
  assert.deepEqual(input?.messages?.[0]?.content?.[0], {
    image: {
      format: "png",
      source: { bytes: image.bytes },
    },
  });

  const tool = input?.toolConfig?.tools?.[0];
  assert.equal("toolSpec" in (tool ?? {}), true);
  if (tool && "toolSpec" in tool) {
    assert.equal(tool.toolSpec.name, OCR_TOOL_NAME);
    assert.equal(tool.toolSpec.strict, undefined);
  }
  assert.deepEqual(input?.toolConfig?.toolChoice, {
    tool: { name: OCR_TOOL_NAME },
  });
  assert.equal(input?.inferenceConfig?.maxTokens, 5_000);
  assert.equal(input?.inferenceConfig?.temperature, 0.01);
});

test("Bedrock応答に期待したTool Useがなければ拒否する", async () => {
  const fake = createClient({
    output: {
      message: {
        role: "assistant",
        content: [{ text: "unexpected text" }],
      },
    },
    stopReason: "end_turn",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    metrics: { latencyMs: 0 },
    $metadata: {},
  });
  const analyzer = new BedrockOcrAnalyzer({
    client: fake.client,
    modelId: "jp.amazon.nova-2-lite-v1:0",
    region: "ap-northeast-1",
  });

  await assert.rejects(
    () => analyzer.analyze(image),
    (error: unknown) => error instanceof InvalidOcrResponseError,
  );
});

test("Bedrock応答の不正なcontent要素を安全なエラーとして拒否する", async () => {
  const fake = createClient({
    output: {
      message: {
        role: "assistant",
        content: [null as never],
      },
    },
    stopReason: "tool_use",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    },
    metrics: { latencyMs: 0 },
    $metadata: {},
  });
  const analyzer = new BedrockOcrAnalyzer({
    client: fake.client,
    modelId: "jp.amazon.nova-2-lite-v1:0",
    region: "ap-northeast-1",
  });

  await assert.rejects(
    () => analyzer.analyze(image),
    (error: unknown) => error instanceof InvalidOcrResponseError,
  );
});

test("画像形式とサイズをBedrock呼び出し前に検証する", async () => {
  const fake = createClient(createResponse(validInput));
  const analyzer = new BedrockOcrAnalyzer({
    client: fake.client,
    modelId: "jp.amazon.nova-2-lite-v1:0",
    region: "ap-northeast-1",
  });

  await assert.rejects(
    () =>
      analyzer.analyze({
        bytes: new Uint8Array([1]),
        contentType: "image/gif" as OcrImageInput["contentType"],
      }),
    /対応していない画像形式です/,
  );
  await assert.rejects(
    () =>
      analyzer.analyze({
        bytes: new Uint8Array(MAX_OCR_IMAGE_BYTES + 1),
        contentType: "image/png",
      }),
    /画像サイズが上限を超えています/,
  );
});

test("AbortSignalをBedrock SDKへ渡す", async () => {
  const fake = createClient(createResponse(validInput));
  const analyzer = new BedrockOcrAnalyzer({
    client: fake.client,
    modelId: "jp.amazon.nova-2-lite-v1:0",
    region: "ap-northeast-1",
  });
  const controller = new AbortController();

  await analyzer.analyze(image, { signal: controller.signal });

  assert.equal(fake.getAbortSignal(), controller.signal);
});

test("Bedrockの一時的なエラーをRetry可能として分類する", () => {
  for (const name of [
    "ThrottlingException",
    "ServiceUnavailableException",
    "InternalServerException",
    "ModelTimeoutException",
    "ModelNotReadyException",
    "ServiceQuotaExceededException",
  ]) {
    assert.equal(classifyBedrockError({ name }), "RETRYABLE", name);
  }
  assert.equal(
    classifyBedrockError({ name: "Error", code: "ETIMEDOUT" }),
    "RETRYABLE",
  );
});

test("Bedrockの入力不正や権限エラーをRetry不要として分類する", () => {
  for (const name of [
    "ValidationException",
    "AccessDeniedException",
    "ResourceNotFoundException",
    "AbortError",
  ]) {
    assert.equal(classifyBedrockError({ name }), "NON_RETRYABLE", name);
  }
});
