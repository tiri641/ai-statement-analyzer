# Phase 12: Observability

Status: 実装・動作確認完了。

## 目的

Observabilityはログを増やすことではなく、障害時に「何が起きたか」「いつ起きたか」「どのstatementIdか」「どの段階か」「Retryableか」「何件か」「次に何をすべきか」へ答えるための仕組みである。

## 実装方針

- Logsは個別の処理を調査するため、固定eventと相関IDを持たせる。
- Metricsは全体の滞留・エラー傾向を確認するため、低カーディナリティにする。
- `requestId`はHTTP、`statementId`は業務処理、`messageId`はSQS配送、`receiveCount`は再配送回数を表す。
- API受付成功、Queue投入成功、Worker完了、DB保存完了を同一視しない。
- RetryableとPermanentを分け、ACK / RETRYの結果を記録する。
- DLQ Slack通知はAlarmの出口であり、Logs・Metrics・相関ID・Runbookを含むObservability全体とは役割が異なる。

## Security / Cost

カード番号、画像、Presigned URL、S3 key、Authorization header、DB接続情報、raw Bedrock request / response、raw error messageはログへ出さない。

CloudWatch Logsは30日保持とし、`statementId`やmerchant名をMetricsのDimensionにしない。Alarmは運用者が行動できる条件だけを定義する。

## 完了確認

Phase開始前説明、TDD、対象テスト、型チェック、build、CDK synth、Diff check、障害時の挙動、Security、Cost、理解確認をPhase Planへ記録した。全テストは190件成功し、Production AWS変更・Push・PRは行っていない。
