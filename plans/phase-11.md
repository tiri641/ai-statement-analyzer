# Phase 11: AI Spending Insights 実装Plan

Status: 実装・動作確認完了。

## 目的

Phase 10の月次AnalyticsをBedrockへ渡し、支出傾向を自然言語で説明するInsights APIを追加する。

```text
GET /analytics/monthly/insights?year=YYYY&month=M
```

PostgreSQLで確定した集計値を数値の正本とし、Bedrockは解釈と説明文の生成だけを担当する。生成済みの検証済み結果はPostgreSQLの`monthly_insights`へcacheする。

## 対象範囲

- compact Analytics DTOの生成
- Analytics DTOのSHA-256 fingerprintによるcache invalidation
- `CATEGORY_INCREASE`、`MERCHANT_INCREASE`、`NOTABLE_SPENDING`の3種類のInsights
- Bedrock Converse Tool Useによる構造化出力
- ZodとAnalytics参照による出力Validation
- `monthly_insights` migration、取得、対象月単位のupsert
- cache hit / missを扱う同期GET API
- Bedrock failure、invalid output、前月なしの安全な挙動
- PostgreSQL advisory lockによる同時cache missの重複生成防止

対象外:

- Frontendと認証、`owner_id`絞り込み
- InsightsのSQS非同期化
- 複数リージョン・複数DBをまたぐ分散ロック
- ECS、RDS、VPCなどのProduction deploy
- Observability基盤の拡張

## Cache設計

`monthly_insights`は対象月ごとに現在有効な1行を保持する。

```text
target_month       date PRIMARY KEY
analytics_version  text NOT NULL
model_id           text NOT NULL
prompt_version     text NOT NULL
insights           jsonb NOT NULL
generated_at       timestamptz NOT NULL
```

`analytics_version`は`monthly-analytics-v1:<SHA-256>`とする。SHA-256の入力は順序を正規化したcompact Analytics DTOであり、新しい取引や集計値の変更でcache missになる。集計ルールやDTO構造を変更した場合は`monthly-analytics-v2`へ上げる。

cacheは対象月、Analytics version、Bedrock model、prompt versionがすべて一致した場合だけ返す。不一致時はBedrock生成後に同じ対象月の行をupsertする。古いInsightsをfallbackとして返さない。同一対象月・モデル・prompt versionのcache missは、PostgreSQLのtransaction-level advisory lockを取得してからcacheを再確認するため、複数API taskが同時に来てもBedrock生成を1回に直列化する。

## AI入力・出力

Bedrockへ渡すのは、対象月、現月・前月の合計と件数、カテゴリ別・merchant別の金額、件数、割合、前月比だけである。画像、全取引明細、`merchantRaw`、DB credentials、秘密情報は渡さない。

AI出力は次のtypeだけを許可する。

- `CATEGORY_INCREASE`
- `MERCHANT_INCREASE`
- `NOTABLE_SPENDING`

`severity`は`info`または`warning`、Insightsは最大5件、titleは80文字以内、descriptionは300文字以内とする。categoryまたはmerchantは入力Analyticsに存在する値だけを許可する。前月がない場合、増加系typeは拒否する。

BedrockのTool Use入力をZodで検証し、さらにAnalyticsとの参照整合性を確認する。検証前の出力はcacheやAPI Responseへ保存しない。

## API動作

1. 年月、未知Query Parameter、Query Parameter重複をValidationする。
2. `REPEATABLE READ`で取得済みの月次Analyticsからcompact DTOを作る。
3. cacheを検索する。
4. 条件一致した検証済みcacheは`cached: true`で返し、Bedrockを呼ばない。
5. cache miss時は対象月・モデル・prompt version単位のadvisory lockを取得し、cacheを再確認する。
6. lock取得後もcacheがなければpromptを作り、Bedrockへ送る。
7. 応答をZodとポリシーで検証し、成功した結果だけcacheへ保存する。
8. 新規生成結果は`cached: false`で返し、後続の待機リクエストは`cached: true`で返す。

Bedrock、cache、Analyticsの障害やAI応答不正は`503 INSIGHTS_UNAVAILABLE`とする。数値Analytics APIはInsights障害の影響を受けない。

Runtime設定:

- `BEDROCK_INSIGHTS_MODEL_ID`: Insights用Bedrockモデル。未設定時はAPIを起動不能にせず、Insights Endpointだけ503とする。
- `INSIGHTS_PROMPT_VERSION`: prompt識別子。未設定時は`v1`を使用する。

## TDDと検証

Red → Green → Refactorで次を確認する。

- compact DTO、fingerprint、promptが安定し、raw明細や画像を含まない
- Insights schema、type allowlist、文字数、前月なし、参照整合性をValidationする
- Bedrock Tool Useの強制選択、画像なし入力、invalid response、AbortSignalを確認する
- cache hitでBedrockを呼ばない
- cache miss、fingerprint/model/prompt version不一致で生成・upsertする
- 同時cache missをadvisory lockで直列化し、Bedrock生成が1回になることを確認する
- PostgreSQL migration、cache取得、upsert、制約を確認する
- APIの正常系、400、503、秘密情報非漏洩を確認する

完了Gate:

```bash
DATABASE_URL=postgres://app:local_dev_password@127.0.0.1:5432/statement_analyzer_test npm test
npm run typecheck
npm run typecheck:infra
npm run build
npm run cdk:synth
git diff --check
```
