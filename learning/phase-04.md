# Phase 04 学習記録: S3アップロードとPresigned URL

## 作ったもの

- CDK `StorageStack`
- 非公開S3バケット
- SSE-S3、Block Public Access、HTTPS強制、TLS 1.2以上
- `statements/`の7日Lifecycle
- 不完全Multipart Uploadの1日後abort
- AWS SDK v3のS3 Adapter
- Presigned PUT URLを返す`POST /statements`
- S3実体を確認する`POST /statements/{id}/upload/complete`
- `UPLOAD_PENDING`から`UPLOADED`への条件付き状態更新

## 処理フロー

```text
1. Frontendが画像情報をAPIへ送る
2. APIがUUIDとS3 keyを作る
3. APIがS3へPUTできる短期URLを作る
4. APIがDBへUPLOAD_PENDINGを保存する
5. FrontendがPresigned URLへ画像本体をPUTする
6. Frontendがupload/completeを呼ぶ
7. APIがS3 HeadObjectで存在・種類・サイズを確認する
8. 一致したらDBをUPLOAD_PENDINGからUPLOADEDへ更新する
```

APIは画像本体を受け取らないため、画像の通信量をAPIで中継しない。FrontendにはAWS Credentialsを渡さず、Presigned URLだけを一時的に渡す。

## 重要コード

- `src/storage/s3-object-store.ts`: `PutObjectCommand`、署名対象Content-Type、`HeadObjectCommand`を扱う。
- `src/app.ts`: URL発行、S3 Metadata比較、公開エラー、状態遷移を扱う。
- `src/database/statement-repository.ts`: `WHERE status = 'UPLOAD_PENDING'`の条件付き更新を行う。
- `infra/lib/storage-stack.ts`: バケットのSecurity、Lifecycle、CORS、保持ポリシーをコード管理する。

## 障害時の挙動

| 状況 | 結果 |
|---|---|
| Presigned URL作成失敗 | 503。DB登録とURL返却を行わない |
| URL発行後、DB保存失敗 | 503。S3にまだ画像はないため孤立Objectは作られない |
| PUT前に完了APIを呼ぶ | 404 `UPLOAD_NOT_FOUND` |
| Content-Type不一致 | 409 `UPLOAD_METADATA_MISMATCH` |
| Content-Length不一致 | 409 `UPLOAD_METADATA_MISMATCH` |
| HeadObjectのAWS/ネットワーク障害 | 503。statusはUPLOAD_PENDINGのまま |
| 完了APIを2回呼ぶ | UPLOADED以降なら現在の状態を返す |
| 同時に完了APIを呼ぶ | DBの条件付きUPDATEにより、更新は一度だけ |
| Stackを削除する | `RETAIN`によりバケットと画像を残す |
| 画像を放置する | Lifecycleにより最大7日後に削除される |

## Security

- S3は公開しない。
- Presigned URLはBearer Tokenなので、期限を300秒にする。
- URLをログに出さない。
- URL発行時に署名したContent-TypeとPUT時の値を一致させる。
- S3 keyへ元ファイル名を使わず、サーバー生成UUIDを使う。
- APIへAWS Credentialsを返さない。
- S3のCORSはlocalhostのFrontend OriginとPUTだけを許可する。

## Cost

Phase 4ではS3バケットを1つだけ作る。S3の保存量とPUT/HEADリクエスト量は少量なら小さいが、画像は機密情報なので、費用だけでなく保持期間を7日に制限する。S3 Gateway EndpointやNATはECSを構築するPhase 13で比較する。

CDKの`RemovalPolicy.RETAIN`は誤削除を防ぐ一方、Stackを削除してもバケット料金が残る。学習終了時は、バケットに必要なデータがないことを確認してから手動削除する。

## テスト結果

- APIのFake S3テスト
- S3 AdapterのPresigned URL、HeadObject、404変換テスト
- PostgreSQL Repositoryの条件付き状態更新テスト
- CDK Assertions
- `cdk synth`

- `DATABASE_URL=... npm test`: 55件成功
- `npm run typecheck`: 成功
- `npm run typecheck:infra`: 成功
- `npm run build`: 成功
- `npm run cdk:synth`: 成功
- AWS CLIで認証済みアカウントを確認し、`StorageStack`を東京リージョンへデプロイ: 成功
- 実際のPresigned URLへ11バイトのテストデータをPUT: HTTP 200
- `upload/complete`でS3のContent-TypeとContent-Lengthを確認し、`UPLOADED`へ更新: 成功
- `HeadObject`で保存結果を確認後、テスト用Objectは削除済み

デプロイ時、初回bootstrapで作成されたCloudFormation実行Roleに、Bootstrap version確認用SSM参照権限がないことが分かった。アプリケーションRoleへ権限を追加するのではなく、S3リソースだけを管理するこのStackではCDKのbootstrap version ruleを無効にした。bootstrapのS3へテンプレートを発行し、CloudFormation実行RoleでStackを更新する仕組み自体は使用している。将来、Assetや複雑なCDK構成を追加する場合は、version ruleを無効にしたままにせず、bootstrapの互換性検査を有効にするか、権限を限定したbootstrap構成を再検討する。

## 理解確認と回答

### 1. なぜ画像本体をAPI経由ではなくFrontendからS3へ送るのか

APIが画像本体を中継すると、APIのメモリ、帯域、タイムアウトが画像サイズの影響を直接受ける。Presigned URLを使えば、APIは許可情報を発行し、画像本体はS3へ直接送れる。

### 2. Presigned URLは誰が作り、誰の権限でS3へアクセスするのか

BackendのAWS SDKが、API実行RoleまたはローカルAWS Profileの権限で作る。URLには署名情報が含まれ、FrontendはAWS Credentialsなしで指定されたS3操作を一時的に実行できる。

### 3. なぜFrontendへAWS Credentialsを渡さないのか

Browserに長期Credentialsを置くと、漏洩時にS3以外も含めた権限を悪用される可能性がある。Frontendには対象Objectへの短期PUT URLだけを渡す。

### 4. S3 keyを作成しても、なぜ画像は存在しないのか

S3 keyはObjectの保存先を表す文字列であり、keyをDBへ保存しただけではS3へのPUTは発生しない。画像が存在するのは、FrontendがPresigned URLへPUTしてS3が成功応答を返した後である。

### 5. なぜS3 keyに元ファイル名を使わないのか

ファイル名にはパス文字列、機密情報、同名重複が含まれる可能性がある。サーバー生成UUIDを使うと、Objectの識別と利用者入力を分離できる。

### 6. なぜupload/completeを別Endpointにするのか

`POST /statements`はDB上の受付とURL発行、S3 PUTはFrontendとS3、upload/completeはS3実体確認とDB状態更新という別の責務だからである。APIが画像PUTの成功を直接受け取れないため、完了確認の通信が必要になる。

### 7. なぜHeadObjectで確認するのか

APIが受け取ったContent-TypeとContent-Lengthは利用者申告値であり、実際にS3へ保存されたObjectの値とは限らない。HeadObjectでS3を確認し、DBへ保存した期待値と比較する。

### 8. なぜContent-Typeを署名するのか

Presigned URLの発行時とPUT時のContent-Typeを一致させ、許可した画像形式以外のPUTを防ぎやすくするためである。値が異なるとS3は署名不一致として拒否する。

なお、同じPresigned URLは有効期限内に複数回使えるため、同じkeyのObjectが上書きされる可能性がある。今回のkeyはstatement専用で、完了確認時に最後に保存されたObjectのMetadataを確認する。必要なら将来、URLの利用回数管理やChecksum検証を追加する。

### 9. なぜContent-LengthはHeadObjectで確認するのか

画像サイズの上限は重要だが、Presigned PUTでは実際の保存結果をS3で確認できる。APIの申告値だけを信用せず、S3のContent-Lengthと比較する。

### 10. なぜCDKでバケットを作るのか

非公開、暗号化、TLS、Lifecycle、CORS、保持ポリシーをコードで再現でき、設定漏れをテストできるからである。Phase 13で同じバケットを参照できる点も重要である。

### 11. なぜ`RemovalPolicy.RETAIN`にするのか

Stackの削除や変更で、クレカ明細画像を意図せず削除しないためである。ただし、不要なバケットが残り続けるため、学習終了時は内容を確認して手動削除する。

### 12. なぜ画像保持期間を7日にするのか

クレカ明細画像は機密情報であり、再処理のために長期間残す必要がないMVPだからである。短くすると再OCRや障害調査の余裕は減るため、保持期間は運用要件に合わせて見直す。

## 参照

- [Amazon S3 Presigned URL](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)
- [Presigned URLによるUpload](https://docs.aws.amazon.com/AmazonS3/latest/userguide/PresignedUrlUploadObject.html)
- [AWS SDK for JavaScript v3 S3例](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html)
- [AWS CDK BlockPublicAccess](https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3.BlockPublicAccess.html)
- [S3 CORS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html)
