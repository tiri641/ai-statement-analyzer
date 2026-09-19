import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { getMonthlyAnalyticsRanges } from "../src/analytics/monthly-analytics.ts";
import { StatementRepository } from "../src/database/statement-repository.ts";

class FakeAnalyticsClient {
  public readonly queries: string[] = [];

  public async query<T>(
    text: string,
    _parameters?: unknown[],
  ): Promise<{ rows: T[] }> {
    const normalized = text.replace(/\s+/g, " ").trim();
    this.queries.push(normalized);

    if (normalized.includes("GROUP BY t.category")) {
      return {
        rows: [{ name: "食費", amount: "100", count: "2" }] as T[],
      };
    }

    if (normalized.includes("GROUP BY t.merchant_name")) {
      return {
        rows: [{ name: "スーパー", amount: "100", count: "2" }] as T[],
      };
    }

    if (normalized.includes("COALESCE(SUM")) {
      return {
        rows: [{ total_amount: "100", transaction_count: "2" }] as T[],
      };
    }

    return { rows: [] as T[] };
  }

  public release(): void {}
}

test("月次Analyticsは同じREPEATABLE READ Transactionで全クエリを実行する", async () => {
  const client = new FakeAnalyticsClient();
  const repository = new StatementRepository({
    connect: async () => client,
  } as unknown as Pool);

  const result = await repository.findMonthlyAnalytics(
    getMonthlyAnalyticsRanges(2026, 8),
  );

  assert.equal(result.current.totalAmount, 100);
  assert.equal(result.previous.transactionCount, 2);
  assert.equal(client.queries[0], "BEGIN ISOLATION LEVEL REPEATABLE READ");
  assert.equal(client.queries.at(-1), "COMMIT");
  assert.equal(
    client.queries.filter((query) => query.startsWith("SELECT")).length,
    6,
  );
});
