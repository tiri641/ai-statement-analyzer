# Idempotency

冪等性は、同じSQS Messageが複数回処理されても、statementの最終状態と取引データが1回分へ収束する性質である。

## 状態と処理権

SQSのMessage自体を一意な処理権として扱わない。Standard Queueでは同じMessageが重複配送される可能性があるため、PostgreSQLのstatement行を処理権の正とする。

```text
QUEUED
  ↓ Atomic claim
PROCESSING + processing_token + lease
  ↓ Transaction COMMIT
COMPLETED
```

`QUEUED`、またはlease期限切れの`PROCESSING`だけがclaimできる。claimは`UPDATE ... RETURNING`で一度に行い、Workerが先にSELECTしてからUPDATEする競合窓を作らない。

## leaseとprocessing token

- leaseの既定値は10分
- lease期限はDBの`NOW()`で判定する
- claimごとにUUID tokenを発行する
- 有効なleaseを持つ別Workerはclaimできない
- lease期限切れ後は新しいtokenで再claimできる

旧Workerが処理を続けていても、DB保存Transactionでtokenとleaseを再検証する。旧tokenでは取引保存も`COMPLETED`更新もできず、Transaction全体がRollbackされる。

## ACK境界

```text
ReceiveMessage
  ↓
claim
  ↓
S3 GetObject
  ↓
Bedrock OCR
  ↓
DB Transaction
  ↓ COMMIT成功
DeleteMessage
```

DB COMMIT前にWorkerが停止した場合、Messageは削除されず再配送される。COMMIT後DeleteMessage前にWorkerが停止した場合、重複Messageを受信したWorkerは`COMPLETED`を確認して、OCRとDB保存を再実行せずACKする。

有効な別Workerが処理中の場合はACKしない。先行Workerの失敗時にMessageを再配送し、lease期限後に再claimできるようにする。statement自体が削除済みで存在しない場合は、同じIDで処理が再開する見込みがないため追加処理なしでACKする。

## Transaction内の重複防止

`transactions`の`UNIQUE(statement_id, line_number)`を最後の重複防止境界にする。同じlineを再保存する場合は次の値を更新する。

- transaction date
- merchant raw/name
- amount
- category/subcategory

取引INSERTとstatementの`COMPLETED`更新は同一Transactionで行う。途中で失敗した場合、一部の取引だけが残らない。

完了時には次の値をクリアする。

- `processing_lease_expires_at`
- `processing_token`
- `failure_code`
- `failure_message`

`processing_started_at`は処理時間の確認に利用するため保持する。

## 失敗シナリオ

| シナリオ | DB状態 | Message |
|---|---|---|
| claim前に停止 | `QUEUED` | 再配送・再claim |
| statementが削除済み | なし | 追加処理なしでACK |
| claim後、OCR前に停止 | `PROCESSING` | lease期限後に再claim |
| OCR後、COMMIT前に停止 | `PROCESSING` | lease期限後に再claim |
| COMMIT後、Delete前に停止 | `COMPLETED` | 重複MessageをskipしてACK |
| 有効な別Workerを検出 | 先行Workerの`PROCESSING` | ACKしない |
| tokenを失った旧Worker | 新Workerのtoken | RollbackしてACKしない |
| S3/Bedrock/DB失敗 | `PROCESSING` | ACKしない |

Phase 8ではS3・Bedrock・DBのエラーをretryable/permanentに分類せず、`FAILED`へ変更しない。失敗コード、最大Receive回数、DLQへの移動はPhase 9で設計する。

## テスト境界

- 2つのWorkerの同時claimで1つだけ成功する
- lease期限切れのWorkerを再claimできる
- 旧tokenが新Workerの処理を上書きできない
- Transaction途中の失敗で取引と状態がRollbackされる
- `COMPLETED`の重複MessageでS3・Bedrockを呼ばない
- COMMIT前の失敗でDeleteMessageを呼ばない
- COMMIT後にだけDeleteMessageを呼ぶ
