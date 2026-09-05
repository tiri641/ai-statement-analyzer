# Database Reference

正本は [../DATABASE_DESIGN.md](../DATABASE_DESIGN.md)。

- statementsがUploadからOCR完了までの状態を持つ。
- transactionsはstatement_idとline_numberをUNIQUEにする。
- amountは円整数、集計はSQLのSUM / COUNT / GROUP BYを正とする。
- Atomic claimはstatusとleaseを条件にし、processing_tokenで古いWorkerの更新を防ぐ。
- OCR保存はTransaction内で行い、COMMIT後にSQSをDeleteする。
- 月次Insights cacheはPhase 11で追加し、model / prompt / analytics versionをkeyに含める。

初期Indexは対象月・日付・merchant・categoryと一意制約の必要最小限にする。認証導入時はowner_idを全queryへ追加する。

## Phase 2・3の実装

Phase 2では、番号付きSQLを`pg`で読み込むMigration実行器と、`statements` / `transactions`を追加した。Migrationの適用履歴は`schema_migrations`に保存し、1回のMigration実行をDB Transactionで囲んでいる。

```bash
npm run migrate
```

`statements`には明細の対象月、S3 key、OCR処理状態、Content-Type、Content-Lengthを保存する。`transactions`にはOCRで抽出した取引を保存する。status、Content-Type、Content-Length、`line_number`、`amount`の不正値はDBのCHECK制約で拒否し、`statement_id`のForeign Keyと`UNIQUE(statement_id, line_number)`で参照整合性と行重複を防ぐ。

Migration 003は、既存statementの画像からContent-Typeとサイズを安全に復元できないため、既存statementがあるDBでは仮値を入れずに失敗する。実データがある環境では、適用前にバックアップを取得し、再アップロードまたは別途データ移行方針を決める。

`StatementRepository`の`saveTransactionsAndComplete`は、取引INSERTとstatementの`COMPLETED`更新を同じTransactionで実行する。途中でエラーになった場合は全体をRollbackし、一部の取引だけが残らない。

Phase 2・3の詳細な実装判断と学習記録は [learning/phase-02.md](../learning/phase-02.md) と [learning/phase-03.md](../learning/phase-03.md) を参照する。
