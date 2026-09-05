# AI-OCR Credit Statement Analyzer

## Application Overview

クレジットカード明細画像をS3へ直接アップロードし、SQS経由のECS WorkerがAmazon BedrockでOCR・merchant正規化・カテゴリ分類を行う学習用アプリケーションである。PostgreSQLを数値の正とし、SQL AnalyticsをBedrockが解釈してAI Insightsを作る。

Phase 7までのローカルAPI、Database、S3 Upload、Presigned URL、SQS解析ジョブ投入、常駐Worker、Bedrock OCRアダプターを実装済み。`POST /statements`は短期Presigned PUT URLを返し、Frontendまたはcurlが画像をS3へ直接送る。`POST /statements/{id}/upload/complete`がS3の実体を確認して、`UPLOAD_PENDING`を`UPLOADED`へ更新する。その後`POST /statements/{id}/analyze`が`statementId`だけをSQSへ送り、`QUEUED`を返す。Phase 6のWorkerはSQSをLong Pollingし、検証済みMessageを1件ずつ処理して成功後に削除する。Phase 7では画像bytesをBedrock Converseへ渡してTool Useを受け取り、Zodで検証する。S3 GetObject、BedrockをWorkerへ組み込む処理、DB保存、ECSデプロイは後続Phaseで実装する。

## Architecture

```
Frontend
  -> API: statement作成 / Presigned URL
  -> S3: image PUT
  -> API: analyze
  -> SQS: statementId
  -> ECS Worker
  -> S3 / Bedrock / PostgreSQL
  -> SQL Analytics
  -> Bedrock Insights
  -> Dashboard
```

詳細は [ARCHITECTURE.md](ARCHITECTURE.md) と [docs/architecture.md](docs/architecture.md) を参照する。

## Tech Stack

- Backend: TypeScript、Node.js、Hono、Zod
- Database: PostgreSQL、推奨はpg + SQL migration
- Worker: TypeScript、SQS Long Polling、Graceful Shutdown
- AWS: ECS Fargate、ALB、ECR、S3、SQS、RDS、Bedrock Converse、CloudWatch、IAM、VPC
- Frontend候補: Vite + React + TypeScript（Decision Required）
- Infrastructure: AWS CDK + TypeScript（Phase 5はS3 StorageStackとMessagingStack）

## ローカル環境

APIはホストのNode.jsで起動し、PostgreSQLだけをDocker Composeで起動する。

必要な環境:

1. Node.js v24系
2. npm
3. Docker EngineとDocker Compose

起動手順:

1. `cp .env.example .env`
2. `npm install`
3. `docker compose up -d db`
4. `npm run cdk:deploy:storage`を実行し、Outputの`S3BucketName`を`.env`の`S3_BUCKET_NAME`へ設定する
5. `npm run cdk:deploy:messaging`を実行し、Outputの`AnalyzeQueueUrl`を`.env`の`SQS_QUEUE_URL`へ設定する
6. `npm run migrate`
7. `npm run api`
8. 別の端末で `curl http://127.0.0.1:3000/health`
9. `curl http://127.0.0.1:3000/health/db`

開発中は `npm run dev` も使用できる。DBを停止する場合は `docker compose stop db`、終了する場合は `docker compose down`を使う。`docker compose down -v`はNamed Volumeを削除するため、意図的なデータ削除時以外は使用しない。

Phase 4・5のAPI起動とCDK操作には、ローカルのAWS CLI ProfileまたはSSO認証が必要である。AWS認証情報をFrontend、ソースコード、`.env`へAccess Keyとして保存しない。認証情報がない場合でも、`npm test`、`npm run typecheck`、`npm run build`、`npm run cdk:synth`は実行できる。

Phase 2でMigrationと業務テーブル、Phase 3でAPI入力検証と明細API、Phase 4でS3/CDKとPresigned URL、Phase 5でSQS/CDKと解析開始API、Phase 6で常駐WorkerとGraceful Shutdown、Phase 7でBedrock RuntimeのConverseアダプター、Tool Use、Zod Validation、合成PNG、実接続スモークを追加した。Bedrock呼び出しはまだWorkerへ接続していない。ECS ServiceとVPCはまだ追加していない。

## Environment Variables

実装時に以下を定義する。値はsecret managerまたはlocalの未commitファイルで管理する。

- APP_ENV
- PORT
- DATABASE_URLまたはDB接続情報
- AWS_REGION
- S3_BUCKET_NAME
- SQS_QUEUE_URL
- SQS_DLQ_URL
- BEDROCK_OCR_MODEL_ID
- BEDROCK_INSIGHTS_MODEL_ID
- BEDROCK_OCR_SCHEMA_VERSION
- INSIGHTS_PROMPT_VERSION
- S3_PRESIGNED_URL_EXPIRES_SECONDS
- S3_RAW_RETENTION_DAYS

## Migration / API / Worker

MigrationはPhase 2で追加した。PostgreSQLを起動した後、次のコマンドで適用する。

```bash
npm run migrate
```

常駐WorkerはPhase 6で追加した。`npm run worker`で起動し、`SQS_QUEUE_URL`のQueueをLong Pollingする。Phase 5の確認用Consumerは、1件だけを受信・Validation・削除する`npm run consume:analyze`である。APIとWorkerはMVPでは同じimageを共有し、commandでprocessを切り替える案を推奨する。
Phase 7のFake ClientテストはAWSへ接続しない。認証済みのAWS環境で合成画像を使ったBedrock接続を確認する場合は、`npm run bedrock:ocr:smoke`を実行する。スモークコマンドはOCRの件数とtoken usageだけを出力し、画像やmerchant・金額は出力しない。

APIの契約は [API_DESIGN.md](API_DESIGN.md)、WorkerとSQSの説明は [docs/worker.md](docs/worker.md) と [docs/sqs.md](docs/sqs.md) にある。

## AWS Deploy

Phase 4ではS3をCDKでdeployし、Phase 5ではSQSとDLQをdeployする。`npm run cdk:synth`で確認し、`npm run cdk:deploy:storage`と`npm run cdk:deploy:messaging`で個別にdeployできる。StorageStackのOutput `S3BucketName`とMessagingStackのOutput `AnalyzeQueueUrl`を未commitの`.env`へ設定する。Phase 7のBedrockは、対象モデルへのアクセス許可と`bedrock:InvokeModel`権限が必要である。Phase 13では既存のS3、SQS、DLQを再作成せず、VPC、ALB、ECS、RDS、IAM、CloudWatchを追加する。

`npm run consume:analyze`は`SQS_QUEUE_URL`のMessageを最大1件受信し、MessageのValidationに成功した場合だけ`DeleteMessage`する。空なら`EMPTY`を出力する。常駐Workerの`npm run worker`は処理関数の成功後だけ削除し、処理失敗・不正Message・Delete失敗時は削除せず継続する。SIGTERM / SIGINTを受信すると新規受信を止め、通常は処理中Messageの完了を待つ。Shutdown要求後30秒を超えて処理または削除が完了しない場合は削除せず終了し、SQSの再配送に任せる。

## Cost

東京リージョンの計画値では、Learning環境を常時起動すると概算約$101〜110/月、Production-likeは約$178〜180/月 + 変動費となる。学習時はECS desiredCount=0、RDS停止、不要Resource削除を行う。詳細は [COST_DESIGN.md](COST_DESIGN.md) と [docs/cost.md](docs/cost.md) を参照する。

## Security

S3 Block Public Access、短期Presigned URL、HTTPS、Private RDS、Security Group、Secrets Manager、IAM Role分離、構造化ログのmasking、S3 Lifecycleを必須とする。認証なしのMVPをインターネットへ公開しない。

## 学習プロセス

各Phaseで「説明 -> 小実装 -> 動作確認 -> 理解整理 -> 次Phase」の順序を守る。[LEARNING_PLAN.md](LEARNING_PLAN.md) と [learning/phase-00.md](learning/phase-00.md) を起点にする。

## 設計レビュー

Phase 1からPhase 7まで完了した。認証なしAPIはloopback host以外で起動できない。Phase 4のS3画像はLifecycleで7日後に削除され、Stack削除時は`RETAIN`でバケットを残す。Phase 5のSQSとDLQはSSE-SQS、SSL強制、redrive設定を持つ。AWSへ接続しない単体テストではFake S3、Fake SQS、Fake Bedrock clientを使用する。Phase 7の既定Bedrockモデルは`jp.amazon.nova-2-lite-v1:0`で、画像入力と強制Tool選択、Tool input schemaを使い、JSON Schema Structured Outputとstrict非対応をZodで補う。Frontend、NAT / Endpoint、Insights API、Image共有、Worker scaling、認証の設計判断は後続Phaseで使用する。
