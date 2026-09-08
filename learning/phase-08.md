# Phase 08: Idempotency

Status: 実装・動作確認完了。

## 1. 目的

SQS Standard Queueの重複配送、Worker停止、複数Workerの競合が発生しても、同一statementのOCR結果と取引データを1回分へ収束させる。SQSのMessageを処理権の正とはせず、PostgreSQLのstatement状態、lease、processing tokenを処理権の正とする。

## 2. データフロー

```text
ReceiveMessage
  ↓
Atomic claim: QUEUED または期限切れ PROCESSING
  ↓ processing token + 10分 lease
S3 GetObject + DB Metadata照合
  ↓
BedrockOcrAnalyzer + Zod Validation
  ↓
DB Transaction: transactions保存 + COMPLETED更新
  ↓ COMMIT
DeleteMessage
```

DB COMMIT前にWorkerが停止した場合はMessageを再配送させる。COMMIT後DeleteMessage前に停止した場合は、次のWorkerが`COMPLETED`を確認して追加OCRなしでACKする。

## 3. 重要コード

### `src/database/statement-repository.ts`

`claimForProcessing`は`QUEUED`、または`processing_lease_expires_at < NOW()`の`PROCESSING`だけを条件付きUPDATEでclaimする。Workerが先にSELECTしてからUPDATEする方式を使わないため、同時実行時に1 Workerだけが処理権を取得できる。claim失敗後にstatement自体が存在しない場合は、再試行しても処理できない孤立MessageなのでACKして削除する。

`saveTransactionsAndComplete`はprocessing tokenを受け取り、Transaction開始時と完了UPDATE時にstatus、token、leaseを再確認する。tokenが古い場合やleaseが失効した場合は`ProcessingClaimLostError`としてRollbackする。

`transactions`の`UNIQUE(statement_id, line_number)`に対して`ON CONFLICT DO UPDATE`を使い、同じlineの再実行を既存行の更新へ収束させる。完了時にはlease、token、failure情報をNULLにする。

### `src/storage/s3-object-store.ts`

`GetObjectCommand`のBodyを最大10 MiBまでの`Uint8Array`へ変換する。S3 Content-Type、Content-Length、実際のbytes長を返し、WorkerがDB登録値と照合できるようにした。AWS SDK呼び出しにはWorkerの`AbortSignal`を渡す。

### `src/worker/analyze-job-handler.ts`

claim、S3取得、Metadata照合、Bedrock OCR、取引入力変換、token付きDB保存を注入可能な依存性で実装した。`COMPLETED`と`FAILED`の重複Messageは追加処理なしで`ACK`し、有効な`PROCESSING`や未完了状態は`RETRY`として削除しない。

### `src/worker/analyze-worker.ts` / `src/worker.ts`

handlerの`void`または`ACK`だけをDeleteMessageへ進め、`RETRY`または例外では削除しない。実行時にはPostgreSQL Pool、S3、Bedrock、SQSを生成し、Worker終了後にPoolをcloseする。

## 4. 障害時の挙動

| 事象 | DB | Message |
|---|---|---|
| claim前に停止 | `QUEUED` | 再配送・再claim |
| claim後に停止 | `PROCESSING` | lease期限後に再claim |
| 有効な別Workerを検出 | 先行Workerのleaseを維持 | ACKしない |
| S3/Bedrock失敗 | `PROCESSING`を維持 | ACKしない |
| DB保存途中の失敗 | Transaction全体をRollback | ACKしない |
| 古いtokenで完了処理 | Rollback、`COMPLETED`にしない | ACKしない |
| COMMIT後Delete前に停止 | `COMPLETED` | 再配送後に追加処理なしでACK |

Phase 8ではretryable/permanent分類、`FAILED`遷移、Heartbeat、DLQ運用を追加していない。SQS Visibility Timeoutは300秒、DB leaseは10分のままとし、長時間処理を本番で許可する前にHeartbeatを後続Phaseで設計する。

## 5. Security

- SQS Messageには`statementId`だけを保持する。
- 画像bytes、S3 key、ReceiptHandle、Presigned URL、カード番号をログへ出さない。
- S3 Metadata不一致やOCR失敗の内部メッセージを外部へ返さない。
- WorkerのAWS Credentialsはソースコードへ記述せず、環境の認証機構を使用する。
- Phase 8では新しいAWSリソースやIAM Roleを追加していない。

## 6. Cost

S3とBedrockは既存のPhase 4・7設計を使用する。S3のGetObjectで画像をWorkerへ転送し、Bedrockは1画像ごとに呼び出すため、画像サイズ、OCR再配送回数、入力・出力Token数が変動費へ影響する。

10 MiBの入力上限とBedrockの既存出力上限を維持し、OCRのusageは保存しない。Heartbeat、ECS常駐台数、VPC Endpointなどの固定費は後続Phaseで扱う。

## 7. テスト結果

Fake S3、Fake Bedrock、Fake Queue、Fake RepositoryによるUnit/Integration testと、PostgreSQLを使うDatabase integration testを追加した。

```text
DATABASE_URL=postgresql://app:local_dev_password@127.0.0.1:5432/statement_analyzer npm test
```

全118件に成功した。内訳は通常のUnit/Integration test 94件、PostgreSQL test 24件である。`npm run typecheck`と`npm run build`も成功した。

確認した主なケース:

- 同時claimで1 Workerだけが成功する
- lease期限切れ後に再claimできる
- 古いprocessing tokenが保存を上書きできない
- Transaction途中のエラーがRollbackされる
- `COMPLETED`の重複MessageがS3・Bedrockを再実行しない
- 有効な`PROCESSING`のMessageをACKしない
- S3 Body長不一致を拒否する
- S3とBedrockへAbortSignalを渡す
- COMMIT後だけDeleteMessageする

## 8. 理解確認

### Q1. なぜAtomic claimが必要か？

Worker A/Bが同時に同じstatementを読んでから更新すると、両方が処理を開始する可能性がある。条件付きUPDATEを1回で実行し、DBが1つの処理権だけを発行することで競合を防ぐ。

### Q2. leaseとprocessing tokenの役割は何か？

leaseは停止したWorkerの処理権を一定時間後に回収するための期限である。processing tokenはclaimごとの処理権識別子であり、新しいWorkerがclaimした後に古いWorkerがDBを更新することを防ぐ。

### Q3. なぜDB COMMIT後にDeleteMessageするのか？

DeleteMessageを先に実行すると、DB保存前にWorkerが停止したときMessageだけが消えて処理が失われる。先にCOMMITすれば、Delete前に停止しても再配送後に`COMPLETED`を確認して安全にACKできる。

### Q4. `ON CONFLICT`だけで冪等性を保証できるか？

できない。`ON CONFLICT`は取引行の重複を抑える仕組みであり、同時Workerの処理権管理や古いWorkerの状態更新は防げない。Atomic claim、token付きfencing、同一Transaction、ACK順序を組み合わせる必要がある。

### Q5. なぜHeartbeatをPhase 8で実装しなかったか？

現在のQueue Visibility Timeoutは300秒、DB leaseは10分であり、Phase 8は短時間処理を前提としている。S3・Bedrock接続後の実処理時間を計測してから、`ChangeMessageVisibility`とlease更新の組み合わせを後続Phaseで決定する。
