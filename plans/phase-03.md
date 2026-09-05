# Phase 3: API実装Plan

## 目的と範囲

Frontendから明細登録情報を受け取り、Zodで検証してPostgreSQLへ保存するAPIを実装する。

Phase 3ではS3へ画像を送信しない。S3 keyはAPI側で生成してDBへ保存するが、S3 Objectの作成や画像UploadはPhase 4で実装する。

実装対象:

- Zodによる入力検証
- `POST /statements`
- `GET /statements/{id}`
- APIとRepositoryの接続
- 400 / 404 / 409 / 413 / 503のエラー処理
- S3 Uploadに必要な情報のDB保存

実装対象外:

- S3 SDK
- Presigned URLの発行
- S3への画像PUT
- S3 `HeadObject`
- SQS、Bedrock、Frontend、認証

## S3 Uploadの前提

Phase 3では画像情報と画像本体を別々に扱う設計だけを準備する。

```text
Phase 3:
Frontend --POST /statements--> API
           画像情報だけ          ↓
                              PostgreSQL

Phase 4:
Frontend --PUT Presigned URL--> S3
           画像本体
```

APIは`statements/{statementId}/source`形式のkeyを生成する。このkeyを作成しても、S3にObjectは作成されない。Phase 4で同じkeyをPresigned URLに設定し、FrontendがURLへHTTP PUTすることでS3 Objectを作成する。

## API仕様

`POST /statements`は、対象月、filename、Content-Type、Content-Lengthを受け取る。filenameは検証するがS3 keyには使用しない。

Validation:

- `targetMonth`: `YYYY-MM`形式、年は2000〜2100、月は1〜12
- `fileName`: 1〜255文字
- `contentType`: `image/jpeg`または`image/png`
- `contentLength`: 1〜10MiBの整数
- 未知のフィールドは拒否する

Phase 3の成功Responseは次の形式とする。

```json
{
  "statementId": "019abc...",
  "status": "UPLOAD_PENDING",
  "upload": null
}
```

Phase 4で`upload`を次の値へ置き換える。

```json
{
  "upload": {
    "method": "PUT",
    "url": "https://signed-url...",
    "headers": {
      "Content-Type": "image/jpeg"
    },
    "expiresInSeconds": 600
  }
}
```

## Database変更

`migrations/003_add_upload_metadata.sql`で`content_type`と`content_length`を追加する。Phase 4でS3 `HeadObject`の結果と照合するために使用する。

```text
content_type text NOT NULL
content_length bigint NOT NULL
```

## Application設計

Hono Appへ次のRepositoryインターフェースを注入する。

```ts
interface StatementStore {
  create(input: CreateStatementInput): Promise<StatementRecord>;
  findById(id: string): Promise<StatementRecord | null>;
}
```

APIの単体テストではFake Repositoryを使用する。実際のPostgreSQLのMigrationとConstraintはIntegration Testで確認する。

エラーResponseは次の形式に統一する。

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "入力内容が不正です。"
  }
}
```

## TDD手順

1. APIテストを先に追加し、未実装によるRedを確認する。
2. Zod、Migration 003、Repository拡張、API Routeを追加してGreenにする。
3. Validation、Repository呼び出し、公開DTO変換を整理してRefactorする。
4. Unit Test、Integration Test、typecheck、buildを実行する。
5. S3へ接続していないことを確認し、学習記録へ反映する。

## 完了条件

- `POST /statements`が入力を検証してDBへ登録できる
- `GET /statements/{id}`が公開用DTOを返す
- 不正入力、未存在、競合、サイズ超過、依存障害を適切なHTTP statusへ変換できる
- DBへContent-TypeとContent-Lengthを保存できる
- S3 keyへfilenameを使用しない
- Phase 3ではS3へ接続しない
- 画像本体をAPIへ送らない
- Unit TestとIntegration Testが成功する
- `learning/phase-03.md`へデータフロー、障害、Security、Cost、理解確認を記録する
