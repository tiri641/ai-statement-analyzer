# Worker

Workerの基本ループ:

1. graceful shutdown中でなければSQS Long Polling。
2. statementIdをValidation。
3. DBでAtomic claim。処理中の別Workerはskipする。
4. S3からimageを取得し、Bedrock OCRを呼ぶ。
5. Zod検証。
6. DB Transactionでtransactions保存とCOMPLETED更新。
7. COMMIT後だけDeleteMessage。

SIGTERM受信後は新規Receiveを止め、実行中処理の終了またはvisibility延長を待つ。ECS stopTimeout後に終了しても、Messageを先にDeleteしていなければ再配送される。

Lease期限を超えそうならChangeMessageVisibilityとDB leaseをheartbeatで延長する。Workerが永久停止した場合はlease expiry後に別Workerが再claimする。

