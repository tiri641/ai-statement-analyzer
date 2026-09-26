# Phase 13 AWSデプロイ失敗記録と切り分け手順

Phase 13のAWSデプロイで実際に発生した失敗を、原因、確認方法、修正方法、再発防止策として記録する。

この文書でいう「権限不足」は、アプリケーションのECS Task Roleではなく、CloudFormationを実行するCDK BootstrapのCloudFormation execution roleに必要なAWS API権限がなかったことを指す。Task Roleの権限不足と混同しない。

## 先に確認すること

CDK deployが失敗した場合は、同じコマンドを繰り返す前に、Stackの状態、CloudFormationイベント、ECSタスクの終了理由、CloudWatch Logsを順に確認する。

```bash
aws cloudformation describe-stacks \
  --stack-name <stack-name> \
  --query 'Stacks[0].{Status:StackStatus,Reason:StackStatusReason}'

aws cloudformation describe-stack-events \
  --stack-name <stack-name> \
  --max-items 30 \
  --query 'StackEvents[].{Time:Timestamp,LogicalId:LogicalResourceId,Status:ResourceStatus,Reason:ResourceStatusReason}'
```

ECSのOne-off TaskやServiceが失敗した場合は、CloudFormationの失敗だけで判断せず、Taskの終了コードとログを確認する。

```bash
aws ecs describe-tasks \
  --cluster <cluster-name> \
  --tasks <task-arn> \
  --query 'tasks[0].{LastStatus:lastStatus,StopCode:stopCode,StoppedReason:stoppedReason,ContainerExitCodes:containers[].exitCode}'

aws logs get-log-events \
  --log-group-name <log-group-name> \
  --log-stream-name <log-stream-name> \
  --start-from-head \
  --query 'events[].message'
```

エラーログにSecret、接続文字列、Access Key、画像内容を出さない。ログを共有するときは、ホスト名や内部IDも必要最小限にする。

## 発生した失敗と修正

### 1. MessagingStack: SNSとCloudWatch Alarmの権限不足

#### 症状

- SNS Topicの属性取得で失敗した。
- 続いてCloudWatch Alarmの作成・削除でも失敗した。

#### 原因

CDK BootstrapのCloudFormation execution roleに、SNS Topicの属性参照とCloudWatch Alarmの管理権限がなかった。

#### 修正

CDK execution roleへ、対象Stackの作成に必要なSNSとCloudWatchの権限を追加し、MessagingStackを再デプロイした。

#### 再発防止

Bootstrap済みのCDK execution roleへ、各Stackが利用するAWSサービスのCloudFormation管理権限を事前に付与する。アプリケーションのTask Roleへこの権限を追加してはいけない。

### 2. ObservabilityStack: SSM、CloudWatch Logs、Metric Filterの権限不足

#### 症状

- Bootstrap versionのSSMパラメータ参照で失敗した。
- Log Group作成やMetric Filterの作成・参照で失敗した。

#### 原因

CDK execution roleに、SSM Parameter StoreとCloudWatch Logsの必要な読み取り・作成・Metric Filter操作権限がなかった。

#### 修正

不足していたSSMとCloudWatch Logsの権限を追加して再デプロイした。最初の失敗時に作成された空のLog Groupが名前競合を起こしたため、対象名と保存バイト数を確認し、空であることを確認したLog Groupだけを削除してから再実行した。

```bash
aws logs describe-log-groups \
  --log-group-name-prefix /ai-statement-analyzer/

aws logs describe-log-groups \
  --log-group-name-prefix /ai-statement-analyzer/ \
  --query 'logGroups[].{Name:logGroupName,Bytes:storedBytes}'
```

#### 再発防止

失敗後にリソースを削除する場合は、対象名を完全一致で特定し、空の一時リソースであることを確認してから行う。Log Group全体や別Stackのリソースを一括削除しない。

### 3. NetworkStack: VPC、NAT Gateway、Security Group、Custom Resourceの権限不足

#### 症状

- VPC、Subnet、Route、Internet Gateway、NAT Gateway、Security Groupの作成・更新・削除で失敗した。
- Custom Resource用IAM RoleやLambdaの作成・削除・Invokeで失敗した。
- 失敗後の再デプロイでInternet GatewayのDetachや残存リソースのCleanupにも失敗した。

#### 原因

NetworkStackが使用するEC2/VPC APIに加え、CDKのCustom Resourceが使用するIAMとLambda APIの権限が、CDK execution roleに不足していた。CloudFormationの途中失敗により、VPC関連の部分的なリソースが残った。

#### 修正

EC2/VPC、IAM、Lambdaの不足権限を追加した。失敗したStackのイベントとAWS上のリソースを読み取り専用で確認し、対象Stackが管理していた残存リソースを整理してからNetworkStackを再デプロイした。最終的にVPC、NAT Gateway 1台、Private Application Subnet、Database Subnet、Security Groupの作成に成功した。

#### 再発防止

NetworkStackを初回デプロイする前に、execution roleがVPCとCDK Custom Resourceの実行に必要な権限を持つことを確認する。失敗したStackを削除・再作成する場合も、対象VPCとStackの所有関係を確認してから行う。

### 4. ContainerRegistryStack: ECR Repository作成権限不足

#### 症状

ECR Repositoryの作成でAccessDeniedになった。

#### 原因

CDK execution roleにECR Repository作成権限がなかった。

#### 修正

ECR Repositoryの作成・属性参照に必要な権限を追加して再デプロイした。その後、Docker ImageをECRへPushした。

#### 再発防止

ECR Repositoryの作成をCDKで行う場合は、Repositoryを先に手動作成するのではなく、execution roleのECR管理権限と、Docker Pushを行う利用者またはCIのECR認証権限を分けて確認する。

### 5. DatabaseStack: Secrets ManagerとRDSの権限不足

#### 症状

- Secrets Managerのランダムパスワード生成で失敗した。
- RDS Subnet Groupの参照で失敗した。

#### 原因

CDK execution roleにSecrets Managerのパスワード生成権限と、RDSのSubnet Group参照権限がなかった。

#### 修正

不足していたSecrets ManagerとRDSの権限を追加して再デプロイした。RDS InstanceとSecretの作成に成功し、Secretの値はCloudFormation Outputやログへ出していない。

#### 再発防止

RDSとSecretを作成するStackでは、Secretの値をコマンド出力へ展開しない。権限確認はSecretの値ではなく、CloudFormationイベントとSecret ARN、RDS Endpointなどの非機密な識別子で行う。

### 6. ApplicationStack: ECS、ALB、IAM Roleの権限不足

#### 症状

- ECS Cluster、Task Definition、Serviceの作成・更新で失敗した。
- Internal ALBやTarget Groupの作成で失敗した。
- IAM RoleのPolicy参照で失敗した。

#### 原因

CDK execution roleにECS、Elastic Load Balancing、IAM Role/Policy参照の権限が不足していた。

#### 修正

ECS、ELBv2、IAMの不足権限を追加した。ECRに対象Image Tagが存在することを確認してからApplicationStackを再デプロイした。ApplicationStackは最初にAPI/WorkerのDesired Countを0で作成し、Migration成功後にDesired Countを1へ更新した。

#### 再発防止

ApplicationStackをデプロイする前に、次を確認する。

- ECRに不変のImage Tagが存在する。
- `FRONTEND_ORIGIN`が指定されている。
- `BEDROCK_OCR_MODEL_ID`と必要なFoundation Model ARNが指定されている。
- API/WorkerのTask RoleとECS Execution Roleを混同していない。
- RDS Secret、Network、Log Group、Queueが先に作成済みである。

### 7. Migration Task: RDS PostgreSQLのSSL必須設定

#### 症状

Migration Taskが終了コード1で停止し、CloudWatch Logsに次の安全化されたエラーコードが記録された。

```text
no pg_hba.conf entry ..., no encryption
```

#### 原因

RDS PostgreSQL側でSSL接続が必須になっていたが、ECSの個別DB接続設定がSSLを有効にしていなかった。ローカルのDocker PostgreSQLではSSLなし接続が動くため、ローカル確認だけでは検出できなかった。

#### 修正

`DB_SSL`を追加し、`DB_SSL=true`の場合にNode.js PostgreSQL PoolへTLS設定を渡すようにした。ApplicationStackではECS環境変数を`DB_SSL=true`にし、ローカルの`.env.example`は`DB_SSL=false`とした。

```text
ローカル Docker PostgreSQL: DB_SSL=false
AWS RDS PostgreSQL:        DB_SSL=true
```

その後、Docker Imageを新しいTagでBuild・Pushし、ApplicationStackを更新してからMigrationを再実行した。Migrationは終了コード0、CloudWatch Logsは`migration_completed`になった。

#### 注意点

現在の設定は通信を暗号化するが、`rejectUnauthorized: false`のためRDSサーバー証明書の検証は行わない。証明書検証まで必要なProduction運用では、RDS CA BundleをImageまたは安全な設定経路へ提供し、`rejectUnauthorized: true`へ移行する。

### 8. 全テスト実行時のDB統合テスト

#### 症状

`npm test`ではUnit TestとCDK Template Testは成功したが、`test/database.test.ts`だけが`DATABASE_URL is required to run database integration tests`で失敗した。

#### 原因

DB統合テストは接続先を自動推測せず、`DATABASE_URL`を必須としている。これはCDKデプロイ失敗ではなく、テスト実行時の前提条件不足である。

#### 修正・実行方法

ローカルのテスト用PostgreSQLを起動し、テスト専用DBの接続文字列を指定して実行する。AWS RDSのSecret値をログやシェル履歴へ出さない。

```bash
DATABASE_URL=postgresql://app:<test-password>@127.0.0.1:5432/statement_analyzer_test npm test
```

AWS RDSに対してローカルから直接統合テストを行うのではなく、Migration成功、ECS内からの`/health/db`、必要なAPI/Workerの検証TaskでAWS接続を確認する。

## 今回の最終確認結果

RDS SSL修正後、次を確認してApplicationStackのデプロイを完了した。

- ApplicationStack: `UPDATE_COMPLETE`
- API Task: Desired 1 / Running 1
- Worker Task: Desired 1 / Running 1
- Internal ALB Target: `healthy`
- Internal ALB `/health`: HTTP 200
- Internal ALB `/health/db`: HTTP 200、`database: ok`
- Migration Task: 終了コード0、`migration_completed`

## 残存する運用上の注意

今回のデプロイ中に追加したCDK BootstrapのCloudFormation execution role権限は、AWSアカウント側の設定であり、現時点ではこのリポジトリのCDKコードには表現されていない。別アカウントやBootstrap再作成時にも同じデプロイを行う場合は、execution roleの権限セットをIAM管理コードまたはBootstrap手順へ移し、手動変更への依存をなくす。

SNS Subscriptionはデプロイ後にAWS側で登録し、Emailの場合はConfirmationを完了する。通知先のメールアドレスやSlack情報はリポジトリへ保存しない。
