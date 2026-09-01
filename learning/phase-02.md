# Phase 02: Database

## 状態

実装・動作確認済み。作業ブランチ: `phase-02/database`

## 開始前の説明

### 1. 今回何を作るのか

ローカルPostgreSQLへ、明細画像を表す`statements`テーブルと、OCRで抽出した取引を表す`transactions`テーブルを追加する。さらに、Migration実行器、Repository、制約、Index、DB Transactionを追加する。

### 2. なぜ必要なのか

後続Phaseで、S3に保存した画像の処理状態、OCR結果、月別集計の元データを保存する必要があるためである。保存先の構造と整合性ルールを先にDBへ定義しておくことで、アプリケーションのif文だけに依存せず、DB自身でも不正データを拒否できる。

### 3. Application / DB内部で何が起きるのか

```text
npm run migrate
  ↓
Migration実行器
  ↓
schema_migrationsで適用済みか確認
  ↓
番号順のSQLを実行
  ↓
PostgreSQLのTable / Constraint / Index
```

Repositoryでは、SQLの値をbind parameterで渡す。複数の取引INSERTとstatementの`COMPLETED`更新は、同じDB Transactionで実行する。途中で失敗した場合はRollbackし、取引だけが保存される状態を作らない。

### 4. 他の選択肢

- Prisma Migrate: ORMとMigrationの生産性は高いが、今回のSQL、Constraint、Transactionの学習が抽象化される。
- Kysely: TypeScriptの型安全なSQLを書きやすいが、今回のMVPではSQLの仕組みを直接確認する方を優先する。
- `node-pg-migrate`: Migration機能を利用できるが、今回は薄い実行器を自分で実装して適用履歴とRollbackを理解する。
- DBへ接続せずFake Repositoryだけでテストする: 速いが、Foreign KeyやUNIQUEなどPostgreSQLの動作を確認できない。

### 5. なぜ今回の方式を選ぶのか

DB Libraryは`pg`を採用する。SQL、bind parameter、`RETURNING`、DB Transactionを直接扱えるため、今回の学習目標に合っている。RepositoryのロジックはIntegration Testで実際のPostgreSQLに接続し、DB制約はDB自身で検証する。

## 作ったもの

- `migrations/001_create_statements.sql`
- `migrations/002_create_transactions.sql`
- `src/database/migrate.ts`
- `src/migrate.ts`
- `src/database/statement-repository.ts`
- `test/database.test.ts`
- `npm run migrate`
- `npm test`でPhase 1とPhase 2のテストを実行する構成

## DB構造

### statements

明細画像のS3 key、対象月、処理状態を保存する。`owner_id`は認証未実装のためNULLを許可した。

statusは次の値だけを許可する。

```text
UPLOAD_PENDING
UPLOADED
QUEUED
PROCESSING
COMPLETED
FAILED
```

### transactions

OCRで抽出した明細行を保存する。金額は支出を正数、返金を負数とする。`SUM(amount)`で返金を含む実質支出を計算するためである。

```text
statements 1 ─── N transactions
```

## データフロー

```text
Migration SQL
  ↓
PostgreSQL Schema
  ↓
StatementRepository.create
  ↓
statements INSERT
  ↓
StatementRepository.saveTransactionsAndComplete
  ↓
BEGIN
  ↓
transactions INSERT
  ↓
statements.status = COMPLETED
  ↓
COMMIT
```

## TDDの記録

### Red

Migration実行器とRepositoryがまだ存在しない状態で、Migration、制約、Repository、Rollbackのテストを先に追加した。`npm test`は`src/database/migrate.ts`が存在しないため失敗した。

### Green

Migration実行器、SQL Schema、Repositoryを追加した。最初の実装確認では、Node.jsのTypeScript strip-only実行がparameter propertyに対応していないことと、`pg`の型制約が見つかったため修正した。その後、PostgreSQLへMigrationを適用し、Integration Testを成功させた。

### Refactor

- Migrationファイルの実行順を文字列順ではなく番号順にした。
- Migration失敗時のRollbackを実装した。
- RepositoryのDB行をアプリケーション型へ変換した。
- DBエラー時にMigrationの詳細をCLI出力へ含めないようにした。
- 共通Repository層やDIコンテナなど、Phase 2に不要な抽象化は追加しなかった。

## 重要コード

- `src/database/migrate.ts`: Migration履歴を確認し、未適用SQLをTransaction内で実行する。
- `migrations/001_create_statements.sql`: 明細状態とS3 keyの制約を定義する。
- `migrations/002_create_transactions.sql`: Foreign Key、複合UNIQUE、CHECK、Indexを定義する。
- `src/database/statement-repository.ts`: statementとtransactionの登録・取得・状態更新を行う。
- `saveTransactionsAndComplete`: 取引保存と`COMPLETED`更新を同じTransactionにまとめる。

## 動作確認結果

以下を実行し、成功した。

```bash
DATABASE_URL=postgresql://app:local_dev_password@127.0.0.1:5432/statement_analyzer npm run migrate
DATABASE_URL=postgresql://app:local_dev_password@127.0.0.1:5432/statement_analyzer npm test
npm run typecheck
npm run build
docker compose config
```

Integration Testでは、Migration再実行、Migration失敗時のRollback、Index、statement作成・取得・状態更新、S3 key重複、status違反、Foreign Key違反、取引行重複、line number違反、amount違反、Transaction成功、Transaction Rollback、ON DELETE CASCADEを確認した。

## 障害時の挙動

### Migration中にSQLが失敗した場合

Migration実行器はDB TransactionをRollbackする。`schema_migrations`へ適用済みとして記録されず、同じMigrationを修正して再実行できる。

### Repositoryの取引保存中に失敗した場合

`transactions`のINSERTとstatementの`COMPLETED`更新をRollbackする。先に保存された取引があっても残らず、statementは`PROCESSING`のままになる。WorkerのRetryや`FAILED`更新は後続Phaseで追加する。

### 同じ取引行を登録した場合

`UNIQUE(statement_id, line_number)`によりDBが拒否する。Phase 2では重複を自動更新せず、Phase 8でSQS重複配送に対する冪等処理と`ON CONFLICT`方針を実装する。

### 親statementを削除した場合

Foreign Keyの`ON DELETE CASCADE`により関連するtransactionsも削除される。運用上、処理済みデータを削除する場合はこの影響を理解したうえで実行する必要がある。

## Security

- Repositoryはbind parameterを使い、SQL文字列へ値を直接連結しない。
- `s3_key`だけを保存し、画像本体やカード番号はPhase 2のDBへ保存しない。
- DBのfailure messageや接続情報をMigration CLIの出力へ含めない。
- `owner_id`は将来の認証・所有者分離のために用意するが、Phase 2では認証を実装していない。
- ローカルDBのパスワードは開発用であり、本番ではSecrets Managerを使用する。

## Cost

Phase 2ではAWSリソースを作成していないため、ECS、RDS、S3、SQS、Bedrock、NAT GatewayなどのAWS料金は発生しない。PostgreSQLはローカルDockerで実行し、データはローカルNamed Volumeに保存する。

## 理解確認

### 1. Migrationを使う理由は何か

DB Schemaの変更を番号順の履歴として管理し、誰がどの順番で変更を適用したかを再現できるようにするためである。`schema_migrations`によって適用済みMigrationも判断できる。

### 2. UNIQUE制約をアプリケーションコードだけでなくDBにも置く理由は何か

複数Workerや別の処理が同時にINSERTしても、最終的な整合性をDBが保証できるためである。アプリケーションのif文だけでは、確認とINSERTの間の競合を防げない。

### 3. Foreign Keyは何を守るか

`transactions.statement_id`が、実際に存在する`statements.id`を参照することを守る。存在しない明細に取引だけを登録する状態を防ぐ。

### 4. `UNIQUE(statement_id, line_number)`が必要な理由は何か

1つの明細の同じ行を二重登録しないためである。statement全体ではなく、statement内の行番号との組み合わせを一意にする。

### 5. Rollback後に何が残るか

同じDB Transaction内で行ったINSERTやUPDATEは残らない。今回のテストでは、最初の取引INSERTが成功しても、2件目の重複で失敗すると最初の取引も消え、statementは`PROCESSING`のままになる。

### 6. `ON DELETE CASCADE`は何をするか

親であるstatementを削除したとき、Foreign Keyで紐づくtransactionsも自動的に削除する。便利だが、親削除が子データ削除にもなるため、削除操作には注意が必要である。

### 7. Indexが必要な理由は何か

月別、日付、merchant、categoryで検索・集計するときに、全行を毎回調べる負荷を減らすためである。ただしIndexはINSERTやUPDATE、ストレージにもコストがあるため、必要なものだけ作る。

### 8. なぜ金額を支出正・返金負で保存するのか

支出と返金を別の計算規則にせず、SQLの`SUM(amount)`で実質的な支出を計算できるためである。金額の計算は後続のBackend / SQLで行い、LLMには任せない。

### 9. なぜ`owner_id`をNULL許可で開始するのか

Phase 2では認証がまだなく、実在するユーザーIDを設定できないためである。列自体は先に用意し、認証導入時にNOT NULL化と全queryへの所有者条件追加を行う。

### 10. なぜPhase 2ではSQSやBedrockを実装しないのか

Phaseごとに責務を限定し、まずDBのSchema、制約、Transactionを単独で理解・検証するためである。非同期処理やAI処理を同時に追加すると、どの層の問題か切り分けにくくなる。

## Phase 2で扱わなかったもの

S3、SQS、Bedrock、ECS Worker、Atomic claim、processing lease、processing token、API業務Endpoint、月別Analyticsは後続Phaseで扱う。
