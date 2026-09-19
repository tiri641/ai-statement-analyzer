import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildMonthlyAnalytics,
  getMonthlyAnalyticsRanges,
  type MonthlyAnalyticsAggregate,
} from "../src/analytics/monthly-analytics.ts";

function createAggregate(
  overrides: Partial<MonthlyAnalyticsAggregate> = {},
): MonthlyAnalyticsAggregate {
  return {
    totalAmount: 126430,
    transactionCount: 47,
    categories: [
      { name: "食費", amount: 38200, count: 18 },
      { name: "買い物", amount: 88230, count: 29 },
    ],
    merchants: [
      { name: "Amazon", amount: 21400, count: 5 },
      { name: "スーパー", amount: 16800, count: 8 },
    ],
    ...overrides,
  };
}

test("月次Analyticsの対象範囲は月初以上・翌月月初未満になる", () => {
  assert.deepEqual(getMonthlyAnalyticsRanges(2026, 8), {
    current: {
      start: "2026-08-01",
      end: "2026-09-01",
    },
    previous: {
      start: "2026-07-01",
      end: "2026-08-01",
    },
  });
});

test("1月は前年12月を前月として扱う", () => {
  assert.deepEqual(getMonthlyAnalyticsRanges(2026, 1), {
    current: {
      start: "2026-01-01",
      end: "2026-02-01",
    },
    previous: {
      start: "2025-12-01",
      end: "2026-01-01",
    },
  });
});

test("閏年と非閏年の2月は3月1日を終端にする", () => {
  assert.deepEqual(getMonthlyAnalyticsRanges(2024, 2), {
    current: {
      start: "2024-02-01",
      end: "2024-03-01",
    },
    previous: {
      start: "2024-01-01",
      end: "2024-02-01",
    },
  });
  assert.deepEqual(getMonthlyAnalyticsRanges(2025, 2), {
    current: {
      start: "2025-02-01",
      end: "2025-03-01",
    },
    previous: {
      start: "2025-01-01",
      end: "2025-02-01",
    },
  });
});

test("Analyticsは割合と前月比を1桁へ丸める", () => {
  const result = buildMonthlyAnalytics(
    2026,
    8,
    createAggregate(),
    createAggregate({
      totalAmount: 110000,
      transactionCount: 42,
      categories: [{ name: "食費", amount: 25400, count: 12 }],
      merchants: [{ name: "Amazon", amount: 18000, count: 4 }],
    }),
  );

  assert.equal(result.totalAmount, 126430);
  assert.equal(result.transactionCount, 47);
  assert.deepEqual(result.previousMonth, {
    totalAmount: 110000,
    transactionCount: 42,
    amountChangePercentage: 14.9,
    transactionCountChangePercentage: 11.9,
  });
  assert.deepEqual(result.categories[0], {
    category: "買い物",
    amount: 88230,
    count: 29,
    percentage: 69.8,
    previousAmount: null,
    amountChangePercentage: null,
  });
  assert.deepEqual(result.categories[1], {
    category: "食費",
    amount: 38200,
    count: 18,
    percentage: 30.2,
    previousAmount: 25400,
    amountChangePercentage: 50.4,
  });
  assert.deepEqual(result.merchants[0], {
    merchant: "Amazon",
    amount: 21400,
    count: 5,
    percentage: 16.9,
    previousAmount: 18000,
    amountChangePercentage: 18.9,
  });
});

test("前月に取引がない場合はpreviousMonthをnullにする", () => {
  const result = buildMonthlyAnalytics(
    2026,
    8,
    createAggregate(),
    createAggregate({
      totalAmount: 0,
      transactionCount: 0,
      categories: [],
      merchants: [],
    }),
  );

  assert.equal(result.previousMonth, null);
});

test("純額が0円の場合は割合をnullにする", () => {
  const result = buildMonthlyAnalytics(
    2026,
    8,
    createAggregate({
      totalAmount: 0,
      transactionCount: 2,
      categories: [
        { name: "食費", amount: 1000, count: 1 },
        { name: "返金", amount: -1000, count: 1 },
      ],
      merchants: [],
    }),
    createAggregate({
      totalAmount: 0,
      transactionCount: 1,
      categories: [],
      merchants: [],
    }),
  );

  assert.equal(result.categories[0]?.percentage, null);
  assert.equal(result.previousMonth?.amountChangePercentage, null);
});

test("前月の金額が0円の場合は前月比だけnullにする", () => {
  const result = buildMonthlyAnalytics(
    2026,
    8,
    createAggregate(),
    createAggregate({
      totalAmount: 0,
      transactionCount: 2,
      categories: [{ name: "食費", amount: 0, count: 2 }],
      merchants: [],
    }),
  );

  assert.deepEqual(result.previousMonth, {
    totalAmount: 0,
    transactionCount: 2,
    amountChangePercentage: null,
    transactionCountChangePercentage: 2250,
  });
  assert.equal(result.categories[1]?.previousAmount, 0);
  assert.equal(result.categories[1]?.amountChangePercentage, null);
});
