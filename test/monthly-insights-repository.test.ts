import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import {
  MONTHLY_INSIGHTS_LOCK_WAIT_TIMEOUT_MILLIS,
  StatementRepository,
  type MonthlyInsightsCacheLookup,
  type SaveMonthlyInsightsInput,
} from "../src/database/statement-repository.ts";

const lookup: MonthlyInsightsCacheLookup = {
  targetMonth: "2026-08-01",
  analyticsVersion: "monthly-analytics-v1:hash",
  modelId: "insights-model",
  promptVersion: "v1",
};

const saveInput: SaveMonthlyInsightsInput = {
  ...lookup,
  insights: {
    insights: [
      {
        type: "NOTABLE_SPENDING",
        severity: "info",
        title: "注目支出",
        description: "食費の支出が目立ちます。",
        category: "食費",
      },
    ],
  },
  generatedAt: new Date("2026-09-01T03:00:00.000Z"),
};

class FakePool {
  public readonly queries: Array<{
    text: string;
    parameters: unknown[] | undefined;
    queryTimeout: number | undefined;
  }> = [];
  public releaseCount = 0;
  public releaseErrors: Error[] = [];
  public failRollback = false;

  public async query<T>(
    query: string | { text: string; values?: unknown[]; query_timeout?: number },
    parameters?: unknown[],
  ): Promise<{ rows: T[] }> {
    const text = typeof query === "string" ? query : query.text;
    const queryParameters = typeof query === "string" ? parameters : query.values;
    const queryTimeout = typeof query === "string" ? undefined : query.query_timeout;
    this.queries.push({
      text: text.replace(/\s+/g, " ").trim(),
      parameters: queryParameters,
      queryTimeout,
    });

    if (text === "ROLLBACK" && this.failRollback) {
      throw new Error("rollback failed");
    }

    if (text.includes("FROM monthly_insights")) {
      return {
        rows: [
          {
            target_month: "2026-08-01",
            analytics_version: lookup.analyticsVersion,
            model_id: lookup.modelId,
            prompt_version: lookup.promptVersion,
            insights: saveInput.insights,
            generated_at: saveInput.generatedAt,
          },
        ] as T[],
      };
    }

    return { rows: [] as T[] };
  }

  public async connect(): Promise<PoolClient> {
    return {
      query: this.query.bind(this),
      release: (error?: Error) => {
        this.releaseCount += 1;
        if (error) {
          this.releaseErrors.push(error);
        }
      },
    } as unknown as PoolClient;
  }
}

test("monthly_insights cacheは年月とversion条件が一致する行を取得する", async () => {
  const pool = new FakePool();
  const repository = new StatementRepository(pool as unknown as Pool);

  const result = await repository.findMonthlyInsights(lookup);

  assert.deepEqual(result, {
    ...lookup,
    insights: saveInput.insights,
    generatedAt: saveInput.generatedAt,
  });
  assert.deepEqual(pool.queries[0]?.parameters, [
    lookup.targetMonth,
    lookup.analyticsVersion,
    lookup.modelId,
    lookup.promptVersion,
  ]);
});

test("monthly_insights cacheは対象月をキーに検証済み結果をupsertする", async () => {
  const pool = new FakePool();
  const repository = new StatementRepository(pool as unknown as Pool);

  await repository.saveMonthlyInsights(saveInput);

  const query = pool.queries[0];
  assert.ok(query);
  assert.match(query.text, /INSERT INTO monthly_insights/);
  assert.match(query.text, /ON CONFLICT \(target_month\) DO UPDATE/);
  assert.deepEqual(query.parameters, [
    saveInput.targetMonth,
    saveInput.analyticsVersion,
    saveInput.modelId,
    saveInput.promptVersion,
    JSON.stringify(saveInput.insights),
    saveInput.generatedAt,
  ]);
});

test("monthly_insights生成ロックはトランザクション内で取得して解放する", async () => {
  const pool = new FakePool();
  const repository = new StatementRepository(pool as unknown as Pool);

  await repository.withMonthlyInsightsGenerationLock("2026-08-01:model:v1", async () =>
    "done",
  );

  assert.match(pool.queries[0]?.text ?? "", /^BEGIN$/);
  assert.match(pool.queries[1]?.text ?? "", /pg_advisory_xact_lock/);
  assert.equal(
    pool.queries[1]?.queryTimeout,
    MONTHLY_INSIGHTS_LOCK_WAIT_TIMEOUT_MILLIS,
  );
  assert.match(pool.queries[2]?.text ?? "", /^COMMIT$/);
  assert.equal(pool.releaseCount, 1);
});

test("monthly_insights生成失敗時はrollbackして接続を解放する", async () => {
  const pool = new FakePool();
  const repository = new StatementRepository(pool as unknown as Pool);
  const originalError = new Error("generation failed");

  await assert.rejects(
    repository.withMonthlyInsightsGenerationLock("2026-08-01:model:v1", async () => {
      throw originalError;
    }),
    (error) => error === originalError,
  );

  assert.match(pool.queries[2]?.text ?? "", /^ROLLBACK$/);
  assert.equal(pool.releaseCount, 1);
});

test("monthly_insightsのrollback失敗は元エラーと合わせて通知する", async () => {
  const pool = new FakePool();
  pool.failRollback = true;
  const repository = new StatementRepository(pool as unknown as Pool);

  await assert.rejects(
    repository.withMonthlyInsightsGenerationLock("2026-08-01:model:v1", async () => {
      throw new Error("generation failed");
    }),
    AggregateError,
  );

  assert.equal(pool.releaseCount, 1);
  assert.equal(pool.releaseErrors.length, 1);
});
