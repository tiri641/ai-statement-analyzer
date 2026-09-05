# Phase 03: API

## 状態

実装・動作確認済み。Phase 3ではS3へ接続していない。

## 開始前の説明

### 1. 今回何を作るのか

Frontendから明細登録情報を受け取り、Zodで検証してPostgreSQLへ保存するAPIを作る。

- `POST /statements`
- `GET /statements/{id}`
- 400 / 404 / 409 / 413 / 503のエラー処理
- S3 Uploadに必要なContent-TypeとContent-Lengthの保存

### 2. なぜ必要なのか

Frontendから受け取った値を検証せずDBへ保存すると、不正な年月、未対応の画像形式、過大なファイルサイズが登録される可能性がある。APIで入力を検証し、DBにも制約を置くことで、後続のS3 Uploadが安全な前提で動けるようにする。

### 3. Application内部で何が起きるのか

```text
Frontend
  ↓ POST /statements
API
  ↓ JSON parse
  ↓ Zod validation
  ↓ statementId / s3_key生成
Repository
  ↓ parameterized INSERT
PostgreSQL
  ↓
201 Response
```

Phase 3では画像本体はAPIへ送らない。Frontendは画像情報だけを送る。S3 keyは保存先の名前として生成するが、この時点ではS3へ通信しない。

### 4. 他の選択肢

- APIが画像本体を受け取ってS3へ転送する: 実装は単純だが、APIの通信量・メモリ使用量が増え、FrontendからAPIへの経路が必要になる。
- Phase 3からS3へ接続する: 早く実動作できるが、APIの入力検証・DB登録・S3署名を同時に扱うことになる。
- Phase 3ではAPIとDBだけを扱う: 責務を分けてテストしやすく、S3 Uploadの仕組みをPhase 4で個別に理解できる。

### 5. なぜ今回の方式を選ぶのか

Phase 3ではAPIとDBの責務に集中するため、S3へ接続しない。S3 keyはサーバー側で生成してDBへ保存し、Phase 4で同じkeyをPresigned URLに設定する。

## 作ったもの

- Zod Request Schema
- `POST /statements`
- `GET /statements/{id}`
- APIエラーResponse
- `migrations/003_add_upload_metadata.sql`
- RepositoryのContent-Type・Content-Length対応
- APIのFake Repository Unit Test
- PostgreSQL Integration Test

## S3へ画像が渡る仕組みとの関係

Phase 3では次の最初の部分だけを作った。

```text
Frontend --POST /statements--> API
           画像情報だけ          ↓
                              PostgreSQL
```

APIは次のS3 keyを生成してDBへ保存する。

```text
statements/{statementId}/source
```

これはS3の保存先を表す文字列であり、S3への保存処理ではない。

Phase 4では、APIがこのkeyを使ってPresigned URLを作り、Frontendへ返す。

```text
Frontend --POST /statements--> API
Frontend <--Presigned URL------ API
Frontend --PUT URL------------> S3
           body: 画像本体
```

このとき、画像情報を送る通信と、画像本体を送る通信は別である。

```text
画像情報: Frontend → API
画像本体: Frontend → S3
```

FrontendはAWS Credentialsを持たない。Presigned URLの期限付き署名によって、指定されたS3 keyへのPUTだけが許可される。

## API処理の詳細

### POST `/statements`

1. JSON bodyを読み込む。
2. JSONが壊れていれば400を返す。
3. ZodでtargetMonth、filename、Content-Type、Content-Lengthを検証する。
4. 10MiBを超える場合は413を返す。
5. UUIDを生成する。
6. `statements/{UUID}/source`形式のS3 keyを生成する。
7. `UPLOAD_PENDING`でDBへ保存する。
8. `statementId`、status、`upload: null`を201で返す。

`fileName`は検証するが、S3 keyには使用しない。ユーザー入力を保存先名へ直接使わないためである。

### GET `/statements/{id}`

1. path parameterをUUIDとして検証する。
2. Repositoryでstatementを取得する。
3. 存在しなければ404を返す。
4. DBの内部名を公開用DTOへ変換する。
5. s3_keyやDB内部エラーを除外して200を返す。

## TDDの記録

### Red

先に`test/api.test.ts`を作成した。APIのerrors、schemas、Routeが存在しない状態で、モジュール未存在エラーによりテストが失敗することを確認した。

### Green

Zod、APIエラー、Migration 003、Repository拡張、HonoのRouteを追加した。最初のAPIテストでは、APIが毎回生成するUUIDに対してテストが固定UUIDを期待していたため失敗した。テストを、Repositoryへ渡した動的UUIDとResponseのUUIDが一致することを検証する形へ修正した。

### Refactor

- APIの依存をFake Repositoryへ差し替えられるようにした。
- APIエラーのResponse形式を統一した。
- DB内部のsnake_caseを公開用camelCase DTOへ変換した。
- S3 key生成をfilenameから独立させた。
- S3 SDKは追加せず、Phase 4の責務として残した。

## 重要コード

- `src/api/schemas.ts`: targetMonth、Content-Type、Content-Lengthを検証する。
- `src/database/errors.ts`: Database層の一意制約違反を表すErrorを定義する。
- `src/app.ts`: API Route、Validation、Response DTO、エラー変換を定義する。
- `src/database/statement-repository.ts`: Upload metadataを含むstatementをDBへ保存・取得する。
- `migrations/003_add_upload_metadata.sql`: S3 Upload前提のmetadataとDB制約を追加する。

## 動作確認結果

以下を確認した。

```bash
npm run migrate
npm test
npm run typecheck
npm run build
```

テスト結果:

- API Unit Test: 成功
- Phase 1のHealth Test: 成功
- Phase 2のDatabase Integration Test: 成功
- Migration 003: 成功
- Content-Type制約: 成功
- Content-Length制約: 成功
- 不正JSON: 400
- 不正入力: 400
- ファイルサイズ超過: 413
- 存在しないstatement: 404
- Repository競合: 409
- DB障害: 503

## 障害時の挙動

### JSONや入力が不正な場合

DBへ保存せず、400 `INVALID_REQUEST`を返す。Frontendは入力を修正する必要があり、同じ内容をそのままRetryしない。

### ファイルサイズが大きすぎる場合

DBへ保存せず、413 `FILE_TOO_LARGE`を返す。10MiB以下の画像を選び直す。

### DBが停止している場合

Repositoryのエラーを内部へ記録し、Frontendには503 `DEPENDENCY_UNAVAILABLE`を返す。パスワード、接続先、SQL、Stack traceは返さない。

### DBの一意制約で競合した場合

Repositoryが競合を`UniqueConstraintError`へ変換し、APIは409 `STATEMENT_CONFLICT`を返す。

### S3 Uploadに失敗した場合

Phase 3ではS3通信がないため、この処理はまだ発生しない。Phase 4でFrontendがPresigned URLへPUTし、成功後に解析開始APIを呼ぶ設計にする。

## Security

- 画像本体をAPIのRequest bodyへ送らない。
- FrontendへAWS Credentialsを渡さない。
- S3 keyへユーザーのfilenameを使用しない。
- DBへ保存するのはS3 keyとUpload metadataであり、画像本体やカード番号ではない。
- Zod内部エラーやPostgreSQLエラーをResponseへ返さない。
- Content-TypeとContent-LengthをAPIとDBで検証する。
- 認証はまだ実装していないため、認証なしのAPIをインターネットへ公開しない。

## Cost

Phase 3ではS3、ECS、RDS、SQS、BedrockなどのAWSリソースを作成していないため、AWS料金は発生しない。PostgreSQLはローカルDockerで実行する。

Phase 4以降はS3のStorage、Request、Data Transfer、Presigned URL経由のUploadが発生し得る。S3への直接UploadによってAPIの通信量と処理負荷を抑える設計にする。

## 理解確認

### 1. なぜ画像本体と画像情報を別の通信にするのか

画像情報はAPIで検証してDBへ保存し、画像本体はFrontendからS3へ直接送るためである。APIが画像本体を中継しないので、APIの通信量とメモリ使用量を抑えられる。

### 2. FrontendはどのHTTPリクエストでS3へ画像を送るのか

APIから受け取ったPresigned URLへ、`PUT`リクエストを送る。画像本体はHTTPリクエストの`body`に設定する。`POST /statements`で画像本体を送るのではない。

### 3. Presigned URLとは何か

S3操作の権限と有効期限を含む署名付きURLである。FrontendはAWS Credentialsを持たなくても、そのURLの有効期間内に許可されたS3操作を実行できる。

### 4. なぜFrontendへAWS Credentialsを渡さないのか

長期間使えるAWS認証情報をBrowserへ置くと、漏洩時に広いAWS操作を許してしまう可能性があるためである。Presigned URLで対象Objectと操作、期限を限定する。

### 5. S3 keyを作成しても、なぜS3に画像が存在しないのか

S3 keyはObjectの名前を表す文字列にすぎないためである。FrontendがPresigned URLへPUTし、S3がそのkeyでObjectを作成した時点で画像が保存される。

### 6. なぜS3 keyにfilenameを使用しないのか

同じfilenameの重複、特殊文字、長さ、ユーザー入力による保存先の混乱を避けるためである。サーバー生成UUIDを使ったkeyにする。

### 7. なぜPhase 3では`UPLOAD_PENDING`のままなのか

Phase 3ではS3へのPUTも、S3 Objectの存在確認も行っていないためである。S3 Uploadが成功し、APIが確認した後にPhase 4で`UPLOADED`へ変更する。

### 8. なぜContent-TypeとContent-LengthをDBへ保存するのか

Phase 4でS3の`HeadObject`結果と、作成時に申告された値を照合するためである。想定外の形式やサイズのObjectを後続処理へ渡さない。

### 9. 400、404、409、413、503をどう使い分けるのか

400は入力不正、404は対象なし、409はデータ競合、413はサイズ超過、503はDBなど依存サービスが利用できない状態を表す。

### 10. なぜAPIのResponse DTOとDBのRow型を分けるのか

DBにはS3 keyや内部状態などAPI利用者へ見せる必要のない情報があるためである。公開する項目を明示的に変換することで、内部情報の意図しない漏洩を防ぐ。

## Phase 3で扱わなかったもの

実際のS3 Bucket、Presigned URL発行、FrontendのFile送信、S3 `HeadObject`、SQS、Bedrock、認証、解析開始APIはPhase 4以降で扱う。

## レビュー後の修正

Phase 3のPRを別エージェントでレビューし、次の指摘を確認した。

| 指摘 | 対応 |
|---|---|
| 認証なしでネットワーク公開できる | 認証導入まではloopback host以外でAPIを起動できないようにした。公開前に認証・owner_id条件を実装する方針も明記した |
| DBの内部failure messageがResponseへ漏れる | 許可したfailure codeだけ固定メッセージへ変換し、未知のcodeは一般メッセージへ置き換えた |
| Migration 003が既存行へ仮のMetadataを入れる | 既存statementがある場合はMigrationを明示的に失敗させ、仮値を保存しないようにした |
| JSON Request Bodyのサイズ制限がない | `POST /statements`へ64KiBのbody limitを追加した |
| HTTP Content-Typeを検証していない | `application/json`以外を400で拒否するテストと実装を追加した |
| RepositoryがAPI層のErrorへ依存する | `UniqueConstraintError`をDatabase層へ移し、APIが409へ変換するようにした |
| Phase 3とPhase 4の説明が混在する | API一覧、README、学習記録へ実装Phaseを明記した |

認証機能そのものはPhase 3の範囲に追加していない。これは学習計画上のDecision Requiredとして残し、認証なしAPIを公開しない実行時制限を先に追加したためである。
