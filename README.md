# AI-OCR Credit Statement Analyzer

## Application Overview

クレジットカード明細画像をS3へ直接アップロードし、SQS経由のECS WorkerがAmazon BedrockでOCR・merchant正規化・カテゴリ分類を行う学習用アプリケーションである。PostgreSQLを数値の正とし、SQL AnalyticsをBedrockが解釈してAI Insightsを作る。

Phase 5までのローカルAPI、Database、S3 Upload、Presigned URL、SQS解析ジョブ投入を実装済み。`POST /statements`は短期Presigned PUT URLを返し、Frontendまたはcurlが画像をS3へ直接送る。`POST /statements/{id}/upload/complete`がS3の実体を確認して、`UPLOAD_PENDING`を`UPLOADED`へ更新する。その後`POST /statements/{id}/analyze`が`statementId`だけをSQSへ送り、`QUEUED`を返す。ECS WorkerとBedrockは後続Phaseで実装する。

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
- Worker: TypeScript、SQS Long Polling
- AWS: ECS Fargate、ALB、ECR、S3、SQS、RDS、Bedrock、CloudWatch、IAM、VPC
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
4. Phase 4のAPIを起動するには、`npm run cdk:deploy:storage`を実行し、Outputの`S3BucketName`を`.env`の`S3_BUCKET_NAME`へ設定する
5. `npm run migrate`
6. `npm run api`
7. 別の端末で `curl http://127.0.0.1:3000/health`
8. `curl http://127.0.0.1:3000/health/db`

開発中は `npm run dev` も使用できる。DBを停止する場合は `docker compose stop db`、終了する場合は `docker compose down`を使う。`docker compose down -v`はNamed Volumeを削除するため、意図的なデータ削除時以外は使用しない。

Phase 4・5のAPI起動とCDK操作には、ローカルのAWS CLI ProfileまたはSSO認証が必要である。AWS認証情報をFrontend、ソースコード、`.env`へAccess Keyとして保存しない。認証情報がない場合でも、`npm test`、`npm run typecheck`、`npm run build`、`npm run cdk:synth`は実行できる。

Phase 2でMigrationと業務テーブル、Phase 3でAPI入力検証と明細API、Phase 4でS3/CDKとPresigned URL、Phase 5でSQS/CDKと解析開始APIを追加した。Bedrock、ECS Worker、VPCはまだ追加していない。

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

Worker起動はPhase 6で追加する。APIとWorkerはMVPでは同じimageを共有し、commandでprocessを切り替える案を推奨する。

APIの契約は [API_DESIGN.md](API_DESIGN.md)、WorkerとSQSの説明は [docs/worker.md](docs/worker.md) と [docs/sqs.md](docs/sqs.md) にある。

## AWS Deploy

Phase 4ではS3をCDKでdeployし、Phase 5ではSQSとDLQをdeployする。`npm run cdk:synth`で確認し、`npm run cdk:deploy:storage`と`npm run cdk:deploy:messaging`で個別にdeployできる。StorageStackのOutput `S3BucketName`とMessagingStackのOutput `AnalyzeQueueUrl`を未commitの`.env`へ設定する。Phase 13では既存のS3、SQS、DLQを再作成せず、VPC、ALB、ECS、RDS、IAM、CloudWatchを追加する。

## Cost

東京リージョンの計画値では、Learning環境を常時起動すると概算約$101〜110/月、Production-likeは約$178〜180/月 + 変動費となる。学習時はECS desiredCount=0、RDS停止、不要Resource削除を行う。詳細は [COST_DESIGN.md](COST_DESIGN.md) と [docs/cost.md](docs/cost.md) を参照する。

## Security

S3 Block Public Access、短期Presigned URL、HTTPS、Private RDS、Security Group、Secrets Manager、IAM Role分離、構造化ログのmasking、S3 Lifecycleを必須とする。認証なしのMVPをインターネットへ公開しない。

## 学習プロセス

各Phaseで「説明 -> 小実装 -> 動作確認 -> 理解整理 -> 次Phase」の順序を守る。[LEARNING_PLAN.md](LEARNING_PLAN.md) と [learning/phase-00.md](learning/phase-00.md) を起点にする。

## 設計レビュー

Phase 1、Phase 2、Phase 3、Phase 4、Phase 5は完了した。認証なしAPIはloopback host以外で起動できない。Phase 4のS3画像はLifecycleで7日後に削除され、Stack削除時は`RETAIN`でバケットを残す。Phase 5のSQSとDLQはSSE-SQS、SSL強制、redrive設定を持つ。AWSへ接続しない単体テストではFake S3とFake SQS clientを使用する。Bedrock Model、Frontend、NAT / Endpoint、Insights API、Image共有、Worker scaling、認証の設計判断は後続Phaseで使用する。
