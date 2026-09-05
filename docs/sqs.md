# SQS

## Phase 5 / Phase 6の範囲

Phase 5では解析ジョブをMain Queueへ送信し、1回だけ動く最小Consumerで受信・Validation・削除を確認した。Phase 6では常駐Workerが同じQueueをLong Pollingし、注入された処理関数の成功後にMessageを削除する。

SQSはWorkerではない。SQSはMessageを保持・配送するサービスであり、WorkerはSQSの`ReceiveMessage`を呼び出して業務処理を行うプログラムである。

## Message

Message bodyは小さくし、`statementId`だけを入れる。

```json
{"statementId":"019abc00-0000-7000-8000-000000000001"}
```

画像本体、カード番号、Presigned URLは入れない。Workerは`statementId`を使って、後続PhaseでDBからS3 keyなど必要な情報を取得する。Messageは`src/queue/analyze-job.ts`のstrictなZod schemaでUUIDと余分なフィールドを検証する。

## Queue設定

`infra/lib/messaging-stack.ts`の`MessagingStack`で次を定義する。

| 設定 | Main Queue | DLQ |
|---|---:|---:|
| 種類 | Standard | Standard |
| Message保持期間 | 4日 | 14日 |
| Visibility Timeout | 300秒 | 既定値 |
| ReceiveのLong Poll | 20秒 | - |
| 暗号化 | SSE-SQS | SSE-SQS |
| SSL強制 | 有効 | 有効 |
| maxReceiveCount | 3 | - |

Main QueueのMessageを処理しても、`DeleteMessage`を呼ぶまでは消えない。Visibility Timeoutは他のConsumerから一時的に見えなくする時間であり、処理完了を永続化する機能ではない。Standard Queueではat-least-once deliveryを前提にし、同じMessageの重複配送を受け入れる。

## APIからConsumerまで

```text
POST /statements/{id}/analyze
  ↓ DB: UPLOADED -> QUEUED
  ↓ SendMessage: { statementId }
  ↓ 202 Accepted
SQS ReceiveMessage
  ↓ WaitTimeSeconds=20
  ↓ Zod Validation
  ↓ DeleteMessage(ReceiptHandle)
```

`src/queue/sqs-job-queue.ts`がAWS SDK v3の`SendMessageCommand`、`ReceiveMessageCommand`、`DeleteMessageCommand`を隠し、APIとConsumerは`AnalyzeJobQueue`インターフェースを使う。テストではFake clientを注入する。

Phase 5の確認用Consumerは`src/queue/analyze-job-consumer.ts`の`consumeOneAnalyzeJob`である。`npm run consume:analyze`を実行すると、最大1件を受信し、Validation済みのMessageだけをReceiptHandleで削除する。これは常駐Workerとは異なる。

Phase 6の常駐Workerは`src/worker/analyze-worker.ts`にあり、`npm run worker`で起動する。Workerは1件ずつ処理し、処理成功後にだけDeleteMessageする。処理失敗、不正Message、Delete失敗では削除せず、Worker自体は継続する。Receiveエラーでは指数バックオフを行う。SIGTERM / SIGINTでは新規受信を止め、Long PollingをAbortしてから終了する。

## RetryとDLQ

Phase 5のConsumerがMessageを削除しないと、Visibility Timeout後に再配送される。3回目の受信後も削除されなければ、redrive policyによってDLQへ移動する。DLQは通常処理から隔離された調査対象であり、移動しただけで問題が解決したことにはならない。

- Retry候補: 一時的なAWS APIエラー、ネットワークエラー、後続PhaseのBedrock throttling。
- Retry不要候補: 不正画像、対応外形式、修復不能なValidationエラー。ただしPhase 5では処理分類をまだ実装せず、不正Messageも削除せずDLQで確認できるようにする。

AWS SDK v3の通信Retryと、SQSがVisibility Timeout後に行う再配送は別である。SDKの短い通信Retryで直らない処理失敗は、Messageを削除しないことでSQSの再配送へ委ねる。

## DBとSQSの送信境界

APIはまず`WHERE status = 'UPLOADED'`の条件付きUPDATEで`QUEUED`を取得し、その後SQSへ送信する。SQS送信が明確に失敗した場合は`QUEUED -> UPLOADED`へ戻して503を返す。

DB更新直後にAPIが停止した場合、`QUEUED`なのにQueueへMessageがない状態が残り得る。また、SendMessage後に応答を失うと、再送による重複の可能性がある。これはDBとSQSが同一ACID Transactionではないためである。Phase 5ではOutboxやreconciliationを実装せず、後続Workerの冪等性と後続Phaseの送信漏れ対策で扱う。

## AWS確認例

```bash
npm run cdk:deploy:messaging -- --require-approval never

aws sqs receive-message \
  --queue-url "$SQS_QUEUE_URL" \
  --max-number-of-messages 1 \
  --wait-time-seconds 5 \
  --region "$AWS_REGION"

aws sqs delete-message \
  --queue-url "$SQS_QUEUE_URL" \
  --receipt-handle '<受信結果のReceiptHandle>' \
  --region "$AWS_REGION"
```

確認後はテストMessageを削除する。DLQへ移動したテストMessageも調査後に削除する。

参照: [SQS Queue CloudFormation](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-resource-sqs-queue.html)、[Dead-letter queues](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)、[Visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)、[AWS SDK for JavaScript SQS examples](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_sqs_code_examples.html)。
