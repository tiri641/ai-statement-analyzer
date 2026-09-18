# Observability

## Structured Log fields

event、timestamp、service、requestId、statementId、messageId、status、durationMs、receiveCount、errorCode、modelId、promptVersionをJSONで出す。カード番号、画像、Presigned URL、raw prompt / responseは出さない。

Phase 6 Workerでは、`worker_started`、`worker_job_started`、`worker_job_handler_recorded`、`worker_job_completed`、`worker_job_failed`、`worker_job_shutdown_timeout`、`worker_delete_failed`、`worker_delete_shutdown_timeout`、`worker_receive_failed`、`worker_message_invalid`、`worker_shutdown_requested`、`worker_stopped`を記録する。エラー本文やReceipt Handleは記録しない。

## MVP metrics / alarms

- SQS ApproximateNumberOfMessagesVisible
- SQS ApproximateAgeOfOldestMessage
- DLQ message count
- ECS service desired / running count、task health
- Worker error count
- Bedrock error / throttling count

Phase 9ではDLQの`ApproximateNumberOfMessagesVisible >= 1`をCloudWatch Alarmで検知する。Alarm ActionはMessagingStackが作成するSNS Topicへ接続する。SNS TopicはAmazon Q Developer in chat applicationsへAWS側で関連付け、Slack channelへ通知する。Slack workspace、channel、購読設定、webhookはリポジトリへ保存しない。

DLQからのredriveはAlarmを受けた運用者が原因修正と対象確認を行った後に開始する。無条件自動redriveは行わない。oldest message age、Worker error count、Bedrock error countなどの詳細な監視はPhase 12で追加する。
