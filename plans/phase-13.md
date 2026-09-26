# Phase 13: AWS Infrastructure 実装Plan

Status: 実装中。`main`の`1a90208`から`phase-13/aws-infrastructure`を作成して進める。

## 目的

ローカルで動作しているAPI・Worker・Docker PostgreSQLの実行場所を、既存のS3・SQS・Bedrockの業務フローを維持したままAWSへ移行する。

```text
ローカルNode.js API/Worker -> ECS Fargate Task
Docker PostgreSQL          -> RDS PostgreSQL
.env                       -> ECS環境変数 + Secrets Manager
ローカルAWS Credentials    -> ECS Task Role
localhost                  -> Internal ALB
ターミナルログ             -> CloudWatch Logs
手動Migration              -> ECS One-off Task
```

## 対象範囲

- `Dockerfile`と`.dockerignore`を追加し、API・Worker・Migrationを同一Imageから起動できるようにする。
- `DATABASE_URL`を維持しつつ、ECSの`DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_USER`、`DB_PASSWORD`を受け付ける。
- 既存の`StorageStack`、`MessagingStack`、`ObservabilityStack`を再作成せず参照する。
- `NetworkStack`、`ContainerRegistryStack`、`DatabaseStack`、`ApplicationStack`を追加する。
- Learning構成として2 AZ、NAT Gateway 1台、Private RDS Single-AZを採用する。
- `NetworkStack`のDefault Security Group制限にはCDKのCustom Resource Assetを使うため、Deploy対象のAWSアカウント・リージョンは事前に`cdk bootstrap`する。
- 認証未実装のためInternal ALBに限定し、Internet-facing ALBは作成しない。
- API Task RoleとWorker Task Roleを分離する。
- ECS Execution RoleでECR pull、CloudWatch Logs、Secret injectionを行う。
- MigrationはAPI起動時ではなくOne-off ECS Taskで実行する。

## リクエストフロー

ローカルではAPI・Worker・DBだけがローカルで、S3・SQS・BedrockはAWSを利用する。AWSではAPI・Worker・DBをECS/RDSへ移す。

```text
Frontend -> Internal ALB -> ECS API -> RDS
                              |       |
                              |       +--> S3 HeadObject / DB update
                              +----------> S3 Presigned URL / SQS

Frontend -------------------------------> S3 PUT
SQS -> ECS Worker -> S3 -> Bedrock -> RDS -> SQS DeleteMessage
ECS stdout/stderr -> CloudWatch Logs -> Metrics / Alarm
```

HTTP API、`statementId`だけを含むSQS Message、Atomic claim、lease、processing token、Zod Validation、DB COMMIT後ACK、Retry/DLQの業務ロジックは変更しない。

## Docker設計

現在はアプリケーション用Dockerfileが存在せず、`docker-compose.yml`はPostgreSQL専用である。Dockerfileは既存ファイルの置き換えではなく新規追加する。

- Node.js 24系のMulti-stage build
- `npm ci`、TypeScript build、production dependenciesのみのruntime
- `dist/`と`migrations/`をruntimeへコピー
- default command: `node dist/server.js`
- ECS command override: `node dist/worker.js`、`node dist/migrate.js`
- `linux/amd64`でECRへPushする
- Image tagはGit SHA等の不変値を使う

## DB・実行設定

`src/config/database.ts`を追加し、`server.ts`、`worker.ts`、`migrate.ts`から利用する。

- `DATABASE_URL`があればローカル互換の接続文字列を使う。
- `DATABASE_URL`がなければ`DB_HOST`、`DB_PORT`、`DB_NAME`、`DB_USER`、`DB_PASSWORD`からPoolを構築する。
- Secret、接続文字列、Access Keyをログへ出さない。
- ECS APIは`HOST=0.0.0.0`と`ALLOW_NON_LOOPBACK_HOST=true`を明示した場合だけ非loopback bindを許可する。
- ローカルの既存DBデータ移行は対象外とし、RDSへSchema Migrationを適用する。

## IAM設計

### API Task Role

- S3 `PutObject` / `GetObject`を`statements/*`に限定
- Main QueueへのSQS `SendMessage`
- InsightsモデルへのBedrock `InvokeModel`
- SQS Receive/Delete、Worker用権限、AdministratorAccessは付与しない

### Worker Task Role

- S3 `GetObject`を`statements/*`に限定
- Main QueueへのSQS `ReceiveMessage` / `DeleteMessage` / `GetQueueAttributes`
- OCRモデルへのBedrock `InvokeModel`
- SQS SendMessage、S3 PutObject、AdministratorAccessは付与しない

### ECS Execution Role

- ECR Image pull
- CloudWatch Logs stream作成・put
- Secrets ManagerからRDS Secret取得

Task Roleはアプリケーション用、Execution RoleはECS Agent用と明確に分離する。CDK/CloudFormationのDeploy Roleも別物として扱う。

## ECS・ネットワーク

- VPCは2 AZ、Public subnet、Private app subnet、Isolated DB subnetを作る。
- NAT GatewayはLearning構成として1台、S3 Gateway Endpointを追加する。
- ECS TaskにPublic IPを付けない。
- Internal ALBからAPIの3000番だけを許可する。
- API/WorkerからRDSの5432番だけを許可する。
- RDSは`PubliclyAccessible=false`、暗号化、gp3 20GB、Single-AZ、backup retention 7日とする。
- ECS `stopTimeout=30秒`、API health checkは`GET /health`とする。
- 既存Observability Log Groupへ`awslogs`を接続する。
- Learning環境の初期desired countは0とし、Migration成功後にAPI/Workerを1へ変更する。

## Migration順序

1. Network、RDS、ECRを作成する。
2. Docker ImageをBuildしてECRへPushする。
3. ECS Task Definitionを作成する。
4. `node dist/migrate.js`のOne-off ECS Taskを実行する。
5. Logsと終了コードでMigration成功を確認する。
6. API/Worker Serviceを起動する。
7. Internal ALBの`/health`と、S3 upload、SQS、Worker完了までを確認する。

API起動時の自動Migrationは行わない。

## 具体的な切り替え手順

切り替えは、アプリケーションコードをAWS専用へ書き換えるのではなく、同じImageの起動Commandと接続先・権限を段階的に差し替える。

1. **AWSリソースを作る**

   既存のStorage、Messaging、Observabilityを維持したまま、次の順序で新規StackをDeployする。

   ```bash
   AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
   AWS_REGION=ap-northeast-1
   npx cdk bootstrap "aws://$AWS_ACCOUNT_ID/$AWS_REGION"

   npm run cdk:deploy:storage
   npm run cdk:deploy:messaging
   npm run cdk:deploy:observability
   npm run cdk:deploy:network
   npm run cdk:deploy:registry
   npm run cdk:deploy:database
   ```

   この時点では`ECS_API_DESIRED_COUNT=0`、`ECS_WORKER_DESIRED_COUNT=0`のため、ECS Serviceは作成されてもアプリTaskは起動しない。RDS Secretは`DatabaseStack`が生成し、値をCloudFormationやログへ平文出力しない。

2. **ローカルの`.env`をImageへ持ち込まず、ECRへPushする**

   ```bash
   AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
   AWS_REGION=ap-northeast-1
   ECR_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/ai-statement-analyzer"
   IMAGE_TAG=$(git rev-parse --short HEAD)

   aws ecr get-login-password --region "$AWS_REGION" |
     docker login --username AWS --password-stdin "$ECR_URI"
   docker build --platform linux/amd64 -t "$ECR_URI:$IMAGE_TAG" .
   docker push "$ECR_URI:$IMAGE_TAG"
   ```

   `ECR_IMAGE_TAG=$IMAGE_TAG npm run cdk:deploy:application`でTask Definitionが同じ不変Tagを参照する。`cdk:deploy:application`は先にECRへそのTagが存在することをAWS CLIで確認するため、未PushのImageを参照したままDeployしない。API、Worker、Migrationの違いはImageではなく、ECSの`node dist/server.js`、`node dist/worker.js`、`node dist/migrate.js`というCommandだけである。

   `BEDROCK_*_MODEL_ID`にはFoundation Model IDを指定できる。Inference Profileを使う場合は、対象Inference Profileの完全なARNを指定する。

3. **One-off Migration Taskを実行する**

   `NetworkStack`の`ApplicationSubnetIds`、`ApiSecurityGroupId`と、`ApplicationStack`の`ClusterName`、`MigrationTaskDefinitionArn`をCloudFormation Outputsから取得する。

   ```bash
   MIGRATION_TASK_ARN=$(aws ecs run-task \
     --cluster "$CLUSTER_NAME" \
     --task-definition "$MIGRATION_TASK_DEFINITION_ARN" \
     --launch-type FARGATE \
     --network-configuration \
       "awsvpcConfiguration={subnets=[$APPLICATION_SUBNET_IDS],securityGroups=[$API_SECURITY_GROUP_ID],assignPublicIp=DISABLED}" \
     --query 'tasks[0].taskArn' --output text)
   aws ecs wait tasks-stopped \
     --cluster "$CLUSTER_NAME" \
     --tasks "$MIGRATION_TASK_ARN"
   aws ecs describe-tasks \
     --cluster "$CLUSTER_NAME" \
     --tasks "$MIGRATION_TASK_ARN" \
     --query 'tasks[0].containers[?name==`MigrationContainer`].exitCode' \
     --output text
   ```

   TaskはRDSのPrivate subnetへ接続し、`DB_HOST`、`DB_PORT`、`DB_NAME`はECS環境変数、`DB_USER`、`DB_PASSWORD`はRDS SecretからECS Execution Role経由で注入される。`exitCode`が0で、CloudWatch Logsに`migration_completed`があることを確認してからServiceを起動する。

4. **API/Workerを起動する**

   ```bash
   ECR_IMAGE_TAG="$IMAGE_TAG" \
   ECS_API_DESIRED_COUNT=1 \
   ECS_WORKER_DESIRED_COUNT=1 \
   BEDROCK_OCR_MODEL_ID="jp.amazon.nova-2-lite-v1:0" \
   BEDROCK_INSIGHTS_MODEL_ID="<insights-model-id>" \
   npm run cdk:deploy:application
   ```

   Frontendからの接続先は`localhost`ではなく、OutputのInternal ALB DNS名になる。ALBはInternet-facingではなく、ALB Security GroupはVPC CIDRからのHTTP/HTTPSだけ、API Security GroupはALBからの3000番だけを許可する。ECS TaskにはPublic IPを付けない。

5. **処理経路を確認する**

   ```text
   Frontend -> Internal ALB -> API Task -> RDS / S3 Presigned URL / SQS
   SQS -> Worker Task -> S3 -> Bedrock -> RDS -> SQS Delete
   API・Worker・Migration stdout/stderr -> CloudWatch Logs
   ```

   ローカルの`DATABASE_URL`、Docker PostgreSQL、端末のAWS Credentials、端末ログはAWS実行時には使わない。AWS SDKはTask Roleの一時Credentialsを自動取得する。API Task RoleとWorker Task Roleは分離され、ECS AgentだけがExecution Roleを使う。

## TDD・検証

実装順はDB設定とserver safety、Docker build、Network/RDS、ECR/ECS/ALB/IAMの順とする。

- DB接続設定のUnit Test
- 非loopback起動許可の安全性Test
- DockerfileのBuild確認
- Network、RDS、ECR、ECS、ALB、IAMのCDK Template Test
- Secret平文非漏洩Test
- API/Worker Task Roleの権限分離Test
- `awslogs`、`stopTimeout`、Private subnet、既存Stack非再作成のTest

最終検証:

```bash
DATABASE_URL=postgresql://app:local_dev_password@127.0.0.1:5432/statement_analyzer_test npm test
npm run typecheck
npm run typecheck:infra
npm run build
npm run cdk:synth
git diff --check
docker build --platform linux/amd64 -t ai-statement-analyzer:test .
```

AWSへのDeploy、ECRへのPush、PR作成はユーザーの明示依頼があるまで行わない。
