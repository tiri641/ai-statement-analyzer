# Phase 9 Plan: Retry / DLQ

## 目的

一時障害は再試行し、入力不正や修復不能なOCRエラーは`FAILED`へ確定する。失敗したMessageを無条件にACKせず、DBの状態更新とSQSのACK順序を固定する。

## 実装内容

- 処理段階別のRetryable / Permanent error分類
- `PROCESSING`、processing token、leaseを条件にした`FAILED`更新
- Permanent failure保存後だけ`DeleteMessage`
- Main Queueの`maxReceiveCount: 3`と既存DLQの維持
- DB lease 10分より長いMain Queue Visibility Timeout（900秒）
- DLQの`ApproximateNumberOfMessagesVisible`を監視するCloudWatch Alarm
- AlarmからSNS Topicへの通知
- SNS TopicをAmazon Q Developer in chat applicationsへ関連付けるSlack運用手順

## エラー分類

| 段階 | Retryable | Permanent |
|---|---|---|
| S3 | AWS/Networkの一時障害 | Object不存在、Metadata・Body長不一致、画像情報不正 |
| Bedrock | Throttling、Timeout、Service Unavailable | 対応外画像、Invalid OCR Response、明示的な非再試行エラー |
| DB | 一般的なDB障害、claim loss | なし。fencingと再試行を優先 |

未知のS3/DBエラーはRetryableとし、未知のfailure codeや内部例外文を公開しない。

## ACK境界

```text
Retryable error
  -> FAILEDへ変更しない
  -> DeleteMessageしない
  -> Visibility Timeout後に再配送

Permanent error
  -> tokenとleaseを条件にFAILEDへ更新
  -> DB COMMIT成功後にDeleteMessage
```

`markFailed`の条件更新に失敗した場合、古いWorkerが別Workerの状態を上書きしないようACKしない。`FAILED`の重複Messageは追加処理せずACKする。

## DLQ運用

DLQからの無条件自動redriveは行わない。Alarmを受けた運用者が原因、対象Message、statement状態、lease期限を確認し、原因修正後にControlled redriveを開始する。redriveにはSQSの`StartMessageMoveTask`を使用し、アプリケーションへ管理者用Endpointやredrive権限を追加しない。

Slack通知はCDKが作成するSNS TopicをAmazon Q Developer in chat applicationsへAWS側で関連付ける。Slack webhook、workspace情報、購読先はリポジトリへ保存しない。

## 完了条件

- Retryable errorは`FAILED`にせず、Messageを削除しない。
- Permanent errorはsafe failure codeを保存し、保存成功後だけMessageを削除する。
- token不一致・lease切れの古いWorkerが`FAILED`へ更新できない。
- `failure_code`と`failure_message`にDB制約がある。
- DLQ AlarmとSNS通知先がCDKで定義される。
- Unit、Handler、PostgreSQL integration、CDKテストが成功する。
- `npm test`、`npm run typecheck`、`npm run build`、`npm run cdk:synth`が成功する。
