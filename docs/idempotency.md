# Idempotency

冪等性は「同じMessageを複数回処理しても最終状態が1回分になる」性質である。

- SQS重複配送にはDBのAtomic claimで同時処理を1 Workerへ限定する。
- Worker停止後の再配送にはstatement statusとleaseを再確認する。
- transactionsにはUNIQUE(statement_id, line_number)を置く。
- OCR保存とCOMPLETED更新は同じDB Transactionにする。
- Transactionの冒頭でもprocessing tokenとleaseを確認し、leaseを失った古いWorkerが取引INSERTを残さないようにする。
- DB COMMIT後のDeleteMessageを守る。

DB COMMIT前の停止は再処理、COMMIT後Delete前の停止は再配送後skip、PROCESSING停止はlease期限後再claimとなる。
