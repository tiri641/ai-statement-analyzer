# DATABASE_DESIGN.md

## 方針

PostgreSQLのSQLとconstraintを中心に設計する。DB Libraryは、まず `pg`（node-postgres）を推奨する。SQL、bind parameter、Transaction、`RETURNING`、`ON CONFLICT`を直接扱えるため、今回の学習目標に合う。Migrationはバージョン付きSQLを`node-pg-migrate`等の薄い実行器で適用する。

Kyselyは型安全なSQLを書きたい場合の次点、PrismaはCRUDの生産性を優先する場合の代替とする。ORMを使っても、重要な集計・状態遷移・constraintは生成SQLを確認する。

## エンティティ

```text
statements 1 --- N transactions
```

### statements

| column | type | constraint / purpose |
|---|---|---|
| id | uuid | PK。APIが生成する推測困難なID |
| owner_id | uuid nullable | 認証導入時の所有者。認証を採用する場合はNOT NULLへ移行 |
| s3_key | text | NOT NULL、UNIQUE。S3 bucket名はDBに持たずkeyだけ保存 |
| target_month | date | NOT NULL。月初日に正規化して月単位検索に使う |
| content_type | text | NOT NULL。MVPではimage/jpegまたはimage/png |
| content_length | bigint | NOT NULL。1〜10MiB。S3 HeadObjectとの照合に使う |
| status | text | 許可された状態のみ |
| processing_started_at | timestamptz | claim開始時刻 |
| processing_lease_expires_at | timestamptz | stale PROCESSINGの再claim判定 |
| processing_token | uuid | 現Workerのclaimを識別するfencing token |
| processed_at | timestamptz | COMPLETED時刻 |
| failure_code | text nullable | 機械判定可能なエラー分類 |
| failure_message | text nullable | センシティブ値を含めない短い説明 |
| created_at | timestamptz | NOT NULL、UTC |
| updated_at | timestamptz | NOT NULL、UTC |

初期状態は `UPLOAD_PENDING` とする。ユーザーが必須とした基本状態に加え、Presigned URLを発行済みだがS3 PUT未完了の段階を表す。

```text
UPLOAD_PENDING -> UPLOADED -> QUEUED -> PROCESSING -> COMPLETED
                                      \-> FAILED
```

`FAILED`を自動的に`QUEUED`へ戻すのは、retryableかpermanentかを判定できる場合だけにする。運用者による再解析は、同じstatementの既存transactionsを消してから再投入するか、同一行をupsertするかを別途決める。

### transactions

| column | type | constraint / purpose |
|---|---|---|
| id | bigint generated always as identity | PK |
| statement_id | uuid | NOT NULL、FK `statements(id)` |
| line_number | integer | 1以上。statement内のOCR行番号 |
| transaction_date | date | NOT NULL |
| merchant_raw | text | OCRが読んだ表記。必要な範囲だけ保持 |
| merchant_name | text | 正規化後。集計キー |
| amount | bigint | 日本円の整数。返金を負数にする案を推奨 |
| category | text | 許可カテゴリ |
| subcategory | text | categoryに対応する許可値 |
| created_at | timestamptz | NOT NULL、UTC |

必須制約は以下である。

```sql
PRIMARY KEY (id)
FOREIGN KEY (statement_id) REFERENCES statements(id) ON DELETE CASCADE
UNIQUE (statement_id, line_number)
CHECK (line_number > 0)
CHECK (amount <> 0)
```

`category`と`subcategory`の対応関係は、DB CHECKを巨大化させず、Backendの共有カテゴリ定義 + Zod + service validationで保証する。DBへも厳密に許可値を持たせる必要が出た場合は、後からlookup tableを追加する。

### monthly_insights（Phase 11で追加）

Bedrockの未検証レスポンスをそのまま保存するためではなく、Zod検証済みの応答を再利用するキャッシュである。

| column | type | purpose |
|---|---|---|
| id | uuid | PK |
| owner_id | uuid nullable | 認証時の所有者 |
| year | integer | 対象年 |
| month | integer | 1〜12 |
| analytics_version | text | 集計仕様のバージョン |
| model_id | text | 生成モデル |
| prompt_version | text | promptのバージョン |
| response | jsonb | Zod検証済みのInsightsのみ |
| generated_at | timestamptz | 生成時刻 |
| created_at / updated_at | timestamptz | 管理用 |

同一の`owner_id, year, month, analytics_version, model_id, prompt_version`を一意にする。取引データが変わったときに古いcacheを返さないため、Phase 11でdata versionの扱いを決める。

## Index

過剰なIndexは書き込み・ストレージ・vacuumコストを増やすため、まず以下だけを作る。s3_keyと(statement_id, line_number)のUNIQUE制約は、PostgreSQLが作る一意Indexをそのまま利用し、同じ目的のIndexを重複作成しない。

```sql
CREATE INDEX statements_target_month_status_idx
  ON statements (target_month, status);
CREATE INDEX transactions_date_idx
  ON transactions (transaction_date);
CREATE INDEX transactions_merchant_name_idx
  ON transactions (merchant_name);
CREATE INDEX transactions_category_idx
  ON transactions (category);
```

`merchant_name`と`category`は集計・絞り込みの頻度を確認してから残す。月別Dashboardで`transaction_date`の範囲条件を使うため、日付Indexを基本とする。認証を採用したら`(owner_id, target_month)`や`(owner_id, transaction_date)`へ見直す。

## Atomic claim

SQSの重複配送に対して、Workerが最初に処理権を取得する。新規QUEUEDだけでなく、lease期限切れのPROCESSINGも再claimできる。

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
RETURNING id, s3_key, processing_token;
```

0行なら、別Workerが処理中、またはCOMPLETED / FAILEDの可能性がある。DBを再読込してterminal stateならMessageをackし、まだ有効なPROCESSINGならackせず短いvisibility延長またはskip方針を選ぶ。

leaseを更新する処理と完了更新には、必ず`processing_token = $token`を条件に入れる。古いWorkerが復帰して新しいWorkerの結果を上書きしないためである。処理時間がleaseを超える場合はheartbeatで期限を延長する。

## OCR結果保存Transaction

```sql
BEGIN;

-- leaseを失った古いWorkerはINSERTまで進めない
UPDATE statements
SET updated_at = NOW()
WHERE id = $statement_id
  AND status = 'PROCESSING'
  AND processing_token = $processing_token
  AND processing_lease_expires_at > NOW()
RETURNING id;

-- 上のRETURNINGが0行ならROLLBACKしてMessageを削除しない
-- 再処理時も同じstatement / line_numberを二重に作らない
INSERT INTO transactions (...)
VALUES (...)
ON CONFLICT (statement_id, line_number)
DO UPDATE SET
  transaction_date = EXCLUDED.transaction_date,
  merchant_raw = EXCLUDED.merchant_raw,
  merchant_name = EXCLUDED.merchant_name,
  amount = EXCLUDED.amount,
  category = EXCLUDED.category,
  subcategory = EXCLUDED.subcategory;

UPDATE statements
SET status = 'COMPLETED',
    processed_at = NOW(),
    processing_lease_expires_at = NULL,
    processing_token = NULL,
    failure_code = NULL,
    failure_message = NULL,
    updated_at = NOW()
WHERE id = $statement_id
  AND status = 'PROCESSING'
  AND processing_token = $processing_token;

COMMIT;
```

このTransactionがrollbackされたら、SQS Messageを削除しない。Visibility Timeout後に再配送され、再びclaimして保存する。COMMIT後に`DeleteMessage`することで、Delete前の停止は重複処理に留まり、Delete後の停止によるジョブ消失を避けられる。

## 失敗更新

permanent failureの場合は、処理権を持つWorkerだけが以下を実行する。

```sql
UPDATE statements
SET status = 'FAILED',
    failure_code = $failure_code,
    failure_message = $safe_message,
    processing_lease_expires_at = NULL,
    processing_token = NULL,
    updated_at = NOW()
WHERE id = $statement_id
  AND status = 'PROCESSING'
  AND processing_token = $processing_token;
```

`failure_message`に画像内容、Presigned URL、カード番号、AI response全文を含めない。

## Analytics SQL方針

- 対象月は`[month_start, next_month_start)`の半開区間で検索する。
- `COMPLETED` statementに属するtransactionsだけを対象にする。
- `SUM(amount)`、`COUNT(*)`、`GROUP BY category`、`GROUP BY merchant_name`をDBで計算する。
- 割合、前月比、平均単価はBackendで整数・Decimalの扱いを決めて丸める。LLMには渡しても、再計算を依頼しない。
- 前月の取引がない場合、前月比を`null`にする。

## Decision Required

- `owner_id`をPhase 1から入れるか、ローカル単一ユーザーとしてnullableで開始するか。
- 金額を「支出は正、返金は負」の符号付きにするか、`transaction_type`を追加するか。
- `ON CONFLICT DO UPDATE`で再処理結果を更新するか、`DO NOTHING`で最初のOCR結果を保持するか。推奨は、同じstatementの再処理を意図した操作に限りUPDATEする方式。
- `monthly_insights`をPhase 11で導入するか、最初はcacheなしで検証するか。

## 理解確認

1. なぜアプリケーションのif文だけでなくUNIQUE制約が必要か。DBが最後の整合性境界だからである。
2. Atomic claimの`RETURNING`が0行のとき、Workerは何を確認するか。現在のstatusとleaseを読み、処理中・完了・失敗を区別する。
3. なぜDB COMMITをSQS DeleteMessageより先にするか。Delete先行だとDB未保存のままMessageが消えるからである。
4. PROCESSINGで止まったstatementをどう救うか。lease期限とprocessing tokenを使って別Workerが再claimする。
5. なぜ集計結果をDB / Backendで作るか。金額の正確性と再現性をLLMの解釈から分離するためである。
