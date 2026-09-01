# S3 Upload

1. APIがサーバー生成keyでstatementを作り、短期Presigned PUT URLを返す。
2. BrowserはAWS CredentialsなしでS3へ画像をPUTする。
3. BrowserはPUT成功後だけanalyze APIを呼ぶ。
4. APIはHeadObjectで存在・size・Content-Typeを再確認する。

S3はprivate、Block Public Access、暗号化、Lifecycleを有効にする。Presigned URLはbearer tokenなので5〜10分程度のTTL、ログ非出力、署名Content-Typeの固定を行う。未完了uploadは早期abortし、raw imageは30日（Decision Requiredで7日も候補）で削除する。

参照: [S3 presigned URLs](https://docs.aws.amazon.com/AmazonS3/latest/userguide/using-presigned-url.html)、[Block Public Access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html)。

