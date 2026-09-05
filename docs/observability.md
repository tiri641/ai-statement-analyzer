# Observability

## Structured Log fields

event、timestamp、service、requestId、statementId、messageId、status、durationMs、receiveCount、errorCode、modelId、promptVersionをJSONで出す。カード番号、画像、Presigned URL、raw prompt / responseは出さない。

Phase 6 Workerでは、`worker_started`、`worker_job_started`、`worker_job_handler_recorded`、`worker_job_completed`、`worker_job_failed`、`worker_delete_failed`、`worker_receive_failed`、`worker_message_invalid`、`worker_shutdown_requested`、`worker_stopped`を記録する。エラー本文やReceipt Handleは記録しない。

## MVP metrics / alarms

- SQS ApproximateNumberOfMessagesVisible
- SQS ApproximateAgeOfOldestMessage
- DLQ message count
- ECS service desired / running count、task health
- Worker error count
- Bedrock error / throttling count

DLQ message count > 0とoldest message ageの閾値超過は通知する。MVPでは過剰なcustom metricsを作らず、AWS service metricsとLogsを優先する。Logs retentionは7〜30日から開始する。
