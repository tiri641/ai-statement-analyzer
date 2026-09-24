import {
  buildMonthlyAnalytics,
  getMonthlyAnalyticsRanges,
  type MonthlyAnalyticsAggregates,
} from "../analytics/monthly-analytics.js";
import type {
  MonthlyInsightsCacheLookup,
  MonthlyInsightsCacheLockProvider,
  MonthlyInsightsCacheSession,
  MonthlyInsightsCacheRecord,
} from "../database/statement-repository.js";
import type {
  BedrockInsightsAnalyzer,
  InsightsAnalyzeOptions,
  InsightsAnalysisResult,
} from "../ai/bedrock-insights.js";
import { classifyBedrockError } from "../ai/bedrock-ocr.js";
import {
  createStructuredLogger,
  type StructuredLogger,
} from "../observability/logger.js";
import {
  createCompactInsightsInput,
  getAnalyticsFingerprint,
  InvalidInsightsResponseError,
  parseAndValidateInsights,
  type CompactInsightsInput,
  type InsightsDocument,
  type Insight,
} from "./monthly-insights.js";

export const MONTHLY_INSIGHTS_GENERATION_TIMEOUT_MILLIS = 30_000;

export interface MonthlyInsightsAnalyticsStore {
  findMonthlyAnalytics(
    ranges: ReturnType<typeof getMonthlyAnalyticsRanges>,
  ): Promise<MonthlyAnalyticsAggregates>;
}

export interface MonthlyInsightsCache
  extends MonthlyInsightsCacheSession,
    MonthlyInsightsCacheLockProvider {}

export interface MonthlyInsightsAnalyzer {
  analyze(
    input: CompactInsightsInput,
    options?: InsightsAnalyzeOptions,
  ): Promise<InsightsAnalysisResult>;
}

export interface MonthlyInsightsResponse {
  year: number;
  month: number;
  insights: Insight[];
  generatedAt: string;
  cached: boolean;
}

export interface MonthlyInsightsServiceOptions {
  analytics: MonthlyInsightsAnalyticsStore;
  cache: MonthlyInsightsCache;
  analyzer: MonthlyInsightsAnalyzer;
  modelId: string;
  promptVersion: string;
  now?: () => Date;
  logger?: StructuredLogger;
}

export class MonthlyInsightsService {
  private readonly analytics: MonthlyInsightsAnalyticsStore;
  private readonly cache: MonthlyInsightsCache;
  private readonly analyzer: MonthlyInsightsAnalyzer;
  private readonly modelId: string;
  private readonly promptVersion: string;
  private readonly now: () => Date;
  private readonly logger: StructuredLogger;

  public constructor(options: MonthlyInsightsServiceOptions) {
    this.analytics = options.analytics;
    this.cache = options.cache;
    this.analyzer = options.analyzer;
    this.modelId = options.modelId;
    this.promptVersion = options.promptVersion;
    this.now = options.now ?? (() => new Date());
    this.logger =
      options.logger ?? createStructuredLogger({ service: "api" });
  }

  public async getMonthlyInsights(
    year: number,
    month: number,
  ): Promise<MonthlyInsightsResponse> {
    const ranges = getMonthlyAnalyticsRanges(year, month);
    const aggregates = await this.analytics.findMonthlyAnalytics(ranges);
    const analytics = buildMonthlyAnalytics(
      year,
      month,
      aggregates.current,
      aggregates.previous,
    );
    const input = createCompactInsightsInput(analytics);
    const lookup: MonthlyInsightsCacheLookup = {
      targetMonth: ranges.current.start,
      analyticsVersion: getAnalyticsFingerprint(input),
      modelId: this.modelId,
      promptVersion: this.promptVersion,
    };
    const cachedResponse = this.getCachedResponse(
      year,
      month,
      input,
      await this.cache.findMonthlyInsights(lookup),
    );

    if (cachedResponse) {
      this.logger.info({
        event: "monthly_insights_cache_hit",
        status: "completed",
        targetMonth: lookup.targetMonth,
        modelId: this.modelId,
        promptVersion: this.promptVersion,
        cached: true,
      });
      return cachedResponse;
    }

    this.logger.info({
      event: "monthly_insights_cache_miss",
      status: "started",
      targetMonth: lookup.targetMonth,
      modelId: this.modelId,
      promptVersion: this.promptVersion,
      cached: false,
    });

    const lockKey = [lookup.targetMonth, lookup.modelId, lookup.promptVersion].join(
      ":",
    );

    return this.cache.withMonthlyInsightsGenerationLock(
      lockKey,
      async (lockedCache) => {
        const lockedCachedResponse = this.getCachedResponse(
          year,
          month,
          input,
          await lockedCache.findMonthlyInsights(lookup),
        );

        if (lockedCachedResponse) {
          this.logger.info({
            event: "monthly_insights_cache_hit",
            status: "completed",
            targetMonth: lookup.targetMonth,
            modelId: this.modelId,
            promptVersion: this.promptVersion,
            cached: true,
          });
          return lockedCachedResponse;
        }

        const bedrockStartedAt = Date.now();
        let generated: InsightsAnalysisResult;
        try {
          generated = await this.analyzer.analyze(input, {
            signal: AbortSignal.timeout(
              MONTHLY_INSIGHTS_GENERATION_TIMEOUT_MILLIS,
            ),
          });
        } catch (error) {
          if (error instanceof InvalidInsightsResponseError) {
            this.logger.error({
              event: "bedrock_response_invalid",
              status: "failed",
              stage: "insights",
              modelId: this.modelId,
              promptVersion: this.promptVersion,
              errorCode: "INVALID_INSIGHTS_RESPONSE",
              disposition: "PERMANENT",
              durationMs: Date.now() - bedrockStartedAt,
            });
          } else {
            this.logger.error({
              event: "bedrock_request_failed",
              status: "failed",
              stage: "insights",
              modelId: this.modelId,
              promptVersion: this.promptVersion,
              errorCode: getSafeErrorCode(error),
              disposition: classifyBedrockError(error),
              durationMs: Date.now() - bedrockStartedAt,
            });
          }
          throw error;
        }

        let validated: InsightsDocument;
        try {
          validated = parseAndValidateInsights(
            { insights: generated.insights },
            input,
          );
        } catch (error) {
          if (error instanceof InvalidInsightsResponseError) {
            this.logger.error({
              event: "bedrock_response_invalid",
              status: "failed",
              stage: "insights",
              modelId: this.modelId,
              promptVersion: this.promptVersion,
              errorCode: "INVALID_INSIGHTS_RESPONSE",
              disposition: "PERMANENT",
              durationMs: Date.now() - bedrockStartedAt,
            });
          }
          throw error;
        }
        const generatedAt = this.now();

        await lockedCache.saveMonthlyInsights({
          ...lookup,
          insights: validated,
          generatedAt,
        });

        return this.toResponse(year, month, validated, generatedAt, false);
      },
    );
  }

  private getCachedResponse(
    year: number,
    month: number,
    input: CompactInsightsInput,
    cached: MonthlyInsightsCacheRecord | null,
  ): MonthlyInsightsResponse | null {
    if (!cached) {
      return null;
    }

    try {
      const validated = parseAndValidateInsights(cached.insights, input);
      return this.toResponse(year, month, validated, cached.generatedAt, true);
    } catch (error) {
      if (!(error instanceof InvalidInsightsResponseError)) {
        throw error;
      }

      return null;
    }
  }

  private toResponse(
    year: number,
    month: number,
    document: InsightsDocument,
    generatedAt: Date,
    cached: boolean,
  ): MonthlyInsightsResponse {
    return {
      year,
      month,
      insights: document.insights,
      generatedAt: generatedAt.toISOString(),
      cached,
    };
  }
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
