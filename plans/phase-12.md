# Phase 12: Observability 実装Plan

Status: 実装・動作確認完了。191テスト、型チェック、ビルド、CDK synth、Diff checkを通過。

## 目的

APIからSQS、Worker、S3、Bedrock、PostgreSQLまでの処理を、後から再構成・調査できるObservability基盤を追加する。

ログを増やすこと自体を目的にせず、障害発生時に次の問いへ答えられることを完了条件とする。

- 何が起きたか
- いつ起きたか
- どの`statementId`に影響したか
- どの処理段階で止まったか
- RetryableかPermanentか
- 何件に影響したか
- 次に何をすべきか

## 対象範囲

### 実装するもの

- 共通Structured Loggerと安全なJSONイベント
- APIのサーバー生成`requestId`とレスポンス`X-Request-Id`
- `requestId`、`statementId`、`messageId`、`receiveCount`による相関
- API、SQS、Worker、S3、Bedrock、PostgreSQL境界の処理ログ
- Retryable / Permanent、ACK / RETRY、処理段階の記録
- SQS標準Metrics、Worker / BedrockエラーMetrics、CloudWatch Alarm
- Log Groupの保持期間、秘密情報マスキング、運用Runbook
- Unit、API、Worker、CDK、秘密情報非漏洩テスト

### 実装しないもの

- SQS Message本文への`requestId`追加
- 既存のDB COMMIT後ACK、冪等性、Retry、DLQ設計の変更
- 既存のDLQ → SNS → Slack通知の作り直し
- OpenTelemetryやCloudWatch PutMetricDataの導入
- ECS、VPC、RDS、ALB、IAMのProductionデプロイ
- AWS上のSlack設定変更、Push、PR、Production変更

ObservabilityStackのLog GroupとAlarmはPhase 12で準備する。ECS Taskの`awslogs` Log Driverによる実行環境接続はECSを実装するPhase 13の対象であり、接続前のAlarmはAWS上でログを受信しない。

## 観測設計

### 相関ID

| ID | 役割 |
|---|---|
| `requestId` | 1回のHTTPリクエスト |
| `statementId` | 1件の明細処理 |
| `messageId` | SQS Messageの配送単位 |
| `receiveCount` | SQS再配送回数 |

API入口でサーバー生成UUIDの`requestId`を発行し、レスポンスの`X-Request-Id`へ返す。クライアントから渡された値は信頼しない。

SQS本文は既存どおり`statementId`だけとし、APIとWorkerの業務相関は`statementId`、SQS配送の相関は`messageId`と`receiveCount`で行う。

### 処理段階

```text
Message受信
  -> claim
  -> object-store
  -> ocr
  -> database
  -> COMMIT
  -> message-delete
```

各段階で開始、成功、失敗、処理時間を記録する。予期しないHandler例外は`unknown`段階として記録する。S3 key、画像、raw AI応答は記録しない。

### Structured Log

許可フィールドは次のとおりとする。

```text
event, timestamp, service, requestId, statementId, messageId,
status, durationMs, receiveCount, errorCode, stage, disposition,
modelId, promptVersion
```

固定イベント名を使い、`Error.message`全文、Presigned URL、S3 key、カード情報、raw prompt / responseをログへ出さない。

### 7つの問いと実装の対応

| 問い | 実装 |
|---|---|
| 何が起きたか | 固定`event`、`status`、`errorCode` |
| いつ起きたか | UTC `timestamp`、`durationMs` |
| どの明細か | API・SQS・Workerログの`statementId` |
| どこで止まったか | `stage`と開始・終了イベント |
| Retryableか | `disposition`、`errorCode`、ACK/RETRY結果 |
| 何件に影響したか | Logsと低カーディナリティMetricsの集計 |
| 次に何をするか | AlarmごとのRunbook、redrive条件、調査手順 |

### Metrics / Alarm

Metrics Namespaceは`AIStatementAnalyzer/Observability`とし、`statementId`、`requestId`、merchant名をDimensionにしない。

- `ApproximateNumberOfMessagesVisible`
- `ApproximateAgeOfOldestMessage`
- DLQ Message数
- Worker error count
- Bedrock error count

初期値はCDK Contextから変更可能にする。

- Oldest Message Age: 600秒以上が5分継続
- Worker error: 5分間に3件以上
- Bedrock error: 5分間に3件以上
- DLQ visible: 1件以上で即時Alarm

既存のDLQ Alarm、SNS Topic、Slack通知経路は維持する。DLQ redriveは原因修正と対象確認後に運用者が実行し、無条件自動redriveは行わない。

## 実装順序とTDD

1. LoggerのJSON形式、許可フィールド、timestamp、マスキングをRed -> Green -> Refactorで実装する。
2. API requestId Middleware、`X-Request-Id`、API完了ログを実装する。
3. APIの`statementId`ログとSQS送信ログを実装する。SQS本文は変更しない。
4. Workerの受信、処理段階、Retryable / Permanent、ACK / RETRY、Delete失敗を実装する。
5. Bedrock OCR / InsightsのmodelId、errorCode、処理時間、失敗分類を実装する。
6. ObservabilityStack、Log Group、Metric Filter、Alarm、SNS Actionを実装する。
7. 運用Runbook、learning記録、READMEのPhase状態を更新する。

各スライス後に対象テストを実行し、最後に全テストと型・ビルド・CDK検証を行う。

## テスト戦略

- Loggerが1行JSON、UTC timestamp、service、許可フィールドを出力する。
- raw error、Presigned URL、S3 key、画像、カード情報、raw AI responseが出力されない。
- API requestIdが生成され、レスポンスHeaderと完了ログに一致して現れる。
- `statementId`、`messageId`、`receiveCount`がAPI・SQS・Workerログへ記録される。
- Retryable errorはACKせず、Permanent errorはFAILED保存後にACKする。
- WorkerのReceive失敗、処理失敗、Delete失敗、Shutdown timeoutを区別する。
- BedrockのThrottlingとValidation失敗を別のerrorCodeで記録する。
- Log Group、Metric Filter、Oldest Age / Worker / Bedrock / DLQ AlarmをCDKテンプレートで確認する。
- 既存のDLQ Alarmが重複せず、SNS Actionが維持される。

## 検証コマンド

```bash
DATABASE_URL=postgres://app:local_dev_password@127.0.0.1:5432/statement_analyzer_test npm test
npm run typecheck
npm run typecheck:infra
npm run build
npm run cdk:synth
git diff --check
```

## 実装結果

- `src/observability/logger.ts`に、UTC timestamp・service・allowlist・文字列sanitizationを持つ共通Structured Loggerを追加した。
- APIはサーバー生成の`requestId`を発行し、`X-Request-Id`、開始・完了・失敗ログへ同じ値を記録する。クライアント指定のIDは採用しない。
- APIのstatement作成、Upload完了、SQS投入と、WorkerのMessage受信・claim・S3取得・OCR・DB保存・Message削除を`statementId`、`messageId`、`receiveCount`で追跡できるようにした。
- Workerの段階ログに`started`、`completed`、`failed`、`durationMs`を追加し、`disposition`とACK / RETRYの結果を記録する。Bedrockの通信失敗と検証不正は別イベントにした。
- CloudWatch Log Groupを30日保持で追加し、Worker / Bedrock Metric Filter、Main Queue oldest-message-age、Worker error、Bedrock error Alarmを既存のSNS通知Topicへ接続した。DLQ AlarmはMessagingStackの既存定義を維持した。
- Loggerのallowlistにより、raw error、Presigned URL、S3 key、カード番号、raw prompt / responseを出力しない。

検証結果:

- `DATABASE_URL=postgresql://app:local_dev_password@127.0.0.1:5432/statement_analyzer_test npm test`: 191 passed / 0 failed
- `npm run typecheck`: passed
- `npm run typecheck:infra`: passed
- `npm run build`: passed
- `npm run cdk:synth`: passed（CDKのcross-stack-reference warningのみ）
- `git diff --check`: passed

## 完了Gate

- 任意の`statementId`についてAPIからWorker完了まで処理を再構成できる。
- ログから、何が・いつ・どの段階で起きたか分かる。
- Retryable / PermanentとACK / RETRYの違いが分かる。
- Metricsから影響件数、Queue滞留、Worker・Bedrock障害を把握できる。
- Alarmごとの調査・復旧・redrive手順がある。
- 既存のACK順序、冪等性、Retry、DLQ処理に回帰がない。
- 機密情報と未検証AI出力がログに出ない。
- 全テスト、型チェック、ビルド、CDK synth、Diff checkが成功する。
