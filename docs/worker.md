# Worker

## SQSとの違い

SQSはMessageを保持・配送するAWSサービスであり、WorkerはSQSからMessageを受け取って処理するアプリケーションである。SQS自体が画像を解析したり、DBを更新したりするわけではない。

## Phase 6の範囲

Phase 6では、APIとは別に常駐するWorkerプロセスをローカルで実装した。`npm run worker`で起動し、SQSをLong Pollingして最大1件ずつ受信する。

Phase 6の処理関数は、受信したMessageの`messageId`、`statementId`、`receiveCount`を安全に記録するだけである。S3取得、Bedrock OCR、PostgreSQL保存、ECS Serviceへのデプロイは後続Phaseで実装する。

## 基本ループ

1. Shutdown中でなければ`ReceiveMessage`を呼び出す。
2. 最大1件のMessageを受信する。
3. Messageがなければ次のLong Pollingを開始する。
4. Messageがあれば、注入された処理関数を実行する。
5. 処理関数が成功した場合だけ`DeleteMessage`を呼び出す。
6. 次のMessageを受信する。

同時処理数は1件である。受信したMessageの処理と削除が完了するまで、次のMessageを受信しない。

## ACKの境界

```text
ReceiveMessage
  ↓
処理関数
  ↓ 成功
DeleteMessage
```

処理関数が失敗した場合はDeleteMessageを呼ばない。Deleteに失敗した場合もMessageは削除されたとみなさない。SQSのVisibility Timeoutが切れるとMessageが再配送されるため、後続Phaseの業務処理は重複実行に耐えられる必要がある。

不正Messageも削除しない。既存のQueueアダプターがValidationエラーを返し、Workerはエラーを記録してLoopを継続する。再配送を繰り返したMessageは、Queueの`maxReceiveCount`に設定した回数まで受信されるとDLQへ移動する。

## エラー処理

ReceiveMessageのエラーではWorkerを終了せず、次の間隔で再受信する。

```text
1秒 → 2秒 → 4秒 → 8秒 → 16秒 → 最大30秒
```

Receive成功または空応答でバックオフは1秒へ戻る。AWS SDKが行う通信Retryと、Messageを削除しないことで起こるSQS再配送は別の仕組みである。

## Graceful Shutdown

SIGTERM / SIGINTを受信すると、WorkerはShutdownを要求する。

1. Shutdown状態にする。
2. 新しいReceiveMessageを開始しない。
3. Long Polling中のReceiveMessageをAbortControllerで中断する。
4. すでに受信済みのMessageがあれば処理する。
5. 処理成功後にDeleteMessageする。
6. Workerを終了する。

処理関数の実行中にSIGTERMを受信した場合は、通常は処理とDeleteMessageの完了を待つ。ただし、Shutdown要求後に30秒経過しても処理またはDeleteMessageが完了しない場合は、削除せずにWorkerを終了する。MessageはSQSで再配送される。処理関数にはAbortSignalを渡しており、後続PhaseではこのSignalをS3・Bedrock・DB処理の停止に利用する。実際のECS Task Definitionで`stopTimeout=30秒`を指定するのはPhase 13で行う。

## 後続PhaseのWorker処理

最終的なWorkerは次の処理を行う。

1. `statementId`をValidationする。
2. DBで`QUEUED -> PROCESSING`のAtomic claimを取得する。
3. S3から画像を取得する。
4. BedrockでOCRする。
5. ZodでAI出力をValidationする。
6. DB Transactionで取引保存と`COMPLETED`更新を行う。
7. DB COMMIT後にDeleteMessageする。

処理時間がVisibility Timeoutを超える場合は、`ChangeMessageVisibility`によるHeartbeatを追加する。Workerが停止しても永久に`PROCESSING`へ残らないよう、DB leaseの期限と再claimも後続Phaseで実装する。

## 公式仕様への参照

- [Amazon SQS Long Polling](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/best-practices-setting-up-long-polling.html)
- [Amazon SQS Visibility Timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [Amazon ECS Task Lifecycle](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-lifecycle-explanation.html)
- [ECS ContainerDefinition stopTimeout](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerDefinition.html)
