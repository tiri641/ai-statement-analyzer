import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandOutput,
  type ToolConfiguration,
  type ToolUseBlock,
} from "@aws-sdk/client-bedrock-runtime";
import {
  buildInsightsPrompt,
  InvalidInsightsResponseError,
  parseAndValidateInsights,
  type CompactInsightsInput,
  type InsightsDocument,
} from "../insights/monthly-insights.js";

const MAX_BEDROCK_ATTEMPTS = 3;

export const INSIGHTS_TOOL_NAME = "generate_spending_insights";

const INSIGHTS_SYSTEM_PROMPT = [
  "あなたはクレジットカード支出の説明文を生成するアシスタントです。",
  "与えられた集計値だけを根拠に、入力にない事実を推測しないでください。",
  "金額の再計算、金融助言、自動決済の提案、秘密情報の出力は禁止です。",
  "前月データがない場合は前月比較を生成しないでください。",
  "説明文は日本語で、指定されたToolを1回だけ呼び出してください。",
].join("\n");

const INSIGHTS_TOOL_CONFIG: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: INSIGHTS_TOOL_NAME,
        description: "月次支出Analyticsから安全なInsightsを生成する",
        inputSchema: {
          json: {
            type: "object",
            additionalProperties: false,
            properties: {
              insights: {
                type: "array",
                maxItems: 5,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    type: {
                      type: "string",
                      enum: [
                        "CATEGORY_INCREASE",
                        "MERCHANT_INCREASE",
                        "NOTABLE_SPENDING",
                      ],
                    },
                    severity: {
                      type: "string",
                      enum: ["info", "warning"],
                    },
                    title: { type: "string" },
                    description: { type: "string" },
                    category: { type: "string" },
                    merchant: { type: "string" },
                  },
                  required: ["type", "severity", "title", "description"],
                },
              },
            },
            required: ["insights"],
          },
        },
      },
    },
  ],
  toolChoice: {
    tool: { name: INSIGHTS_TOOL_NAME },
  },
};

export interface BedrockInsightsClientLike {
  send(
    command: ConverseCommand,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ConverseCommandOutput>;
}

export interface InsightsUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface BedrockInsightsAnalyzerOptions {
  region: string;
  modelId: string;
  client?: BedrockInsightsClientLike;
}

export interface InsightsAnalyzeOptions {
  signal?: AbortSignal;
}

export interface InsightsAnalysisResult extends InsightsDocument {
  usage: InsightsUsage | null;
}

export class BedrockInsightsAnalyzer {
  private readonly client: BedrockInsightsClientLike;
  private readonly modelId: string;

  public constructor(options: BedrockInsightsAnalyzerOptions) {
    this.client =
      options.client ??
      (new BedrockRuntimeClient({
        region: options.region,
        maxAttempts: MAX_BEDROCK_ATTEMPTS,
      }) as unknown as BedrockInsightsClientLike);
    this.modelId = options.modelId;
  }

  public async analyze(
    input: CompactInsightsInput,
    options: InsightsAnalyzeOptions = {},
  ): Promise<InsightsAnalysisResult> {
    const command = new ConverseCommand({
      modelId: this.modelId,
      system: [{ text: INSIGHTS_SYSTEM_PROMPT }],
      messages: [
        {
          role: "user",
          content: [{ text: buildInsightsPrompt(input) }],
        },
      ],
      inferenceConfig: {
        maxTokens: 2_000,
        temperature: 0.2,
      },
      toolConfig: INSIGHTS_TOOL_CONFIG,
    });
    const response = await this.client.send(
      command,
      options.signal ? { abortSignal: options.signal } : undefined,
    );
    const toolUse = getToolUse(response);
    const insights = parseAndValidateInsights(toolUse.input, input);

    return {
      ...insights,
      usage: response.usage
        ? {
            inputTokens: response.usage.inputTokens ?? 0,
            outputTokens: response.usage.outputTokens ?? 0,
            totalTokens: response.usage.totalTokens ?? 0,
          }
        : null,
    };
  }
}

function getToolUse(response: ConverseCommandOutput): ToolUseBlock {
  const content = response.output?.message?.content;

  if (response.stopReason !== "tool_use") {
    throw new InvalidInsightsResponseError(
      "Insights応答がTool Useで終了していません",
    );
  }

  if (!Array.isArray(content)) {
    throw new InvalidInsightsResponseError("Insights応答のcontentが不正です");
  }

  const toolUseBlocks = content.filter(isToolUseBlock);

  if (content.length !== 1 || toolUseBlocks.length !== 1) {
    throw new InvalidInsightsResponseError(
      "Insights応答のTool Use件数が不正です",
    );
  }

  const toolUse = toolUseBlocks[0]?.toolUse;

  if (!toolUse) {
    throw new InvalidInsightsResponseError("Insights応答にTool Useがありません");
  }

  if (toolUse.name !== INSIGHTS_TOOL_NAME) {
    throw new InvalidInsightsResponseError("Insights応答のTool名が不正です");
  }

  if (toolUse.input === undefined) {
    throw new InvalidInsightsResponseError("Insights応答のTool入力がありません");
  }

  return toolUse;
}

function isToolUseBlock(
  block: ContentBlock,
): block is ContentBlock.ToolUseMember {
  return typeof block === "object" && block !== null && "toolUse" in block;
}
