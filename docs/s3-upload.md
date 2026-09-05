# S3 Upload

## Phase 4の構成

S3バケットはCDKの`StorageStack`で作成・管理する。Phase 4ではS3だけをデプロイし、VPC、ECS、ALB、SQS、Bedrockは作成しない。Phase 13では、このバケットを再作成せず参照する。

```text
Frontend
  │ POST /statements
  ▼
API ── Presigned PUT URL ──▶ Frontend
                              │ PUT image
                              ▼
                             S3
                              │
Frontend ── upload/complete ─▶ API ── HeadObject ──▶ S3
                                      │
                                      ▼
                                  PostgreSQL
```

## バケット設定

- private bucket
- Block Public Accessの4項目を有効化
- SSE-S3（AES256）
- HTTPSを強制
- TLS 1.2未満を拒否
- `statements/`の画像を7日後に削除
- 不完全なMultipart Uploadを1日後にabort
- CORSは`http://localhost:5173`からのPUTと`content-type`ヘッダーだけを許可
- `RemovalPolicy.RETAIN`

バケット名はCDKが生成し、Outputの`S3BucketName`で確認する。固定名を使わないため、名前の衝突や名前への環境情報の埋め込みを避ける。

## CDK操作

AWS CLI ProfileまたはSSOを設定し、東京リージョンを選択する。

```bash
npm run cdk:synth
npm run cdk:diff:storage
npm run cdk:deploy:storage
```

初回のAWSアカウントでは、CDK bootstrapが必要になる場合がある。bootstrapが作るリソースにも費用や権限があるため、対象アカウントとリージョンを確認して実行する。

このPhaseの`StorageStack`はS3リソースだけを管理し、アプリケーションのAssetを持たない。そのため、CDK bootstrap versionを確認するためのSSM参照をテンプレートへ追加しない設定にしている。CDK bootstrap自体は必要であり、テンプレートの発行先S3とCloudFormation実行Roleはbootstrapで作成されたものを使用する。Assetを追加するPhaseでは、この設定を無条件に引き継がず、bootstrap互換性の検査と必要権限を改めて設計する。

デプロイ後、Outputのバケット名を未commitの`.env`へ設定する。

```dotenv
AWS_REGION=ap-northeast-1
S3_BUCKET_NAME=<CDK OutputのS3BucketName>
S3_PRESIGNED_URL_EXPIRES_SECONDS=300
S3_RAW_RETENTION_DAYS=7
```

## Presigned URL

`POST /statements`は、サーバーが生成した次のkeyに対するPUT URLを返す。

```text
statements/{statementId}/source
```

FrontendへAWS Credentialsは渡さない。URLの有効期限は300秒で、`Content-Type`を署名する。Frontendはレスポンスの値をそのままPUTへ使用する。

```bash
curl -X PUT \
  -H "Content-Type: image/jpeg" \
  --upload-file sample.jpg \
  "<Presigned URL>"
```

署名時とPUT時のContent-Typeが異なる場合、S3は署名不一致として拒否する。Presigned URLはBearer Tokenなので、URL自体をログやエラーメッセージに出さない。

同じPresigned URLは有効期限内に複数回使用でき、同じkeyへPUTするとObjectが上書きされる。今回の完了確認では、最後にS3へ保存されたObjectのMetadataを確認する。

## アップロード完了確認

PUT成功後、Frontendは次を呼ぶ。

```text
POST /statements/{id}/upload/complete
```

APIはS3 `HeadObject`で以下を確認する。

- Objectが存在する
- S3のContent-TypeがDBの期待値と一致する
- S3のContent-LengthがDBの期待値と一致する

API Roleには対象Objectの`s3:GetObject`に加えて、未存在Objectを404として判定するための`s3:ListBucket`を`statements/` prefixのCondition付きで付与する。S3のHeadObjectは、ListBucket権限がないと未存在でも403になる場合がある。これはObject内容を一覧表示する権限を無制限に付与することとは異なり、prefixを限定した最小権限にする。

一致した場合だけ、次の条件付き更新を行う。

```sql
UPDATE statements
SET status = 'UPLOADED', updated_at = NOW()
WHERE id = $1
  AND status = 'UPLOAD_PENDING'
```

`UPLOADED`以降で再度呼ばれた場合は、S3を再確認せず現在の状態を返す。Phase 5の解析開始とSQS投入は、このEndpointでは行わない。

## エラー

| 状況 | HTTP | code |
|---|---:|---|
| UUID不正 | 400 | `INVALID_REQUEST` |
| statement不存在 | 404 | `STATEMENT_NOT_FOUND` |
| S3 Object不存在 | 404 | `UPLOAD_NOT_FOUND` |
| Metadata不一致 | 409 | `UPLOAD_METADATA_MISMATCH` |
| FAILED状態 | 409 | `STATEMENT_NOT_UPLOADABLE` |
| S3 / DB / ネットワーク障害 | 503 | `DEPENDENCY_UNAVAILABLE` |

S3確認やDB更新に失敗した場合、DB statusは`UPLOAD_PENDING`のままにする。次回の完了確認で再試行できる。

## 保持と削除

画像は7日後にLifecycleで削除される。`RemovalPolicy.RETAIN`はStack削除時の誤削除を防ぐ設定であり、バケット料金を自動で止める設定ではない。学習終了時は、不要な画像がないことを確認してからバケットを手動削除する。

## 参照

- [S3 Presigned URL](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [Presigned URL Upload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html)
- [S3 CORS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html)
- [AWS CDK BlockPublicAccess](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3.BlockPublicAccess.html)
- [S3 HeadObjectの必要権限](https://docs.aws.amazon.com/cli/latest/reference/s3api/head-object.html)
