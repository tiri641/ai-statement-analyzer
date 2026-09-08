# Phase 8 Plan: IdempotencyとWorker OCR接続

## 目的

Phase 6の常駐Worker、Phase 7のBedrock OCR、Phase 4のS3、Phase 2のPostgreSQLを接続し、SQS Standard Queueの重複配送・Worker停止・複数Workerの競合があっても、1つのstatementが最終的に1回分の取引データへ収束する処理を作る。

Phase 8の責務は、AIの再試行回数やDLQ判定ではなく、処理権の取得、fencing、DB保存、ACK順序を確立することである。

## 現在の実装との差分

- `statements`には`processing_started_at`、`processing_lease_expires_at`、`processing_token`が既にある。
- `StatementRepository`には取引保存Transactionがあるが、`PROCESSING`の確認だけで、claim・lease・token検証はまだない。
- `StatementObjectStore`にはPresigned PUTと`HeadObject`しかなく、Worker用`GetObject`がない。
- `AnalyzeWorker`はhandlerが`void`で成功すると常にMessageを削除するため、「別Workerが現在処理中なのでACKしない」という結果を表現できない。
- `src/worker.ts`のhandlerは確認用ログだけで、DB・S3・Bedrockを接続していない。

## 処理フロー

```text
SQS ReceiveMessage
  ↓ statementIdを受け取る
DB: QUEUED、または期限切れPROCESSINGをAtomic claim
  ↓ processing tokenとleaseを発行
S3: GetObject（DBのMetadataと照合）
  ↓ bytes
BedrockOcrAnalyzer: OCR + Zod Validation
  ↓ OcrResult
DB Transaction
  ├─ tokenとleaseを再確認
  ├─ transactionsを保存
  └─ statementをCOMPLETEDへ更新
  ↓ COMMIT成功後
SQS DeleteMessage
```

`DeleteMessage`をDBの`COMMIT`より先に実行しない。COMMIT前にWorkerが停止した場合はMessageを再配送させ、COMMIT後からDelete前に停止した場合は、次のWorkerが`COMPLETED`を確認して処理をskipする。

## 実装開始時の仕様確認

実装開始日に、以下を公式資料と現在の設定で再確認し、確認日をこのPlanまたはlearning記録へ追記する。

1. SQS Standard Queueのat-least-once delivery、Visibility Timeout、未ACK時の再配送。
2. 現在のMain QueueのVisibility Timeout 300秒と、DB leaseの既定10分の整合性。Phase 8は短時間の処理を前提とし、`ChangeMessageVisibility`によるHeartbeatはPhase 8の対象外とする。長時間処理を実AWSで許可する前に、Heartbeatを追加するPhaseを決定する。
3. S3 `GetObject`のBodyをSDKからboundedな`Uint8Array`へ変換する方法と、Worker Task Roleに必要な`s3:GetObject`権限。
4. 既存のBedrock Model ID、Region、画像入力、Converse契約、入力Token・出力Token料金。料金はコードへ埋め込まず、Phase 7と同じくusageを必要な範囲で扱う。

## 採用する設計

### 1. Atomic claim

`StatementRepository.claimForProcessing`を追加する。Worker側で先に`findById`してから更新するのではなく、1回の条件付き`UPDATE ... RETURNING`で処理権を取得する。

```sql
UPDATE statements
SET status = 'PROCESSING',
    processing_started_at = NOW(),
    processing_lease_expires_at = NOW() + INTERVAL '10 minutes',
    processing_token = $2,
    updated_at = NOW()
WHERE id = $1
  AND (
    status = 'QUEUED'
    OR (
      status = 'PROCESSING'
      AND processing_lease_expires_at < NOW()
    )
  )
RETURNING id, s3_key, content_type, content_length,
          processing_started_at, processing_lease_expires_at,
          processing_token;
```

- tokenはWorkerが`randomUUID()`で生成し、claimごとに変える。
- 既定leaseは10分とし、環境設定またはWorker依存性から変更可能にする。
- `RETURNING`が0行の場合は、再読込して`COMPLETED` / `FAILED`ならACK、現在有効な`PROCESSING`ならACKせず保留する。
- `QUEUED`以外の状態をWorkerが勝手に戻したり、`FAILED`を自動再実行したりしない。

Claimの戻り値は、WorkerがS3取得に必要な`statementId`、`s3Key`、`contentType`、`contentLength`、`processingToken`、lease期限を含む型付きRecordにする。`StatementRecord`にも必要なactive processing情報を正しくmapする。

### 2. S3取得と入力境界

`StatementObjectStore`へWorker用の`getObject`を追加し、`S3ObjectStore`では`GetObjectCommand`を使う。

- BodyをそのままBedrockへ渡さず、`Uint8Array`へ変換する。
- DBに保存したContent-Type / Content-Length、S3応答のMetadata、実際のbytes長を照合する。
- 対応形式、空bytes、10 MiB超過をBedrock呼び出し前に拒否する。
- `AbortSignal`をS3 SDKへ渡し、WorkerのGraceful Shutdownと接続する。
- 画像bytes、S3 key、Presigned URL、カード番号などをログへ出さない。

Metadata不一致やS3取得エラーはPhase 8ではhandlerの失敗として扱い、Messageを削除しない。retryable / permanentの分類と`FAILED`への遷移はPhase 9で決める。

### 3. WorkerのACK境界

既存Workerのhandler契約を、後方互換な形でACK結果を表現できるようにする。例えば`void`はACK、明示的な`RETRY`はACKしない、というdisposition型を追加する。

| handler結果 | DeleteMessage | 用途 |
|---|---:|---|
| `ACK`または既存の`void`成功 | 実行 | OCR保存とCOMMIT成功、またはterminal stateのskip |
| `RETRY` | 実行しない | 他Workerが有効なleaseを持つ、またはPhase 8の処理失敗 |
| throw | 実行しない | S3、Bedrock、DB、Validationの失敗 |

Workerのhandlerは次の順序で動く。

1. `claimForProcessing(statementId)`を呼ぶ。
2. claimできなければstatusを再確認し、terminal stateだけACKする。
3. claimできた場合だけS3から取得する。
4. `BedrockOcrAnalyzer.analyze`へ画像bytesとContent-Typeを渡す。
5. 検証済み`OcrResult`を`CreateTransactionInput`へ変換する。
6. tokenとleaseを渡して保存Transactionを実行する。
7. 保存TransactionがCOMMITした後にだけ`ACK`を返す。

### 4. token付き保存Transaction

`saveTransactionsAndComplete`を、`statementId`だけでなく`processingToken`を受け取る形へ変更する。

Transaction内で以下を実行する。

1. `BEGIN`。
2. `status = 'PROCESSING'`、`processing_token = $token`、lease未期限切れを確認する。0行ならfencing失敗としてRollbackする。
3. `transactions`を保存する。`UNIQUE(statement_id, line_number)`をDB側の重複防止境界にし、既存設計どおり同じlineは`ON CONFLICT (statement_id, line_number) DO UPDATE`で再実行に収束させる。
4. 同じtokenと有効leaseを条件に`statements`を`COMPLETED`へ更新する。
5. `processed_at`を設定し、active leaseとtokenをNULLにする。処理開始時刻は処理時間の確認に使えるため保持する。
6. `COMMIT`。

完了UPDATEの`RETURNING`が0行なら、古いWorkerがleaseを失った可能性があるため、取引保存も含めてRollbackする。`failure_code`や`failure_message`を完了時にクリアする。Phase 8では失敗時に`FAILED`へ変更せず、lease期限後の再claimまたはPhase 9の分類へ委ねる。

## TDDの進め方

### Repository / DB

Redで次のテストを追加する。

- 2つのWorkerが同じ`QUEUED`を同時claimしても、一方だけが成功する。
- 有効な`PROCESSING`はclaimできず、lease期限切れの`PROCESSING`は新しいtokenで再claimできる。
- tokenが異なる古いWorkerはtransactionsを保存・完了できない。
- 取引INSERTの途中でエラーが起きた場合、全取引と`COMPLETED`更新がRollbackされる。
- 正しいtokenでの保存は、取引保存と`COMPLETED`更新を同一Transactionで確定する。
- `COMPLETED`後の再処理で取引行が二重にならない。

実DBテストでは、lease期限を待つ代わりに対象行の期限を過去へ更新してstale claimを再現する。A/B raceはBarrierを使い、claim・lease失効・古いtokenの完了競合を再現する。

### Worker / adapter integration

Fake Queue、Fake Object Store、Fake Bedrock Analyzer、Fake Repositoryを注入し、次を検証する。

- `claim → GetObject → OCR → DB COMMIT → DeleteMessage`の順序になる。
- DB保存失敗、S3失敗、Bedrock失敗ではDeleteMessageしない。
- `COMPLETED`の重複MessageはS3・Bedrockを呼ばずにACKする。
- 有効な`PROCESSING`を検出したMessageはACKせず、別Workerへ処理を残す。
- A/Bのうち古いtokenのWorkerが最終保存を上書きできない。
- WorkerのAbortSignalがS3・Bedrockへ伝播する。
- ログに画像bytes、S3 key、ReceiptHandle、Presigned URL、例外メッセージ全文が含まれない。

## 今回は作らないもの

- retryable / permanent errorの業務分類
- `FAILED`更新、safe failure code、maxReceiveCount・DLQの運用判断
- SQS `ChangeMessageVisibility`によるHeartbeat
- ECS Task Definition、VPC、IAM Role、Secrets、CloudWatch Alarm
- APIの新規Endpoint、認証・owner_id、月次Analytics
- OCR結果のusageやモデル応答全文の永続化

既存のSQS Queue/DLQ設定は変更せず、Phase 8では「処理成功後だけACKする」境界の実証に集中する。Visibility Timeoutを超える本番処理を許可する前に、Heartbeatとlease期間の組み合わせを後続Phaseで承認する。

## 完了条件

- `QUEUED -> PROCESSING`のclaimがAtomicで、同時実行時に1 Workerだけが処理権を得る。
- lease期限切れの処理を別Workerが再claimできる。
- processing tokenを持たない古いWorkerが取引や`COMPLETED`を保存できない。
- S3から取得した画像を既存のBedrock OCR adapterへ渡せる。
- OCR結果の保存と`COMPLETED`更新が1つのDB Transactionで行われる。
- DB COMMIT前はDeleteせず、COMMIT後だけDeleteする。
- COMMIT後Delete前の再配送は、追加のOCR・取引登録をせずに安全にACKできる。
- Unit / Integration / Failure Scenarioテスト、`npm test`、`npm run typecheck`、`npm run build`が成功する。
- `docs/worker.md`、`docs/idempotency.md`、`docs/database.md`、`learning/phase-08.md`に実装結果、障害時の挙動、Security、Cost、理解確認を記録する。

## Decision Required

| 項目 | 推奨 | 理由 |
|---|---|---|
| DB lease | 既定10分、設定可能 | `DATABASE_DESIGN.md`と一致し、stale処理を回収できる。実処理時間とSQS Visibility Timeoutは実装開始時に再評価する |
| 有効な別Workerを検出したMessage | ACKしない | 先行Workerの失敗時に再配送・再claimできる。terminal stateだけACKする |
| transaction重複時の動作 | `ON CONFLICT DO UPDATE` | DB制約を最後の防波堤にし、同じstatementの再実行結果を一貫させる |
| Phase 8の失敗時status | `PROCESSING`を維持 | Retry分類と`FAILED`の公開契約をPhase 9でまとめて決める |

## 公式仕様への参照

- [Amazon SQS at-least-once delivery](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/standard-queues-at-least-once-delivery.html)
- [Amazon SQS Visibility Timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [Amazon S3 GetObject API](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html)
- [Amazon Bedrock Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html)
- [Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/)
- [PostgreSQL Transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html)
- [PostgreSQL SELECT locking clauses](https://www.postgresql.org/docs/current/sql-select.html)
