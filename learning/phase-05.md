# Phase 05: SQS

Status: 実装完了。ECS Workerの実装はPhase 6で行う。

## 1. 今回作るもの

Phase 5では、解析開始APIからSQS Standard Queueへ`statementId`だけを送る処理と、Messageを最大1件受信して形式を確認し、削除する最小のConsumerを作った。SQSから受け取った後のS3、Bedrock、PostgreSQL保存処理と常駐Workerループはまだ実装していない。

## 2. なぜ必要か

画像取得やBedrock OCRはHTTPリクエストの中で待ち続ける処理に向かない。APIは受付とジョブ投入を担当し、後続のWorkerがSQSから仕事を受け取る形に分けることで、処理時間の長さ、Retry、DLQ、Worker台数をAPIから切り離せる。

SQSはWorkerではない。SQSはMessageを保持して再配送するサービスであり、WorkerはSQSを`ReceiveMessage`して業務処理を実行するプログラムである。

## 3. 内部処理

```text
POST /statements/{id}/analyze
  ↓
DBからstatement取得
  ↓
UPLOADEDだけをQUEUEDへ条件付きUPDATE
  ↓
SQS SendMessage
  {"statementId":"..."}
  ↓
APIは202 Accepted

最小Consumer
  ↓ ReceiveMessage（WaitTimeSeconds=20）
  ↓ JSONとUUIDをZodでValidation
  ↓ DeleteMessage（ReceiptHandleを使用）
```

`UPLOAD_PENDING`は画像アップロード未完了なので409、存在しないIDは404、DBまたはSQSの障害は503とした。すでに`QUEUED`以降の状態なら同じSQS Messageを再送せず、現在の状態を返す。

## 4. 重要な実装

- `src/queue/analyze-job.ts`: Message schemaとQueueのアプリケーション境界。
- `src/queue/sqs-job-queue.ts`: AWS SDK v3の`SendMessageCommand`、`ReceiveMessageCommand`、`DeleteMessageCommand`を隠すアダプター。
- `src/app.ts`: `UPLOADED -> QUEUED`、SQS送信、202/409/503のHTTP制御。
- `src/database/statement-repository.ts`: `WHERE status = 'UPLOADED'`の条件付きUPDATE。
- `infra/lib/messaging-stack.ts`: Main Queue、DLQ、暗号化、SSL強制、保持期間、redrive設定。

## 5. 障害時の挙動

### SQS送信が明確に失敗した場合

APIは`QUEUED -> UPLOADED`へ戻す処理を試み、503を返す。再度APIを呼ぶと再キュー可能になる。状態復旧自体にも失敗した場合はログに`analyze_queue_state_recovery_failed`を残すため、運用上の確認が必要になる。

### DB更新後、SQS送信前にAPIが停止した場合

statementが`QUEUED`のまま、SQSにMessageがない状態が起こり得る。DBとSQSは同じTransactionではないためである。今回のPhaseではOutboxやreconciliationを実装していない。この問題は、DB Transaction内にOutbox行を保存し、別PublisherがSQSへ送る方式で後続Phaseに再検討する。

### MessageをDeleteしなかった場合

Messageはすぐ消えず、Visibility Timeoutの間だけ他のConsumerから見えなくなる。期限が切れると再び受信可能になり、Standard Queueのat-least-once deliveryにより同じMessageが複数回処理され得る。3回受信されるとredrive policyによりDLQへ移動する。Phase 5のConsumerでは、Validation不能なMessageもDeleteせず、再配送・DLQの対象にする。

### APIが送信後に202を返す前に停止した場合

SQSにMessageが残っていれば、クライアントが202を受け取れなくても後続Consumerは処理できる。一方、クライアントが再試行して同じstatementを指定しても、DB状態が`QUEUED`ならAPIは再送しない。送信結果が不明なケースの完全な重複排除は、後続Workerの冪等性で扱う。

## 6. 動作確認

自動テストではFake SQS clientを注入し、AWSへ接続せず次を確認した。

- Message bodyが`statementId`だけである。
- Receiveが20秒Long Poll設定と`ApproximateReceiveCount`を指定する。
- 不正Messageが削除されない。
- ReceiptHandleを使ってDeleteMessageする。
- `UPLOADED`だけが`QUEUED`へ遷移する。
- SQS送信失敗時に状態を戻して503を返す。
- CDKがMain QueueとDLQを作り、redrive設定を持つ。

実AWSではMessagingStackをデプロイし、Producerから送ったMessageをAWS CLIで受信・削除する。未削除MessageはVisibility Timeout後に再配送され、`maxReceiveCount`を超えるとDLQへ移動することを確認する。

### 実AWS確認結果（2026-09-05、ap-northeast-1）

- AWSアカウント`975050014528`へ`MessagingStack`をデプロイし、`CREATE_COMPLETE`を確認した。
- S3へテストObjectをPUTして`upload/complete`を呼び、`analyze`が202と`QUEUED`を返した。
- AWS CLIでMain QueueからMessageを受信し、bodyが`statementId`だけであることを確認して`DeleteMessage`した。
- 削除しないテストMessageで`ApproximateReceiveCount`が1、2、3と増え、次の受信時にはMain Queueから消えてDLQへ1件移動したことを確認した。DLQのMessageも削除した。
- 確認用S3 ObjectとローカルDBのテストstatementも削除した。

最初のデプロイは、CDKのCloudFormation実行RoleにSQS作成権限がなく失敗した。ログインユーザーがAdministratorAccessを持っていても、CloudFormationが引き受けるRoleの権限でリソース作成が行われる。`MessagingStack-*`のSQS Queueだけを作成・設定できるインラインポリシーを実行Roleへ追加して再実行した。この権限はアプリケーションのTask Roleではなく、CDKデプロイ用Roleの権限である。

追加した1件処理Consumerについても、AWS CLIでテストMessageを送信し、`npm run consume:analyze`が`DELETED`と`receiveCount: 1`を出力することを確認した。MessageはConsumerが削除したため、Queueには残っていない。

### レビュー結果と対応

- READMEのSQSデプロイ・`SQS_QUEUE_URL`設定不足を修正した。
- アダプターだけでなく、`ReceiveMessage -> Validation -> DeleteMessage`を実行する`consumeOneAnalyzeJob`と`npm run consume:analyze`を追加した。
- 同時解析要求でSQSへ1回だけ送信するテストを追加した。
- DBとSQSの送信結果不明、認証・所有者条件、DLQの`ALLOW_ALL`は、今回のPhaseの既知の制限として記録した。DBとSQSの送信漏れ対策はOutbox、認証は公開前、DLQのSource Queue制限はPhase 13で再検討する。

## 7. Security

- Messageには画像本体、カード番号、Presigned URLを入れず、UUID形式の`statementId`だけを入れる。
- QueueとDLQはSSE-SQSで暗号化する。
- QueueはSSL接続を強制する。
- FrontendにAWS Credentialsを渡さない。SQS送信はAPI実行環境のIAM Roleで行う。
- Phase 13でAPIとWorkerのIAM Roleを分離し、APIはSendMessage、WorkerはReceive/Deleteだけに限定する。

## 8. Cost

SQSはQueueを起動している時間ではなく、リクエスト数とデータ量を中心に課金される。Main QueueとDLQを作っても、ECSやNAT Gatewayのような常時起動の時間課金はない。Learning環境でも、送受信、Retry、DLQ移動のリクエストが増えれば費用が増えるため、テストMessageは削除する。料金確認日と前提は[COST_DESIGN.md](../COST_DESIGN.md)に記録する。

## 9. 理解確認

### Q1. なぜSQSを使うのか？

APIのHTTP受付と時間のかかるOCR処理を分離し、後続のWorkerでRetry、Visibility Timeout、DLQ、スケールを扱うためである。

### Q2. SQSとWorkerは同じものか？

違う。SQSはMessageの保持・配送を担当するAWSサービスで、WorkerはMessageを受信して業務処理を行うアプリケーションである。

### Q3. DeleteMessageしなかったらどうなるか？

Visibility Timeoutの間だけ非表示になり、期限後に再配送される。何度も受信されるとredrive policyによりDLQへ移動する。

### Q4. なぜMessage bodyを小さくするのか？

画像本体をSQSに入れず、DBのstatementIdからWorkerが必要な情報を取得するためである。Messageが小さくなり、機密情報やサイズ制限の問題も減る。

### Q5. なぜDB更新とSQS送信を同じTransactionにしないのか？

PostgreSQLのTransactionとSQSのSendMessageを1つのACID Transactionとしてコミットできないためである。今回の直接送信方式には障害窓があり、Outboxがその送信漏れを小さくする選択肢になる。
