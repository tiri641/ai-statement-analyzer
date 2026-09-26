# Phase 13 AWSデプロイ・destroy失敗記録と切り分け手順

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

`DB_SSL`を追加し、`DB_SSL=true`の場合にNode.js PostgreSQL PoolへTLS設定を渡すようにした。ApplicationStackではECS環境変数を`DB_SSL=true`にし、ローカルの`.env.example`は`DB_SSL=false`とした。`DATABASE_URL`方式でも`DB_SSL=true`を指定した場合は同じTLS検証を有効にする。

```text
ローカル Docker PostgreSQL: DB_SSL=false
AWS RDS PostgreSQL:        DB_SSL=true
```

その後、Docker Imageを新しいTagでBuild・Pushし、ApplicationStackを更新してからMigrationを再実行した。Migrationは終了コード0、CloudWatch Logsは`migration_completed`になった。

#### 証明書検証

RDSの`rds-ca-rsa2048-g1` Root CAを`rds-ca-rsa2048-g1.pem`としてImageへ含め、Node.jsの`NODE_EXTRA_CA_CERTS`で信頼ストアへ追加している。`DB_SSL=true`では`rejectUnauthorized: true`を使用するため、通信の暗号化だけでなくRDSサーバー証明書の検証も行う。現在のCAファイルは`ap-northeast-1`用であり、別リージョンへ展開する場合は対象リージョンのCAバンドルへ差し替えてImageをBuildする。CAを更新する場合は、AWS公式の東京リージョンCAバンドル（https://truststore.pki.rds.amazonaws.com/ap-northeast-1/ap-northeast-1-bundle.pem）から対象Root CAを更新し、Imageを再Buildする。

### 8. 全テスト実行時のDB統合テスト

#### 症状

`npm test`ではUnit TestとCDK Template Testは成功したが、`test/database.test.ts`だけが`DATABASE_URL is required to run database integration tests`で失敗した。

#### 原因

DB統合テストは接続先を自動推測せず、`DATABASE_URL`を必須としている。これはCDKデプロイ失敗ではなく、テスト実行時の前提条件不足である。

#### 修正・実行方法

ローカルのテスト用PostgreSQLを起動し、テスト専用DBの接続文字列を指定して実行する。AWS RDSのSecret値をログやシェル履歴へ出さない。

```bash
read -r -s TEST_DATABASE_PASSWORD
export DATABASE_URL="postgresql://app:${TEST_DATABASE_PASSWORD}@127.0.0.1:5432/statement_analyzer_test"
npm test
unset DATABASE_URL TEST_DATABASE_PASSWORD
```

AWS RDSに対してローカルから直接統合テストを行うのではなく、Migration成功、ECS内からの`/health/db`、必要なAPI/Workerの検証TaskでAWS接続を確認する。

## cdk destroyで発生した失敗と残存リソース

今回の削除では、アプリケーション用Stackの削除と、CDKがデプロイに使用するBootstrap Stackの削除は別の処理として扱う必要があった。次の順番で切り分ける。

### 1. `cdk: command not found`

#### 症状

グローバルインストールされたCDK CLIを前提に、次のコマンドを実行したところ、シェルが`cdk`を見つけられなかった。

```text
/bin/bash: cdk: command not found
```

#### 原因と修正

このリポジトリではCDK CLIをプロジェクトの開発依存として管理しており、実行環境のPATHにグローバルの`cdk`コマンドが存在するとは限らない。リポジトリの依存関係を使って実行する。

```bash
npx cdk destroy --all --force
```

実行前に`npm install`または`npm ci`が完了していること、AWS CLIの認証済みアカウントとリージョンが意図した対象であることを確認する。

### 2. DatabaseStackがRDSの最終スナップショット作成権限で失敗した

#### 症状

ApplicationStack、StorageStack、ObservabilityStack、ContainerRegistryStackの削除後、DatabaseStackが次のエラーで`DELETE_FAILED`になった。

```text
not authorized to perform: rds:CreateDBSnapshot
```

#### 原因

DatabaseStackのRDSインスタンスには、削除時に最終スナップショットを作成する`DeletionPolicy: Snapshot`が設定されていた。CloudFormationはCDK execution roleを使って削除するため、通常のデプロイに必要な権限があっても、RDSスナップショット作成権限がなければ削除処理だけが失敗する。

#### 修正

CDK BootstrapのCloudFormation execution roleに、対象環境の運用方針に従って次のRDS権限を付与した後、destroyを再実行した。

- `rds:CreateDBSnapshot`
- `rds:DeleteDBSnapshot`
- `rds:DescribeDBSnapshots`

```bash
npx cdk destroy --all --force
```

再実行でDatabaseStackを含む残りのアプリケーションStackは削除できた。スナップショットを復旧に利用しない場合は、destroy成功後に対象識別子を確認してから手動削除する。スナップショット削除は復旧手段を失わせるため、先に保持要否を判断する。

#### 再発防止

本番データを保持する環境では、RDSの最終スナップショットを残す設計を維持し、削除専用の権限を安易に広げない。検証環境を完全削除する場合は、次のどちらかを事前に決めておく。

- スナップショットを残す: execution roleにスナップショット作成権限を用意する。
- スナップショットを残さない: 対象環境だけ削除ポリシーを変更し、データを失うことを明示的に承認する。

### 3. `Retain`またはStack外管理のリソースが残った

#### 症状

CloudFormation Stackが削除済みでも、次のリソースが残った。

- アプリケーション用S3バケット
- アプリケーション用ECRリポジトリ
- API/WorkerのCloudWatch Logsロググループ

#### 原因と修正

`RemovalPolicy.RETAIN`、データ保護のための削除ポリシー、またはStackとは別に管理されるリソースは、Stack削除だけでは消えない。空のS3バケットでも、バケット自体の削除が別途必要である。

削除する場合は、アカウント・リージョン・名前を照合し、対象を限定してから実行する。

```bash
# S3: 中身を確認してから、対象バケットだけを削除
aws s3api list-objects-v2 --bucket <application-bucket>
aws s3api delete-bucket --bucket <application-bucket>

# ECR: 対象リポジトリとイメージを確認してから削除
aws ecr describe-repositories --repository-names <application-repository>
aws ecr delete-repository --repository-name <application-repository> --force

# CloudWatch Logs: 対象ロググループだけを確認してから削除
aws logs describe-log-groups --log-group-name-prefix /ai-statement-analyzer/
aws logs delete-log-group --log-group-name <application-log-group>
```

ロググループは`storedBytes`が0でもリソースとして残る。ECRのイメージやS3オブジェクトが残っている場合は、保持方針と復旧要否を確認してから削除する。

### 4. `cdk destroy --all`で`CDKToolkit`は削除されなかった

#### 原因

`cdk destroy --all`の対象はアプリケーションStackであり、CDK CLIのBootstrapで作成した`CDKToolkit` Stackは別管理である。`CDKToolkit`には、CDKアセット用S3バケット、ECRリポジトリ、デプロイ用IAM Roleなど、今後のCDKデプロイに必要な共有リソースが含まれる。

#### 修正と注意点

他のアプリケーションStackや、同じアカウント・リージョンを使う別のCDKプロジェクトがないことを確認した場合だけ、次の順で削除する。削除すると、次回のCDKデプロイ前に`cdk bootstrap`が必要になる。

```bash
aws cloudformation list-stacks \
  --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE UPDATE_ROLLBACK_COMPLETE

aws cloudformation delete-stack --stack-name CDKToolkit
```

BootstrapのS3バケットにオブジェクトが残っている場合、`aws s3 rm --recursive`だけでは不十分なことがある。バージョニングされたバケットでは、古いオブジェクトバージョンとDelete Markerもすべて削除してから、バケットを削除する。

```bash
aws s3api list-object-versions --bucket <cdk-bootstrap-bucket>
# 出力した対象のVersionIdを確認し、VersionsとDeleteMarkersを削除する
aws s3api delete-object --bucket <cdk-bootstrap-bucket> --key <key> --version-id <version-id>
aws s3api delete-bucket --bucket <cdk-bootstrap-bucket>
```

このバケット削除は、対象がCDK Bootstrap専用であることを確認した場合に限る。CDKを継続利用する場合は`CDKToolkit`を削除せず、Bootstrapリソースを残す。

### 5. destroy後の課金確認

削除完了後は、CloudFormationのStackだけでなく、次の残存リソースを確認する。検索結果が空であることと、Cost Explorerで継続的な利用が発生していないことを別々に確認する。

```bash
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE
aws s3api list-buckets
aws ecr describe-repositories
aws rds describe-db-instances
aws rds describe-db-snapshots --snapshot-type manual
aws ec2 describe-nat-gateways --filter Name=state,Values=pending,available,deleting
aws ecs list-clusters
aws elbv2 describe-load-balancers
```

Cost Explorerには反映遅延があるため、destroy直後に過去の利用料金が消えるわけではない。今回も削除後の継続リソースは確認されなかったが、実行期間中のS3、Bedrock、Secrets Managerなどの利用料金は履歴として残る。最終確認では、対象リージョンのリソース一覧が空であること、当日以降に新しい利用が増えていないことを時間を置いて確認する。

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
