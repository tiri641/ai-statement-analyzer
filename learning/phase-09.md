# Phase 09: Retry / DLQ

## Status

実装・動作確認完了。作業ブランチ: `phase-09/retry-dlq`

## 今回作ったもの

- 処理段階別のRetryable / Permanent error分類
- S3、Bedrock、DBの失敗境界
- `PROCESSING`、processing token、leaseを条件にした`FAILED`更新
- `failure_code`と`failure_message`のDB制約
- Permanent failure保存後だけACKするWorker処理
- DLQの可視Message数を検知するCloudWatch Alarm
- Alarm通知用SNS TopicとCloudWatch Alarm Action
- Worker shutdownのAbortError再配送と、DB leaseより長い900秒のVisibility Timeout
- Controlled redriveとSlack通知の運用ドキュメント

## データフロー

```text
ReceiveMessage
  ↓
Atomic claim
  ↓
S3 GetObject
  ↓
Bedrock OCR
  ↓
成功: Transaction COMMIT -> DeleteMessage
失敗:
  Retryable -> Deleteしない -> SQS再配送/DLQ
  Permanent -> FAILED COMMIT -> DeleteMessage
```

`markFailed`はtokenと有効leaseを条件にする。古いWorkerがPermanent errorを検出しても、新しいWorkerの処理権を上書きできない。

## Failure code

アプリケーションが保存するfailure codeは次に限定した。

- `SOURCE_OBJECT_NOT_FOUND`
- `SOURCE_OBJECT_INVALID`
- `UNSUPPORTED_IMAGE`
- `INVALID_OCR_RESPONSE`
- `OCR_NON_RETRYABLE`
- `PROCESSING_FAILED`

内部例外文、S3 key、画像情報、カード情報はfailure messageやAPIレスポンスへそのまま出さない。

## TDD

Redで分類器、Repository、Handler、API、CDKの失敗テストを追加し、Greenで最小実装を追加した。最後に既存のS3、Worker、API、Bedrock、SQSテストを含む全テストを実行した。

実PostgreSQLではMigration 004、正しいtokenでのFAILED更新、token不一致、lease期限切れを確認した。

PRレビューでは、Graceful ShutdownのAbortErrorを恒久エラーにしないこと、SQS Visibility TimeoutとDB leaseの関係、不正なS3 Body chunkの分類、AlarmからSNS Topicへの接続を追加確認した。HandlerのObjectNotFound、OCR応答不正、Bedrock非再試行、DB障害、FAILED更新障害のテストも追加した。

## 障害時の挙動

| 障害 | Statement | Message |
|---|---|---|
| Bedrock throttling | `PROCESSING`維持 | 削除しない |
| S3 object不存在 | `FAILED` | DB更新後に削除 |
| 対応外画像 | `FAILED` | DB更新後に削除 |
| OCR応答Validation失敗 | `FAILED` | DB更新後に削除 |
| DBの一時障害 | `PROCESSING`維持 | 削除しない |
| token不一致 | 新Workerの状態を維持 | 削除しない |

## Security / Cost

- failure codeはallowlistで制御し、内部エラー文を公開しない。
- DLQ AlarmはAWSのservice metricを使い、custom metricを追加しない。
- DLQは自動redriveせず、原因修正後のControlled redriveにする。
- SNS TopicのSlack関連付けはAWS管理側で行い、Webhookや個人情報をcommitしない。

## 理解確認

1. SDK RetryとSQS Retryの違いは何か。
   SDK Retryは1回のAWS API呼び出し内の通信再試行で、SQS RetryはMessageを削除しない場合のVisibility Timeout後の再配送である。
2. Permanent errorでもDB更新後にACKする理由は何か。
   `FAILED`という終端状態をDBへ保存できた後なら、同じMessageを再配送させる必要がないためである。
3. `markFailed`にtokenとleaseを要求する理由は何か。
   leaseを失った古いWorkerが、新しいWorkerの処理結果を`FAILED`で上書きしないためである。
4. なぜDLQから無条件に自動redriveしないのか。
   原因未修正のMessageが再びDLQへ戻るループと、障害の見えにくさを防ぐためである。
5. Slack webhookをコードへ保存しない理由は何か。
   webhookは通知先を操作できる秘密情報であり、AWS側の通知設定と秘密管理へ分離するためである。
