# Phase 04 Plan: S3アップロードとPresigned URL

## 目的

Phase 4では、画像本体をAPIへ送らず、FrontendからS3へ直接アップロードする仕組みを作る。

```text
Frontend
  ↓ POST /statements
API
  ↓ Presigned PUT URL
Frontend
  ↓ PUT
S3
  ↓ POST /statements/{id}/upload/complete
API
  ↓ HeadObject
PostgreSQL
  ↓ UPLOAD_PENDING → UPLOADED
```

S3バケットはPhase 4で最小構成のCDK `StorageStack`として管理する。VPC、ECS、ALB、SQS、BedrockはPhase 4では作成しない。Phase 13では、このバケットを再作成せず参照する。

## 採用する方式

- AWS実S3を使用し、API + curlで確認する。Frontend実装は行わない。
- AWS SDK v3のS3 ClientとPresignerを使用する。
- APIがUUIDベースのS3 key `statements/{statementId}/source`を作る。
- Presigned URLの有効期限は300秒とする。
- `Content-Type`を署名対象にし、実際のサイズはHeadObjectで確認する。
- S3はprivate、Block Public Access、SSE-S3、HTTPS強制、TLS 1.2以上にする。
- `statements/`の画像は7日後にLifecycleで削除する。
- 不完全なMultipart Uploadは1日後にabortする。
- Stack削除時のバケットは `RemovalPolicy.RETAIN` とし、誤削除を防ぐ。
- Frontend用Originだけを許可するCORSを設定する。

## 実装内容

### CDK

- `cdk.json`
- `infra/bin/app.ts`
- `infra/lib/storage-stack.ts`
- `tsconfig.infra.json`

`StorageStack`からS3バケット名をCloudFormation Outputへ出力する。バケット名は固定しない。ローカルAPIへはOutputを未commitの `.env` に設定する。

### API

`POST /statements`を以下の順序で変更する。

1. 入力をZodで検証する。
2. statement IDとS3 keyを生成する。
3. Presigned PUT URLを発行する。
4. `UPLOAD_PENDING`のstatementをDBへ保存する。
5. URLとS3へ送るContent-Typeを返す。

```json
{
  "statementId": "019abc...",
  "status": "UPLOAD_PENDING",
  "upload": {
    "method": "PUT",
    "url": "https://...",
    "headers": { "Content-Type": "image/jpeg" },
    "expiresInSeconds": 300
  }
}
```

`POST /statements/{id}/upload/complete`を追加する。

- `UPLOAD_PENDING`ならHeadObjectで画像の存在、Content-Type、Content-Lengthを確認する。
- 全て一致した場合だけ条件付きUPDATEで`UPLOADED`へ変更する。
- `UPLOADED`以降は現在の状態を返し、同じ完了要求を冪等に扱う。
- S3オブジェクトなしは404、Metadata不一致は409、AWS/DB障害は503とする。
- S3確認やDB更新に失敗した場合、`UPLOAD_PENDING`を維持する。
- `FAILED`のstatementは409とする。

### DB

`markUploaded`を追加し、次のSQL条件を使う。

```sql
UPDATE statements
SET status = 'UPLOADED', updated_at = NOW()
WHERE id = $1
  AND status = 'UPLOAD_PENDING'
RETURNING ...
```

## TDD

1. Red: Presigned URL、HeadObject、Metadata比較、状態遷移、エラーの失敗テストを書く。
2. Green: Fake S3 AdapterとRepository実装でテストを通す。
3. Refactor: Route、S3 Adapter、DB Row、公開Response DTOの責務を整理する。
4. CDK Assertionsで非公開、暗号化、Lifecycle、CORS、RETAINを検証する。
5. AWS実S3ではcurlでPUTし、完了APIが`UPLOADED`を返すことを確認する。

## 対象外

- SQS、DLQ、解析開始API
- Bedrock、OCR、Worker
- Frontendアプリケーション
- VPC、ECS、ALB、RDSのCDK構築
- 認証とowner_idによる所有者チェック

## 完了条件

- `cdk synth`が成功する。
- `npm test`、`npm run typecheck`、`npm run typecheck:infra`、`npm run build`が成功する。
- Presigned URLで画像をS3へPUTできる。
- Content-TypeとContent-Lengthの不一致を拒否できる。
- `UPLOAD_PENDING`から`UPLOADED`へ一度だけ遷移する。
- AWS Credentials、S3 key、Presigned URLをFrontendの不要な情報やログへ出さない。
- Phase 4のデータフロー、障害時の挙動、Security、Cost、理解確認を`learning/phase-04.md`に記録する。
