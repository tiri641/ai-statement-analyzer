# Security

Securityの正本は [../SECURITY_DESIGN.md](../SECURITY_DESIGN.md)。

- API、Worker、ECS execution roleを分離。
- APIはS3 Put signing、SQS Send、DB secretだけ。
- WorkerはSQS Receive/Delete/Visibility、S3 Get、Bedrock Invoke、DB secretだけ。
- RDSはprivate、SGはAPI / Workerから5432のみ。
- S3はprivate、Block Public Access、暗号化、短期Presigned URL、Lifecycle。
- FrontendにAWS credentialsを置かない。
- ログへ画像、カード番号、Presigned URL、raw AI responseを出さない。
- 認証なしのLocal MVPを公開しない。
- Phase 3では認証が未実装のため、APIはloopback host以外で起動しない。公開前に認証Middlewareとowner_idによる所有者チェックを追加する。
