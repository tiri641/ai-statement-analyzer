# Phase 11: AI Spending Insights

Status: 実装・動作確認完了。

Phase 10のPostgreSQL月次Analyticsをcompact DTOへ変換し、Bedrockで自然言語の支出Insightsを生成する同期APIを追加する。Bedrockへは確定済みの集計値だけを渡し、検証済みの結果をPostgreSQLの`monthly_insights`へcacheする。

## 学習ポイント

- 数値計算をSQLへ残し、LLMには解釈だけを担当させる理由
- prompt inputを集計値へ限定するデータ最小化
- Converse Tool UseとZodによる二重の構造化境界
- Analytics fingerprint、model ID、prompt versionによるcache invalidation
- cache hitでBedrock料金とレイテンシーを削減する方法
- AI failure時も数値Analyticsを表示できるEndpoint分離

## Phase完了時に追記する内容

- 実装したAPI、schema、migration、cache動作
- TDD、PostgreSQL integration、typecheck、build、synthの実行結果
- Bedrock failure、invalid output、前月なしの確認結果
- Security、Cost、既知の重複生成リスク
- Insightsが金融助言ではなく支出データの説明であること

## 実装結果

`GET /analytics/monthly/insights?year=YYYY&month=M`を追加した。APIはPhase 10の月次Analyticsをcompact DTOへ変換し、SHA-256 fingerprint、Bedrock model ID、prompt versionが一致する`monthly_insights` cacheだけを再利用する。対象月ごとに1行を保持し、cache missではBedrock Tool Useで新しいInsightsを生成して、ZodとAnalytics参照検証に成功した結果だけをupsertする。

Insights typeは`CATEGORY_INCREASE`、`MERCHANT_INCREASE`、`NOTABLE_SPENDING`に限定した。前月がない場合は増加系typeを拒否し、Bedrock・cache・Analytics障害や不正応答は`503 INSIGHTS_UNAVAILABLE`とする。数値Analytics APIはInsights障害から分離した。

## Security / Cost

Bedrockへは合計、件数、カテゴリ、merchant、前月比などの確定済み集計値だけを渡し、画像、全取引明細、`merchantRaw`、DB credentials、秘密情報は渡さない。AI出力はそのまま公開せず、Tool schema、Zod、Analytics参照検証を通過した結果だけを返す。Insightsは金融助言や自動決済ではなく、支出データの説明である。

cache hitではBedrockを呼ばないため、同じ集計結果への再生成コストとレイテンシーを削減できる。複数API taskの同時cache missでは重複Bedrock生成が起こり得るが、対象月upsertの整合性は保つ。分散ロックは後続Phaseの検討事項とした。

## 動作確認

```bash
DATABASE_URL=postgres://app:local_dev_password@127.0.0.1:5432/statement_analyzer_test npm test
npm run typecheck
npm run typecheck:infra
npm run build
npm run cdk:synth
git diff --check
```

結果は、PostgreSQL統合を含む175件成功、失敗0件、skip 0件、型チェック成功、infra typecheck成功、build成功、CDK synth成功、diff check成功だった。実AWS Bedrock呼び出しは行っていない。
