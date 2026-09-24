import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMonthlyAnalytics,
  type MonthlyAnalyticsAggregate,
} from "../src/analytics/monthly-analytics.ts";
import {
  buildInsightsPrompt,
  createCompactInsightsInput,
  getAnalyticsFingerprint,
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

function createAnalytics() {
  return buildMonthlyAnalytics(2026, 8, current, previous);
}

test("Insights用compact DTOはAnalyticsの確定値だけを含める", () => {
  const input = createCompactInsightsInput(createAnalytics());

  assert.deepEqual(input, {
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
  });

  assert.equal("merchantRaw" in input, false);
});

test("前月取引がない場合のcompact DTOはpreviousをnullにする", () => {
  const analytics = buildMonthlyAnalytics(2026, 8, current, {
    totalAmount: 0,
    transactionCount: 0,
    categories: [],
    merchants: [],
  });

  assert.deepEqual(createCompactInsightsInput(analytics).previous, null);
});

test("Analytics fingerprintは同じ入力で安定し、集計値の変更で変わる", () => {
  const input = createCompactInsightsInput(createAnalytics());
  const sameInput = createCompactInsightsInput(createAnalytics());
  const changedInput = {
    ...input,
    current: {
      ...input.current,
      totalAmount: input.current.totalAmount + 1,
    },
  };

  const fingerprint = getAnalyticsFingerprint(input);

  assert.equal(fingerprint, getAnalyticsFingerprint(sameInput));
  assert.notEqual(fingerprint, getAnalyticsFingerprint(changedInput));
  assert.match(fingerprint, /^monthly-analytics-v1:[a-f0-9]{64}$/);
});

test("Insights promptはcompact Analyticsと安全な生成ルールだけを含める", () => {
  const input = createCompactInsightsInput(createAnalytics());
  const prompt = buildInsightsPrompt(input);

  assert.match(prompt, /2026-08/);
  assert.match(prompt, /食費/);
  assert.match(prompt, /Amazon/);
  assert.match(prompt, /JSON/);
  assert.match(prompt, /入力にない事実を推測しない/);
  assert.equal(prompt.includes("merchantRaw"), false);
});
