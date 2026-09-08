# Worker

## SQSとの違い

SQSはMessageを保持・配送するAWSサービスであり、WorkerはSQSからMessageを受け取って処理するアプリケーションである。SQS自体が画像を取得したり、OCRしたり、DBを更新したりするわけではない。

## Workerの処理範囲

Phase 8のWorkerは、`statementId`だけを持つMessageを受信し、次の処理を行う。

1. DBで`QUEUED`または期限切れ`PROCESSING`をAtomic claimする
2. DBから得たS3 keyとMetadataを使って画像を取得する
3. S3 MetadataとDB登録値、実際のbytes長を照合する
4. Bedrock OCR Adapterへ画像bytesを渡す
5. Zodで検証済みのOCR結果を取引入力へ変換する
6. token付きDB Transactionで取引保存と`COMPLETED`更新を行う
7. DB COMMIT成功後にMessageを削除する

```text
ReceiveMessage
  ↓
Atomic claim
  ↓
S3 GetObject + Metadata照合
  ↓
Bedrock OCR + Zod Validation
  ↓
DB Transaction
  ↓ COMMIT
DeleteMessage
```

## Atomic claimとlease

Workerは`findById`してから別のUPDATEを実行せず、次の条件付きUPDATEを1回実行する。

- `QUEUED`はclaimできる
- `PROCESSING`は`processing_lease_expires_at < NOW()`の場合だけ再claimできる
- `UPLOADED`、`COMPLETED`、`FAILED`はclaimしない
- claimごとに新しい`processing_token`を発行する
- leaseの既定値は10分で、Worker依存性から変更できる

claimに成功すると、WorkerはS3 key、Content-Type、Content-Length、processing token、lease期限を受け取る。別Workerが有効なleaseを持つ場合、claimは失敗する。

claim失敗後に現在状態を再読込し、statementが存在しない場合、または`COMPLETED` / `FAILED`なら追加処理なしでACKする。それ以外の未完了状態はACKせず、SQSの再配送に任せる。削除済みstatementは同じIDで復元されないため、再試行しても処理可能にならない。

## S3取得

`StatementObjectStore.getObject`は、S3 `GetObjectCommand`のBodyを`Uint8Array`へ変換する。10 MiBを上限とし、次をすべて確認する。

- S3 Objectが存在する
- S3 Content-TypeとDBのContent-Typeが一致する
- S3 Content-LengthとDBのContent-Lengthが一致する
- 実際のbytes長がContent-Lengthと一致する
- bytesが空でない

画像bytes、S3 key、Presigned URLはログへ出さない。WorkerのShutdown時には`AbortSignal`をS3 SDKへ渡す。

## ACKの境界

`AnalyzeJobHandler`は`ACK`、`RETRY`、例外を返せる。

| handler結果 | DeleteMessage | 用途 |
|---|---:|---|
| `void` / `ACK` | 実行 | DB COMMIT成功、またはterminal stateのskip |
| `RETRY` | 実行しない | 有効な別Worker、未完了状態 |
| throw | 実行しない | S3、Bedrock、DB、Validationの失敗 |

DeleteMessageはDB COMMITの後だけ実行する。DeleteMessageが失敗した場合も処理失敗として扱い、MessageはSQSから再配送される可能性がある。COMMIT済みの重複Messageは`COMPLETED`を確認して、S3・Bedrock・DB処理を再実行せずACKする。

## Fencing

取引保存Transactionの開始時と完了UPDATE時に、次の条件を再確認する。

- statusが`PROCESSING`
- processing tokenがWorkerのtokenと一致する
- leaseがDB時刻で有効である

leaseを失った古いWorkerがTransaction中に取引を残さないよう、条件に一致しない場合はTransaction全体をRollbackする。完了UPDATEの`RETURNING`が0行の場合もfencing失敗としてRollbackする。

## Transactionと冪等性

`transactions`は`UNIQUE(statement_id, line_number)`を持つ。保存時は同じlineが存在すれば`ON CONFLICT DO UPDATE`で最新のOCR結果へ更新する。

取引INSERTとstatementの`COMPLETED`更新は同じDB Transactionで行う。一部の取引だけ保存された状態を作らない。

```text
BEGIN
  ↓ tokenとleaseを確認
  ↓ transactionsをINSERT ... ON CONFLICT DO UPDATE
  ↓ statementをCOMPLETEDへ更新
  ↓ lease/token/failure情報をクリア
COMMIT
  ↓
DeleteMessage
```

## 障害時の挙動

| 状況 | Workerの動作 | Message |
|---|---|---|
| Queueが空 | Long Pollingを継続 | なし |
| statementが存在しない | 追加処理なし | ACKして削除 |
| 有効な別Workerが処理中 | ACKしない | 再配送に任せる |
| `COMPLETED` / `FAILED` | 追加処理なしでACK | 削除する |
| S3取得・Metadata照合失敗 | 例外、状態は`PROCESSING`のまま | ACKしない |
| Bedrock・Validation失敗 | 例外、状態は`PROCESSING`のまま | ACKしない |
| DB保存・fencing失敗 | Rollback、ACKしない | 再配送に任せる |
| DeleteMessage失敗 | ログ、Workerは継続 | 再配送の可能性あり |

Phase 8では失敗理由をretryable/permanentに分類せず、`FAILED`へ更新しない。lease期限後の再claimとMessage再配送をPhase 9の方針へ委ねる。

## Graceful Shutdown

SIGTERM / SIGINTを受信すると、WorkerはShutdownを要求する。

1. Shutdown状態にする
2. 新しいReceiveMessageを開始しない
3. Long Polling中のReceiveMessageをAbortする
4. 受信済みMessageの処理を待つ
5. DB COMMIT済みの場合だけDeleteMessageする
6. Workerを終了する

Shutdown要求後30秒を超えて処理またはDeleteMessageが完了しない場合は、削除せずに終了する。処理中のS3・BedrockにはAbortSignalを渡す。ECS Task Definitionの`stopTimeout=30秒`はPhase 13で設定する。

## Phase 5の確認用Consumerとの違い

`npm run consume:analyze`の`consumeOneAnalyzeJob`は、QueueのReceive・Validation・Deleteを確認するためのPhase 5用ユーティリティである。Phase 8のOCR処理では使用せず、本番処理経路は`npm run worker`の常駐Workerだけとする。

## 設定

Workerは次の環境変数を使用する。

```dotenv
DATABASE_URL=postgresql://...
S3_BUCKET_NAME=<S3 bucket>
SQS_QUEUE_URL=<SQS queue>
AWS_REGION=ap-northeast-1
BEDROCK_OCR_MODEL_ID=jp.amazon.nova-2-lite-v1:0
PROCESSING_LEASE_SECONDS=600
```

`DATABASE_URL`、`S3_BUCKET_NAME`、`SQS_QUEUE_URL`がない場合や、lease秒数が正の整数でない場合はWorkerを起動しない。Credentialsは環境のAWS SDK認証機構または後続PhaseのTask Roleから取得する。

## テスト

Fake依存性と実PostgreSQLで次を確認する。

- Atomic claim、lease期限切れ、A/B race
- token不一致時のfencingとRollback
- OCR結果保存と`COMPLETED`更新のTransaction境界
- S3 Bodyのbounded変換、Metadata照合、AbortSignal
- `COMPLETED`の重複Messageのskip
- 有効な`PROCESSING`の重複Messageの未ACK
- S3・Bedrock・DB失敗時の未ACK
- COMMIT後だけのDeleteMessage
- 機密情報を含まない構造化ログ

## 公式仕様への参照

- [Amazon SQS at-least-once delivery](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html)
- [Amazon SQS Visibility Timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [Amazon S3 GetObject API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)
- [Amazon Bedrock Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html)
- [PostgreSQL Transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html)
