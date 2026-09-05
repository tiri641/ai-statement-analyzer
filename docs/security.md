# Security

Securityの正本は [../SECURITY_DESIGN.md](../SECURITY_DESIGN.md)。

- API、Worker、ECS execution roleを分離。
- APIはS3 Put signing、SQS Send、DB secretだけ。Phase 5ではSQS Queue URLを環境変数から読み、FrontendへAWS Credentialsを渡さない。
- WorkerはSQS Receive/Delete/Visibility、S3 Get、Bedrock Invoke、DB secretだけ。
- RDSはprivate、SGはAPI / Workerから5432のみ。
- S3はCDKでprivate、Block Public Access、SSE-S3、HTTPS強制、TLS 1.2以上、7日Lifecycleを設定する。
- S3のCORSは許可したFrontend OriginからのPUTだけに限定する。Phase 4ではlocalhost Originを使用する。
- `RemovalPolicy.RETAIN`でStack削除時の誤削除を防ぐ。不要なバケットは内容を確認してから手動削除する。
- `HeadObject`の未存在を404として扱うため、API Roleの`s3:ListBucket`は`statements/` prefixのCondition付きに限定する。`s3:ListAllMyBuckets`は付与しない。
- FrontendにAWS credentialsを置かない。
- ログへ画像、カード番号、Presigned URL、raw AI responseを出さない。
- 認証なしのLocal MVPを公開しない。
- Phase 4では認証が未実装のため、APIはloopback host以外で起動しない。公開前に認証Middlewareとowner_idによる所有者チェックを追加する。
