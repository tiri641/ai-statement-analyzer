# Phase 2: Database 実装Plan

## 目的

ローカルPostgreSQLに、クレカ明細と取引情報を保存するためのDB構造を追加する。

Phase 2では、Migration、`statements` / `transactions`、DB制約、Index、Repository、DB Transactionを扱う。S3、SQS、Bedrock、ECS、業務APIは実装しない。

## 採用した設計判断

- DB Library: `pg`。SQL、bind parameter、Transaction、`RETURNING`を直接学ぶため。
- Migration: バージョン付きSQL + `pg`を使った薄い実行器。Migrationの適用履歴を`schema_migrations`へ保存する。
- `owner_id`: 認証未実装のためNULL許可で追加する。将来、認証導入時にNOT NULL化する。
- 金額: 支出を正数、返金を負数で保存する。`SUM(amount)`で実質支出を計算できるようにする。
- `subcategory`: Phase 2ではNULL許可とし、カテゴリとサブカテゴリの対応は後続PhaseのBackend / Zodで検証する。

## 実装対象

### Migration

```text
migrations/
├── 001_create_statements.sql
└── 002_create_transactions.sql
```

- Migrationはファイル名の番号順に実行する。
- 適用済みMigrationは再実行しない。
- 1回の実行をDB Transactionで囲み、失敗時はMigration記録とDDLをRollbackする。

### statements

- `id uuid PRIMARY KEY`
- `owner_id uuid NULL`
- `s3_key text NOT NULL UNIQUE`
- `target_month date NOT NULL`
- `status text NOT NULL`
- 処理時刻、失敗コード、失敗メッセージ、作成・更新時刻
- statusは`UPLOAD_PENDING`、`UPLOADED`、`QUEUED`、`PROCESSING`、`COMPLETED`、`FAILED`だけを許可する。

### transactions

- identity列の`id`をPrimary Keyにする。
- `statement_id`から`statements.id`へのForeign Keyを設定する。
- 親削除時は`ON DELETE CASCADE`で関連取引も削除する。
- `UNIQUE(statement_id, line_number)`で明細内の行重複を防ぐ。
- `line_number > 0`、`amount <> 0`をDBで検証する。

### Index

以下の必要最小限のIndexを追加する。

- `statements(target_month, status)`
- `transactions(transaction_date)`
- `transactions(merchant_name)`
- `transactions(category)`

UNIQUE制約が作るIndexと同じ目的のIndexは追加しない。

### Repository

`pg`のPoolを利用し、次の操作を提供する。

- statement作成・取得・状態更新
- statementに紐づくtransaction取得
- 複数transactionの保存とstatementの`COMPLETED`更新

DB値はすべてbind parameterで渡す。複数transaction保存と完了更新は同じDB Transactionで処理し、失敗時は全体をRollbackする。

## TDDと完了条件

1. DB未実装のテストを先に追加し、Redを確認する。
2. Migration、Schema、Repositoryを追加してGreenにする。
3. SQLとRepositoryの重複を整理し、typecheck・build・testを再実行する。
4. Docker PostgreSQLへMigrationを適用し、Integration Testで制約とRollbackを確認する。
5. `learning/phase-02.md`へ処理フロー、障害時の挙動、理解確認を記録する。

完了時には、Migration再実行、Migration失敗時のRollback、Foreign Key違反、UNIQUE違反、CHECK違反、Transaction Rollback、ON DELETE CASCADE、Repository操作を確認する。
