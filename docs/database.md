# Database Reference

正本は [../DATABASE_DESIGN.md](../DATABASE_DESIGN.md)。

- statementsがUploadからOCR完了までの状態を持つ。
- transactionsはstatement_idとline_numberをUNIQUEにする。
- amountは円整数、集計はSQLのSUM / COUNT / GROUP BYを正とする。
- Atomic claimはstatusとleaseを条件にし、processing_tokenで古いWorkerの更新を防ぐ。
- OCR保存はTransaction内で行い、COMMIT後にSQSをDeleteする。
- 月次Insights cacheはPhase 11で追加し、model / prompt / analytics versionをkeyに含める。

初期Indexは対象月・日付・merchant・categoryと一意制約の必要最小限にする。認証導入時はowner_idを全queryへ追加する。

