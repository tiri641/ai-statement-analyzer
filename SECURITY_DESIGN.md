# SECURITY_DESIGN.md

## セキュリティ目標

クレジットカード明細画像を高機密データとして扱う。ただし分析に不要なカード番号、セキュリティコード、口座番号は保存しない。画像は短期保持し、AI出力・ログ・APIレスポンスへ不要な原文を流さない。

## Trust Boundary

```
Browser
  - untrusted file and user input
  - no AWS credentials
        |
        | HTTPS / short-lived Presigned PUT
        v
ALB -> ECS API
        |  DB / SQS
        v
ECS Worker -> private S3 / Bedrock / PostgreSQL
```

- Browserから届くファイル名、Content-Type、サイズ、年月、statementIdは信頼しない。
- Presigned URLはbearer tokenであり、取得者はURLの有効期間中PUTできる可能性がある。TTLを5〜10分にし、短い有効期限をS3側条件でも補強する。
- S3 keyはサーバー生成のUUIDベースにし、ユーザー入力をpath traversalやtenant越境に使わない。

## IAM Role

### API Task Role

Resource ARNを対象bucket、queue、secretに限定する。

- S3: Presigned PUTの署名対象となる s3:PutObject、upload確認用の対象keyへの s3:GetObject。S3 APIのHeadObjectは独立したIAM actionではなくGetObjectで認可されるため、実装ではkey prefixを狭くする。画像本文をAPIで読む必要がなければ、HeadObject確認をWorkerへ寄せてAPIのGetObjectを外す案も比較する。
- SQS: main queueへの sqs:SendMessage
- Secrets Manager: DB secret 1件への secretsmanager:GetSecretValue
- 必要時のみKMS keyへのEncrypt / GenerateDataKey

APIは s3:GetObject や bedrock:InvokeModel を持たない。APIが画像を読んだりOCRしたりしないからである。

### Worker Task Role

- SQS: main queueへの sqs:ReceiveMessage、sqs:DeleteMessage、sqs:ChangeMessageVisibility、必要な sqs:GetQueueAttributes
- S3: private bucketの対象prefixへの s3:GetObject、s3:HeadObject
- Bedrock: 許可したモデルの bedrock:InvokeModel。Converse実行時も必要なResource条件を確認する
- Secrets Manager: DB secret 1件への secretsmanager:GetSecretValue
- SSE-KMSを採用する場合: 画像暗号化に使うKMS keyのDecrypt

Workerは s3:PutObject、SQS SendMessage、管理者権限を持たない。

### ECS Task Execution Role

ApplicationのTask Roleと混同しない。ECS AgentがECRからimageをpullし、CloudWatch Logsへログを送り、Secrets Managerのsecret injectionを使う場合の実行権限を持つ。少なくともECR pull、CloudWatch Logs stream / put、必要なsecret取得だけにする。

### 禁止

- AdministratorAccess
- APIとWorkerでの同一Task Role共有
- Resource: "*" の常用（サービスが要求する例外は理由と範囲を記録）
- IAM user access keyをFrontendやimageに埋め込むこと

## S3

- Block Public Accessを4項目すべて有効にする。
- bucket policyでpublic Principalを拒否し、TLS未使用のリクエストを拒否する。
- SSE-S3をLearningの既定にして権限を単純化する案、SSE-KMS customer managed keyをProduction-likeに採用する案を比較する。
- SSE-KMSではPresigned PUTのsigned headers、KMS key policy、API signerのKMS権限を検証する。設定ミスでアップロードを壊さない。
- PutObjectに必要なContent-Type等を署名し、許可Content-Type・size上限をAPIとS3側で二重に検査する。
- 未完了multipart uploadはLifecycleで早期abortする。
- 原画像prefixは処理完了後、または作成後の最大保持日数で自動削除する。推奨MVPは30日、厳格な保持縮小案は7日。
- FrontendからのS3 PUTはS3のRegional HTTPS endpointを使う。Bucketはprivateのままにする。

## Network / Security Group

- ALB Security Group: Internetから443（必要なら80 redirect）のみ。
- API / Worker Security Group: ALBからAPIのport、必要なAWS endpointへのegressのみ。
- RDS Security Group: API / Worker SGからPostgreSQL port 5432のみ。InternetからのInboundは0。
- RDSはPrivate Subnet、Publicly accessible false、暗号化有効、backup retentionを設定する。
- VPC Flow Logsはコストと情報量を考慮し、Production-likeで有効化を検討する。

## HTTPS / CORS / HTTP

- ALBでACM証明書を使いHTTPSを終端する。HTTPはHTTPSへredirectする。
- CORSはFrontendの固定originだけを許可し、wildcardとcredentialsの併用を避ける。
- APIはJSON body、画像metadata、queryをサイズ・文字数・列挙値で制限する。
- Content-Typeだけを信用せず、Workerが画像magic bytes / decoderで再確認する。
- 本番公開時は認証・所有者チェックを必須とする。認証なしの単一ユーザーMVPはlocalhostまたは閉じた学習環境に限る。
- Phase 3のAPIは認証が未実装のため、`HOST`が`127.0.0.1`、`::1`、`localhost`以外の場合は起動を拒否する。この制限は認証Middlewareと`owner_id`条件を実装した後に見直す。

## Secrets

- DB接続情報はSecrets Managerに置く。環境変数へ平文でコミットしない。
- secret rotationを採用する場合、connection pool再接続との整合を確認する。
- CloudFormation / CDKのoutput、ログ、エラーメッセージにsecretやPresigned URLを出さない。

## Logging / Data Minimization

構造化JSONで以下の安全なmetadataだけを記録する。

- requestId、statementId、messageIdのhashまたはAWS IDの必要部分
- event、status、durationMs、receiveCount、errorCode
- modelId、promptVersion、analyticsVersion

記録しないもの:

- カード番号、セキュリティコード、口座番号
- 明細画像のBase64、Presigned URL、Authorization header
- raw Bedrock request / response全文
- merchantRawの大量出力（必要なら短い監査用値をマスキング）

ログ出力値には改行、制御文字、秘密情報のredactionを適用する。CloudWatch Logsのretentionを無期限にしない。

## AI固有の防御

- OCR応答はJSON parse後、Zodで必須フィールド、日付、金額、merchant、カテゴリを検証する。
- category / subcategoryは許可リスト外を拒否する。
- Bedrockの説明文はFrontendへそのまま信頼して返さず、Insights schemaと文字数を検証する。
- Insights promptにはSQLで確定した集計値だけを渡し、指示文として扱うmerchant等の文字列をdelimiterで囲む。
- LLMにSQL実行権限、DB credentials、秘密情報を渡さない。
- AIの提案は支出の解釈であり、金融助言や自動決済ではないことをUIに示す。

## 脅威と対策

| 脅威 | 対策 |
|---|---|
| 公開bucketから画像漏洩 | Block Public Access、private bucket、短期Presigned URL |
| URL漏洩後の不正PUT | TTL短縮、署名header固定、S3条件、ログに出さない |
| 巨大・偽装ファイル | API size制限、S3確認、Worker decoder、timeout |
| tenant越境 | 認証、owner_id、全queryの所有者条件 |
| IAM権限過多 | API / Worker / execution roleを分離、resource限定 |
| SQL injection | parameterized query、query builderでもSQL確認 |
| AI prompt injection | OCR入力を命令として扱わない、schemaとpolicyで検証 |
| ログからのカード情報漏洩 | redaction、raw response禁止、短いretention |
| DDoS / abuse | rate limit、ALB/WAFの採否、公開前に認証 |

## Decision Required

- LearningはSSE-S3、Production-likeはSSE-KMSとするか。
- 認証をCognito等でPhase 13までに導入するか。
- WAF、VPC Flow Logs、GuardDutyをMVPから有効化するか。学習対象を増やしすぎないため、MVPは認証、SG、TLS、S3、IAM、Logs maskingを優先する。
