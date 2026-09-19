# Phase 10: Monthly Analytics 実装Plan

## 目的

`COMPLETED`済みstatementの`transactions`をPostgreSQLから集計し、年月ごとの支出状況をAPIで取得できるようにする。

クライアントから集計対象データや合計金額は受け取らない。Phase 8・9のWorkerがOCR結果を`transactions`へ保存した後、Analytics APIがDBを正として集計する。

## 対象範囲

実装するのは次のEndpointだけである。

```text
GET /analytics/monthly?year=YYYY&month=M
```

Request Body、画像、取引配列、合計金額は受け取らない。`GET /transactions`、Bedrock Insights、cache、Frontend、認証、owner_id絞り込みは後続Phaseとする。

## データフローと集計境界

```text
画像アップロード
  -> SQS解析ジョブ
  -> WorkerがBedrock OCR
  -> transactionsへ保存
  -> statementsをCOMPLETEDへ更新
  -> Analytics APIがPostgreSQLを集計
```

- `transactions.transaction_date`を対象月判定に使用する。
- 対象月は`[month_start, next_month_start)`の半開区間とする。
- `statements.status = 'COMPLETED'`のstatementに属する取引だけを対象にする。
- SQLで`SUM(amount)`、`COUNT(*)`、カテゴリ別・merchant別`GROUP BY`を行う。
- 割合、前月比、小数1桁への丸めはBackendで行う。
- 金額は既存方針どおり、支出を正数、返金を負数として扱う。
- percentageは純額の`totalAmount`を分母にする。分母が0の場合は`null`にする。
- 前月に取引がない場合は`previousMonth: null`とする。
- 前月に取引があっても合計額が0円の場合、前月の総額・件数は返し、前月比だけ`null`にする。
- 現月に存在するカテゴリ・merchantに前月データがない場合、`previousAmount`と前月比は`null`にする。
- 集計行は金額降順、同額の場合は名称昇順で安定させる。
- 現月・前月の総額、カテゴリ、merchantは`REPEATABLE READ`の同一Transaction内で取得し、集計結果のスナップショットをそろえる。

## 実装対象

- Analytics用の年月Validationと月範囲生成を追加する。
- Repositoryに、現月・前月の総額、件数、カテゴリ、merchant集計を取得するparameterized SQLを追加する。
- Analyticsのraw aggregateからAPI DTOを組み立てる純粋な計算モジュールを追加する。
- `createApp`へAnalytics用の依存境界を追加し、`StatementRepository`を接続する。
- DB障害時は内部エラーを公開せず、既存API方針に合わせて503を返す。
- Phase 10では新しいmigrationは追加しない。既存の`transactions`、`statements`、Indexを利用する。

## TDDと検証

1. Red
   - 月境界、年またぎ、閏年の月範囲をテストする。
   - 純額、件数、カテゴリ、merchant、返金、0件、初月、前月0円、0除算をテストする。
   - `COMPLETED`以外のstatementを除外するDatabase Integration Testを追加する。
   - Analytics Repositoryが`REPEATABLE READ`の同一Clientを使うことをテストする。
   - APIの正常系、年月Validation、DB障害503をテストする。
   - 未知のQuery Parameterと同名Parameterの重複を400で拒否する。
2. Green
   - 純粋な月範囲・割合・前月比計算を実装する。
   - Repository SQL、API Route、依存性注入、server wiringを実装する。
3. Refactor
   - Analytics DTOとaggregate型を整理する。
   - PostgreSQLのnumeric/string結果を安全に整数へ変換する。
   - API設計、Analytics docs、学習記録を更新する。

Integration Testは専用テストDBへデータを登録して実行し、Analytics APIのRequestから取引データを渡す方式にはしない。

## 完了条件

- `GET /analytics/monthly`が指定年月の正確な集計を返す。
- SQLの結果とAPIの金額・件数・割合・前月比が一致する。
- 返金を含む純額集計が確認できる。
- 0件、初月、前月0円、月境界がテストされる。
- `COMPLETED`以外のstatementの取引が集計されない。
- 集計クエリは同一`REPEATABLE READ`スナップショットから返る。
- `npm test`、`npm run typecheck`、`npm run typecheck:infra`、`npm run build`、`npm run cdk:synth`、`git diff --check`が成功する。
