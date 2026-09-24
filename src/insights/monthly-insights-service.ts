import {
  buildMonthlyAnalytics,
  getMonthlyAnalyticsRanges,
  type MonthlyAnalyticsAggregates,
} from "../analytics/monthly-analytics.js";
import type {
  MonthlyInsightsCacheLookup,
  MonthlyInsightsCacheRecord,
  SaveMonthlyInsightsInput,
} from "../database/statement-repository.js";
import type {
  BedrockInsightsAnalyzer,
  InsightsAnalysisResult,
} from "../ai/bedrock-insights.js";
import {
  createCompactInsightsInput,
  getAnalyticsFingerprint,
  InvalidInsightsResponseError,
  parseAndValidateInsights,
  type CompactInsightsInput,
  type InsightsDocument,
  type Insight,
} from "./monthly-insights.js";

export interface MonthlyInsightsAnalyticsStore {
  findMonthlyAnalytics(
    ranges: ReturnType<typeof getMonthlyAnalyticsRanges>,
  ): Promise<MonthlyAnalyticsAggregates>;
}

export interface MonthlyInsightsCache {
  findMonthlyInsights(
    lookup: MonthlyInsightsCacheLookup,
  ): Promise<MonthlyInsightsCacheRecord | null>;
  saveMonthlyInsights(input: SaveMonthlyInsightsInput): Promise<void>;
}

export interface MonthlyInsightsAnalyzer {
  analyze(
    input: CompactInsightsInput,
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
}

export class MonthlyInsightsService {
  private readonly analytics: MonthlyInsightsAnalyticsStore;
  private readonly cache: MonthlyInsightsCache;
  private readonly analyzer: MonthlyInsightsAnalyzer;
  private readonly modelId: string;
  private readonly promptVersion: string;
  private readonly now: () => Date;

  public constructor(options: MonthlyInsightsServiceOptions) {
    this.analytics = options.analytics;
    this.cache = options.cache;
    this.analyzer = options.analyzer;
    this.modelId = options.modelId;
    this.promptVersion = options.promptVersion;
    this.now = options.now ?? (() => new Date());
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
    const cached = await this.cache.findMonthlyInsights(lookup);

    if (cached) {
      try {
        const validated = parseAndValidateInsights(cached.insights, input);
        return this.toResponse(year, month, validated, cached.generatedAt, true);
      } catch (error) {
        if (!(error instanceof InvalidInsightsResponseError)) {
          throw error;
        }
      }
    }

    const generated = await this.analyzer.analyze(input);
    const validated = parseAndValidateInsights(
      { insights: generated.insights },
      input,
    );
    const generatedAt = this.now();

    await this.cache.saveMonthlyInsights({
      ...lookup,
      insights: validated,
      generatedAt,
    });

    return this.toResponse(year, month, validated, generatedAt, false);
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
