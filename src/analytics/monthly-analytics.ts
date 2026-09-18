export interface AnalyticsDateRange {
  start: string;
  end: string;
}

export interface MonthlyAnalyticsRanges {
  current: AnalyticsDateRange;
  previous: AnalyticsDateRange;
}

export interface AnalyticsAggregateBucket {
  name: string;
  amount: number;
  count: number;
}

export interface MonthlyAnalyticsAggregate {
  totalAmount: number;
  transactionCount: number;
  categories: AnalyticsAggregateBucket[];
  merchants: AnalyticsAggregateBucket[];
}

export interface MonthlyAnalyticsAggregates {
  current: MonthlyAnalyticsAggregate;
  previous: MonthlyAnalyticsAggregate;
}

export interface MonthlyAnalyticsResponse {
  year: number;
  month: number;
  totalAmount: number;
  transactionCount: number;
  previousMonth: {
    totalAmount: number;
    transactionCount: number;
    amountChangePercentage: number | null;
    transactionCountChangePercentage: number | null;
  } | null;
  categories: Array<{
    category: string;
    amount: number;
    count: number;
    percentage: number | null;
    previousAmount: number | null;
    amountChangePercentage: number | null;
  }>;
  merchants: Array<{
    merchant: string;
    amount: number;
    count: number;
    percentage: number | null;
    previousAmount: number | null;
    amountChangePercentage: number | null;
  }>;
}

function formatMonthStart(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function shiftMonth(year: number, month: number, offset: number) {
  const monthIndex = year * 12 + month - 1 + offset;
  return {
    year: Math.floor(monthIndex / 12),
    month: (monthIndex % 12) + 1,
  };
}

export function getMonthlyAnalyticsRanges(
  year: number,
  month: number,
): MonthlyAnalyticsRanges {
  if (
    !Number.isInteger(year) ||
    year < 1 ||
    !Number.isInteger(month) ||
    month < 1 ||
    month > 12
  ) {
    throw new Error("invalid analytics month");
  }

  const next = shiftMonth(year, month, 1);
  const previous = shiftMonth(year, month, -1);

  return {
    current: {
      start: formatMonthStart(year, month),
      end: formatMonthStart(next.year, next.month),
    },
    previous: {
      start: formatMonthStart(previous.year, previous.month),
      end: formatMonthStart(year, month),
    },
  };
}

function roundToOneDecimal(value: number): number {
  return Number(value.toFixed(1));
}

function percentage(amount: number, totalAmount: number): number | null {
  if (totalAmount === 0) {
    return null;
  }

  return roundToOneDecimal((amount / totalAmount) * 100);
}

function changePercentage(current: number, previous: number): number | null {
  if (previous === 0) {
    return null;
  }

  return roundToOneDecimal(((current - previous) / Math.abs(previous)) * 100);
}

function compareBuckets(
  left: AnalyticsAggregateBucket,
  right: AnalyticsAggregateBucket,
): number {
  if (left.amount !== right.amount) {
    return right.amount - left.amount;
  }

  if (left.name === right.name) {
    return 0;
  }

  return left.name < right.name ? -1 : 1;
}

function buildCategoryResponse(
  current: MonthlyAnalyticsAggregate,
  previous: MonthlyAnalyticsAggregate,
) {
  const previousByName = new Map(
    previous.categories.map((bucket) => [bucket.name, bucket]),
  );

  return [...current.categories].sort(compareBuckets).map((bucket) => {
    const previousBucket = previousByName.get(bucket.name);

    return {
      category: bucket.name,
      amount: bucket.amount,
      count: bucket.count,
      percentage: percentage(bucket.amount, current.totalAmount),
      previousAmount: previousBucket?.amount ?? null,
      amountChangePercentage:
        previousBucket === undefined
          ? null
          : changePercentage(bucket.amount, previousBucket.amount),
    };
  });
}

function buildMerchantResponse(
  current: MonthlyAnalyticsAggregate,
  previous: MonthlyAnalyticsAggregate,
) {
  const previousByName = new Map(
    previous.merchants.map((bucket) => [bucket.name, bucket]),
  );

  return [...current.merchants].sort(compareBuckets).map((bucket) => {
    const previousBucket = previousByName.get(bucket.name);

    return {
      merchant: bucket.name,
      amount: bucket.amount,
      count: bucket.count,
      percentage: percentage(bucket.amount, current.totalAmount),
      previousAmount: previousBucket?.amount ?? null,
      amountChangePercentage:
        previousBucket === undefined
          ? null
          : changePercentage(bucket.amount, previousBucket.amount),
    };
  });
}

export function buildMonthlyAnalytics(
  year: number,
  month: number,
  current: MonthlyAnalyticsAggregate,
  previous: MonthlyAnalyticsAggregate,
): MonthlyAnalyticsResponse {
  const previousMonth =
    previous.transactionCount === 0
      ? null
      : {
          totalAmount: previous.totalAmount,
          transactionCount: previous.transactionCount,
          amountChangePercentage: changePercentage(
            current.totalAmount,
            previous.totalAmount,
          ),
          transactionCountChangePercentage: changePercentage(
            current.transactionCount,
            previous.transactionCount,
          ),
        };

  return {
    year,
    month,
    totalAmount: current.totalAmount,
    transactionCount: current.transactionCount,
    previousMonth,
    categories: buildCategoryResponse(current, previous),
    merchants: buildMerchantResponse(current, previous),
  };
}
