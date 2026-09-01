# AI-OCR Credit Statement Analyzer

## Application Overview

クレジットカード明細画像をS3へ直接アップロードし、SQS経由のECS WorkerがAmazon BedrockでOCR・merchant正規化・カテゴリ分類を行う学習用アプリケーションである。PostgreSQLを数値の正とし、SQL AnalyticsをBedrockが解釈してAI Insightsを作る。

現在はPhase 0の設計段階であり、ユーザーの設計承認後にPhase 1のコード実装を開始する。

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
- Infrastructure: AWS CDK + TypeScript

## Local Setup

Phase 1でDocker Compose、PostgreSQL、Hono APIを追加する。現時点では実装開始前のため、実行コマンドは未確定である。

予定:

1. Node.jsのversionを固定する。
2. dependencyをinstallする。
3. Docker ComposeでPostgreSQLを起動する。
4. migrationを実行する。
5. APIとWorkerを別processで起動する。

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

migration、API起動、Worker起動の正式なscriptはPhase 1〜6で追加する。APIとWorkerはMVPでは同じimageを共有し、commandでprocessを切り替える案を推奨する。

APIの契約は [API_DESIGN.md](API_DESIGN.md)、WorkerとSQSの説明は [docs/worker.md](docs/worker.md) と [docs/sqs.md](docs/sqs.md) にある。

## AWS Deploy

Phase 13でCDKを追加し、VPC、ALB、ECS、RDS、S3、SQS、DLQ、IAM、CloudWatchを段階的にdeployする。設計承認前にAWS Resourceを作成しない。

## Cost

東京リージョンの計画値では、Learning環境を常時起動すると概算約$101〜110/月、Production-likeは約$178〜180/月 + 変動費となる。学習時はECS desiredCount=0、RDS停止、不要Resource削除を行う。詳細は [COST_DESIGN.md](COST_DESIGN.md) と [docs/cost.md](docs/cost.md) を参照する。

## Security

S3 Block Public Access、短期Presigned URL、HTTPS、Private RDS、Security Group、Secrets Manager、IAM Role分離、構造化ログのmasking、S3 Lifecycleを必須とする。認証なしのMVPをインターネットへ公開しない。

## Learning Process

各Phaseで「説明 -> 小実装 -> 動作確認 -> 理解整理 -> 次Phase」の順序を守る。[LEARNING_PLAN.md](LEARNING_PLAN.md) と [learning/phase-00.md](learning/phase-00.md) を起点にする。

## Design Review

Phase 1開始前に、特にBedrock Model、DB Library、Frontend、NAT / Endpoint、Insights API、Image共有、Worker scaling、S3 retention、認証のDecision Requiredを承認する。
