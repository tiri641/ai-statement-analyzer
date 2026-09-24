import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMonthlyAnalytics,
  type MonthlyAnalyticsAggregate,
} from "../src/analytics/monthly-analytics.ts";
import {
  parseAndValidateInsights,
  type CompactInsightsInput,
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

const input = (() => {
  const analytics = buildMonthlyAnalytics(2026, 8, current, previous);
  return {
    month: "2026-08",
    current: {
      totalAmount: analytics.totalAmount,
      transactionCount: analytics.transactionCount,
      categories: analytics.categories.map((bucket) => ({
        name: bucket.category,
        amount: bucket.amount,
        count: bucket.count,
        percentage: bucket.percentage,
        previousAmount: bucket.previousAmount,
        amountChangePercentage: bucket.amountChangePercentage,
      })),
      merchants: analytics.merchants.map((bucket) => ({
        name: bucket.merchant,
        amount: bucket.amount,
        count: bucket.count,
        percentage: bucket.percentage,
        previousAmount: bucket.previousAmount,
        amountChangePercentage: bucket.amountChangePercentage,
      })),
    },
    previous: {
      totalAmount: analytics.previousMonth?.totalAmount ?? 0,
      transactionCount: analytics.previousMonth?.transactionCount ?? 0,
    },
  } satisfies CompactInsightsInput;
})();

test("Insights schemaは許可された3種類の結果を受け入れる", () => {
  const result = parseAndValidateInsights(
    {
      insights: [
        {
          type: "CATEGORY_INCREASE",
          severity: "warning",
          title: "食費が前月より増えています",
          description: "食費が前月から25%増加しています。",
          category: "食費",
        },
        {
          type: "MERCHANT_INCREASE",
          severity: "info",
          title: "Amazonの支出が増えています",
          description: "Amazonの支出が前月から増加しています。",
          merchant: "Amazon",
        },
        {
          type: "NOTABLE_SPENDING",
          severity: "info",
          title: "今月の注目支出",
          description: "食費の支出が目立ちます。",
          category: "食費",
        },
      ],
    },
    input,
  );

  assert.equal(result.insights.length, 3);
});

test("Insights schemaは未知のtypeと不正な対象を拒否する", () => {
  assert.throws(() =>
    parseAndValidateInsights(
      {
        insights: [
          {
            type: "ARBITRARY_ADVICE",
            severity: "info",
            title: "不正",
            description: "不正なtypeです。",
            category: "食費",
          },
        ],
      },
      input,
    ),
  );

  assert.throws(() =>
    parseAndValidateInsights(
      {
        insights: [
          {
            type: "CATEGORY_INCREASE",
            severity: "warning",
            title: "未知のカテゴリ",
            description: "入力にないカテゴリです。",
            category: "存在しないカテゴリ",
          },
        ],
      },
      input,
    ),
  );
});

test("前月がない場合は増加系Insightsを拒否する", () => {
  const firstMonthInput = {
    ...input,
    previous: null,
    current: {
      ...input.current,
      categories: input.current.categories.map((category) => ({
        ...category,
        previousAmount: null,
        amountChangePercentage: null,
      })),
      merchants: input.current.merchants.map((merchant) => ({
        ...merchant,
        previousAmount: null,
        amountChangePercentage: null,
      })),
    },
  } satisfies CompactInsightsInput;

  assert.throws(() =>
    parseAndValidateInsights(
      {
        insights: [
          {
            type: "CATEGORY_INCREASE",
            severity: "warning",
            title: "比較できない増加",
            description: "前月がありません。",
            category: "食費",
          },
        ],
      },
      firstMonthInput,
    ),
  );
});
