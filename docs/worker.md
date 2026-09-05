# Worker

## Phase 5との関係

Phase 5ではECS Worker Serviceはまだ作成していない。Phase 5の最小ConsumerはSQSのReceive / Validation / Delete境界を確認するためのもので、S3取得やBedrock呼び出しは行わない。WorkerはSQSではなく、SQSからMessageを受け取って業務処理を実行するアプリケーションである。

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
