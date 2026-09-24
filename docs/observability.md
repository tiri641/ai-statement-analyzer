# Observability

## 目的

APIからSQS、Worker、S3、Bedrock、PostgreSQLまでの処理を、`statementId`で後から再構成・調査できるようにする。

障害時に「何が起きたか」「いつ起きたか」「どの明細か」「どの段階か」「Retryableか」「何件か」「次に何をすべきか」へ答えられることを目的とする。

## 相関ID

- `requestId`: 1回のHTTPリクエスト。API入口でサーバー生成し、`X-Request-Id`へ返す。
- `statementId`: 1件の明細処理。API、SQS、Worker、DBの業務相関に使う。
- `messageId`: SQS Messageの配送単位。
- `receiveCount`: SQSの再配送回数。

SQS本文は`statementId`だけとし、HTTPの`requestId`はMessage本文へ追加しない。

## Structured Log fields

`event`、`timestamp`、`service`、`requestId`、`statementId`、`messageId`、`status`、`durationMs`、`receiveCount`、`errorCode`、`stage`、`disposition`、`modelId`、`promptVersion`をJSONで出す。

処理段階は`claim`、`object-store`、`ocr`、`database`、`message-delete`として記録する。カード番号、画像、Presigned URL、S3 key、raw prompt / response、raw error messageは出さない。

主なイベントは`api_request_started`、`api_request_completed`、`analyze_job_sent`、`worker_message_received`、`worker_stage_started`、`worker_job_claimed`、`worker_stage_completed`、`worker_stage_failed`、`worker_job_retry`、`worker_job_failed`、`worker_job_completed`、`worker_delete_failed`、`bedrock_request_failed`、`bedrock_response_invalid`である。エラー本文やReceipt Handleは記録しない。

## MVP metrics / alarms

- SQS ApproximateNumberOfMessagesVisible
- SQS ApproximateAgeOfOldestMessage
- DLQ message count
- Worker error count
- Bedrock error / throttling count

Metrics Namespaceは`AIStatementAnalyzer/Observability`とする。`statementId`、`requestId`、merchant名はMetricsのDimensionにしない。

ObservabilityStackはAPI・WorkerのLog Groupを30日保持し、JSONログのMetric Filterと次のAlarmを定義する。

- Main Queue oldest message age: 600秒以上が5分継続
- Worker error: 5分間に3件以上
- Bedrock error: 5分間に3件以上
- DLQ visible: 1件以上（Phase 9の既存Alarm）

ECS service desired / running countとTask healthはPhase 13で追加する。

Phase 9のDLQ `ApproximateNumberOfMessagesVisible >= 1` Alarmは、MessagingStackが作成するSNS Topicへ接続する。SNS TopicはAmazon Q Developer in chat applicationsへAWS側で関連付け、Slack channelへ通知する。Slack workspace、channel、購読設定、webhookはリポジトリへ保存しない。Phase 12のWorker / Bedrock / Queue Alarmも同じ通知Topicを利用する。

DLQからのredriveはAlarmを受けた運用者が原因修正と対象確認を行った後に開始する。無条件自動redriveは行わない。

## 調査手順

1. AlarmのMetricsでQueue滞留、Worker error、Bedrock errorの規模と継続時間を確認する。
2. 対象の`statementId`、`messageId`、`receiveCount`でStructured Logを検索する。
3. `stage`と`disposition`から、S3、Bedrock、DB、Message削除のどこで止まったかを特定する。
4. Retryableなら再配送とDLQ到達状況を確認し、PermanentならDBの安全な`failureCode`を確認する。
5. 原因修正と対象確認後だけ、必要なDLQ MessageをControlled redriveする。
