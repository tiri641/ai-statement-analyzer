import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  MonthlyAnalyticsAggregate,
  MonthlyAnalyticsAggregates,
} from "../src/analytics/monthly-analytics.ts";
import type {
  MonthlyInsightsCacheLookup,
  MonthlyInsightsCacheRecord,
  SaveMonthlyInsightsInput,
} from "../src/database/statement-repository.ts";
import {
  MonthlyInsightsService,
  type MonthlyInsightsAnalyzer,
} from "../src/insights/monthly-insights-service.ts";
import type {
  CompactInsightsInput,
  InsightsDocument,
} from "../src/insights/monthly-insights.ts";

const current: MonthlyAnalyticsAggregate = {
  totalAmount: 120000,
  transactionCount: 35,
  categories: [{ name: "食費", amount: 45000, count: 12 }],
  merchants: [{ name: "Amazon", amount: 28000, count: 5 }],
};

const previous: MonthlyAnalyticsAggregate = {
  totalAmount: 100000,
  transactionCount: 30,
  categories: [{ name: "食費", amount: 36000, count: 10 }],
  merchants: [{ name: "Amazon", amount: 18000, count: 3 }],
};

const document: InsightsDocument = {
  insights: [
    {
      type: "CATEGORY_INCREASE",
      severity: "warning",
      title: "食費が増えています",
      description: "食費が前月から25%増加しています。",
      category: "食費",
    },
  ],
};

class FakeCache {
  public lookup: MonthlyInsightsCacheRecord | null = null;
  public saved: SaveMonthlyInsightsInput[] = [];

  public async findMonthlyInsights(
    _lookup: MonthlyInsightsCacheLookup,
  ): Promise<MonthlyInsightsCacheRecord | null> {
    return this.lookup;
  }

  public async saveMonthlyInsights(input: SaveMonthlyInsightsInput): Promise<void> {
    this.saved.push(input);
  }

  public async withMonthlyInsightsGenerationLock<T>(
    _lockKey: string,
    callback: (cache: FakeCache) => Promise<T>,
  ): Promise<T> {
    return callback(this);
  }
}

function createService(options: {
  cache: FakeCache;
  analyzer: MonthlyInsightsAnalyzer;
  aggregates?: MonthlyAnalyticsAggregates;
}) {
  return new MonthlyInsightsService({
    analytics: {
      findMonthlyAnalytics: async () =>
        options.aggregates ?? { current, previous },
    },
    cache: options.cache,
    analyzer: options.analyzer,
    modelId: "insights-model",
    promptVersion: "v1",
    now: () => new Date("2026-09-25T03:00:00.000Z"),
  });
}

test("cache hit時はBedrockを呼ばず、保存済みInsightsを返す", async () => {
  let analyzeCalled = false;
  const cache = new FakeCache();
  const analyzer: MonthlyInsightsAnalyzer = {
    analyze: async () => {
      analyzeCalled = true;
      return { ...document, usage: null };
    },
  };
  const service = createService({ cache, analyzer });

  const generatedAt = new Date("2026-09-01T03:00:00.000Z");
  cache.lookup = {
    targetMonth: "2026-08-01",
    analyticsVersion: "monthly-analytics-v1:hash",
    modelId: "insights-model",
    promptVersion: "v1",
    insights: document,
    generatedAt,
  };

  const result = await service.getMonthlyInsights(2026, 8);

  assert.equal(analyzeCalled, false);
  assert.equal(result.cached, true);
  assert.equal(result.generatedAt, generatedAt.toISOString());
  assert.deepEqual(result.insights, document.insights);
  assert.equal(cache.saved.length, 0);
});

test("cache miss時はBedrock生成結果を保存して返す", async () => {
  let receivedInput: CompactInsightsInput | undefined;
  const cache = new FakeCache();
  const analyzer: MonthlyInsightsAnalyzer = {
    analyze: async (input) => {
      receivedInput = input;
      return { ...document, usage: null };
    },
  };
  const service = createService({ cache, analyzer });

  const result = await service.getMonthlyInsights(2026, 8);

  assert.equal(receivedInput?.month, "2026-08");
  assert.equal(result.cached, false);
  assert.equal(result.generatedAt, "2026-09-25T03:00:00.000Z");
  assert.deepEqual(result.insights, document.insights);
  assert.equal(cache.saved.length, 1);
  assert.equal(cache.saved[0]?.targetMonth, "2026-08-01");
  assert.equal(cache.saved[0]?.modelId, "insights-model");
});

test("無効なcacheは返さず、Bedrockで再生成する", async () => {
  let analyzeCalled = false;
  const cache = new FakeCache();
  cache.lookup = {
    targetMonth: "2026-08-01",
    analyticsVersion: "monthly-analytics-v1:hash",
    modelId: "insights-model",
    promptVersion: "v1",
    insights: { insights: [{ type: "UNKNOWN" }] },
    generatedAt: new Date("2026-09-01T03:00:00.000Z"),
  };
  const analyzer: MonthlyInsightsAnalyzer = {
    analyze: async () => {
      analyzeCalled = true;
      return { ...document, usage: null };
    },
  };
  const service = createService({ cache, analyzer });

  const result = await service.getMonthlyInsights(2026, 8);

  assert.equal(analyzeCalled, true);
  assert.equal(result.cached, false);
  assert.equal(cache.saved.length, 1);
});

test("前月なしのAnalyticsをBedrockへ渡す", async () => {
  let receivedInput: CompactInsightsInput | undefined;
  const cache = new FakeCache();
  const analyzer: MonthlyInsightsAnalyzer = {
    analyze: async (input) => {
      receivedInput = input;
      return {
        insights: [
          {
            type: "NOTABLE_SPENDING",
            severity: "info",
            title: "注目支出",
            description: "食費の支出が目立ちます。",
            category: "食費",
          },
        ],
        usage: null,
      };
    },
  };
  const service = createService({
    cache,
    analyzer,
    aggregates: {
      current,
      previous: {
        totalAmount: 0,
        transactionCount: 0,
        categories: [],
        merchants: [],
      },
    },
  });

  await service.getMonthlyInsights(2026, 8);

  assert.equal(receivedInput?.previous, null);
});
