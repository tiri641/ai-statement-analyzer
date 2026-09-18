# Phase 10: Monthly Analytics

Status: 実装・動作確認完了。

## 作ったもの

`GET /analytics/monthly?year=YYYY&month=M`を追加した。Request Bodyは持たず、Clientから画像、取引配列、合計金額を受け取らない。Phase 8・9のWorkerがOCR結果を`transactions`へ保存し、statementを`COMPLETED`にした後、APIがPostgreSQLを正として集計する。

```text
Worker
  -> transactionsへOCR結果を保存
  -> statementsをCOMPLETEDへ更新
  -> GET /analytics/monthly?year=2026&month=8
  -> PostgreSQLのSUM / COUNT / GROUP BY
  -> Backendで割合・前月比を計算
  -> Dashboard向けDTO
```

対象月は`[month_start, next_month_start)`の半開区間で、`COMPLETED` statementに属するtransactionsだけを対象にする。支出は正数、返金は負数として`SUM(amount)`へ含める。

## 重要な設計判断

- SQLは総額、件数、カテゴリ別、merchant別の集計を担当する。
- Backendはpercentage、前月比、小数1桁への丸めを担当する。
- 前月比は`(current - previous) / abs(previous) * 100`で計算し、前月が0円の場合はnullにする。
- 純額が0円の場合、percentageはnullにする。
- 前月に取引がない場合、`previousMonth`はnullにする。
- 前月の金額が0円の場合、前月の総額・件数は返し、前月比だけnullにする。
- 現月にだけ存在するカテゴリ・merchantの前月金額と前月比はnullにする。
- 集計結果は金額降順、同額の場合は名称昇順で返す。
- DB障害の詳細やSQLエラーをAPIレスポンスへ出さず、503を返す。
- 新しいmigrationやBedrock呼び出しは追加していない。

## Security / Cost

Clientから金額を受け取らないため、Clientが送信した値を信頼してDashboardへ表示する経路を作っていない。OCR結果をWorkerがDBへ保存し、DBの状態と制約を通過したデータだけをSQLで集計する。認証と`owner_id`による絞り込みは、認証導入Phaseで全Analytics queryへ追加する。

集計はPostgreSQL内で完結し、Phase 10ではBedrock呼び出し費用を追加しない。カテゴリ・merchantの集計をDBで行うことで、全取引行をBackendやLLMへ送るデータ転送とAI料金を避ける。

## 動作確認

専用のローカルPostgreSQLデータベースを使用して、次のコマンドを実行した。

```bash
DATABASE_URL=postgres://app:local_dev_password@127.0.0.1:5432/statement_analyzer_test npm test
npm run typecheck
npm run typecheck:infra
npm run build
npm run cdk:synth
git diff --check
```

`npm test`は153件成功、失敗0件、skip 0件だった。Database Integration Testでは、月初・翌月月初の境界、`COMPLETED`以外の除外、返金を確認した。

## 理解確認

### なぜClientから取引データを渡さないのか

Clientの集計値を正とすると、改ざんや計算差異を防げない。OCR結果をWorkerがDBへ保存し、DBの状態と制約を通過したデータだけをSQLで集計することで、Dashboardと将来のInsightsの数値を同じ正本から生成できる。

### なぜ半開区間を使うのか

`>= 月初 AND < 翌月月初`にすると、月末日の時刻表現やタイムゾーン境界に依存せず、隣接する月の取引を重複・欠落なく分けられる。

### なぜFrontendで集計しないのか

Frontendへ全明細を送る必要があり、金額計算の正確性とアクセス制御が複雑になる。SQLを数値の正とし、Backendで表示用の割合・前月比だけを整形する。

### なぜ0円の前月比をnullにするのか

0を分母にした割合には意味がないため、0や任意の代替値に変換せず、計算不能を`null`で表現する。
