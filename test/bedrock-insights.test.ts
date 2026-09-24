import assert from "node:assert/strict";
import { test } from "node:test";
import type { DocumentType } from "@smithy/types";
import type {
  ConverseCommand,
  ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import {
  BedrockInsightsAnalyzer,
  INSIGHTS_TOOL_NAME,
  type BedrockInsightsClientLike,
} from "../src/ai/bedrock-insights.ts";
import type { CompactInsightsInput } from "../src/insights/monthly-insights.ts";

const input: CompactInsightsInput = {
  month: "2026-08",
  current: {
    totalAmount: 120000,
    transactionCount: 35,
    categories: [
      {
        name: "食費",
        amount: 45000,
        count: 12,
        percentage: 37.5,
        previousAmount: 36000,
        amountChangePercentage: 25,
      },
    ],
    merchants: [
      {
        name: "Amazon",
        amount: 28000,
        count: 5,
        percentage: 23.3,
        previousAmount: 18000,
        amountChangePercentage: 55.6,
      },
    ],
  },
  previous: {
    totalAmount: 100000,
    transactionCount: 30,
  },
};

function toolResponse(inputValue: unknown): ConverseCommandOutput {
  return {
    stopReason: "tool_use",
    output: {
      message: {
        role: "assistant",
        content: [
          {
            toolUse: {
              toolUseId: "tool-use-1",
              name: INSIGHTS_TOOL_NAME,
              input: inputValue as DocumentType,
            },
          },
        ],
      },
    },
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    },
    metrics: { latencyMs: 10 },
    $metadata: {},
  };
}

test("Insights adapterはcompact AnalyticsをTool Useへ渡して検証済み結果を返す", async () => {
  let command: ConverseCommand | undefined;
  const client: BedrockInsightsClientLike = {
    send: async (receivedCommand) => {
      command = receivedCommand;
      return toolResponse({
        insights: [
          {
            type: "CATEGORY_INCREASE",
            severity: "warning",
            title: "食費が増えています",
            description: "食費が前月から25%増加しています。",
            category: "食費",
          },
        ],
      });
    },
  };
  const analyzer = new BedrockInsightsAnalyzer({
    region: "ap-northeast-1",
    modelId: "insights-model",
    client,
  });

  const result = await analyzer.analyze(input);

  assert.deepEqual(result.insights, [
    {
      type: "CATEGORY_INCREASE",
      severity: "warning",
      title: "食費が増えています",
      description: "食費が前月から25%増加しています。",
      category: "食費",
    },
  ]);
  assert.deepEqual(result.usage, {
    inputTokens: 100,
    outputTokens: 50,
    totalTokens: 150,
  });
  assert.equal(command?.input.modelId, "insights-model");
  assert.equal(command?.input.toolConfig?.toolChoice?.tool?.name, INSIGHTS_TOOL_NAME);
  assert.equal(command?.input.messages?.[0]?.content?.some((block) => "image" in block), false);
});

test("Insights adapterは不正なTool入力を拒否する", async () => {
  const analyzer = new BedrockInsightsAnalyzer({
    region: "ap-northeast-1",
    modelId: "insights-model",
    client: {
      send: async () =>
        toolResponse({
          insights: [
            {
              type: "CATEGORY_INCREASE",
              severity: "warning",
              title: "不正",
              description: "入力にないカテゴリです。",
              category: "存在しないカテゴリ",
            },
          ],
        }),
    },
  });

  await assert.rejects(() => analyzer.analyze(input), {
    name: "InvalidInsightsResponseError",
  });
});

test("Insights adapterはAbortSignalをAWS SDKへ渡す", async () => {
  let receivedSignal: AbortSignal | undefined;
  const analyzer = new BedrockInsightsAnalyzer({
    region: "ap-northeast-1",
    modelId: "insights-model",
    client: {
      send: async (_command, options) => {
        receivedSignal = options?.abortSignal;
        return toolResponse({ insights: [] });
      },
    },
  });
  const controller = new AbortController();

  await analyzer.analyze(input, { signal: controller.signal });

  assert.equal(receivedSignal, controller.signal);
});
