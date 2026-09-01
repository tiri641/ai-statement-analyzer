# Phase 01: ローカル開発環境

## 状態

実施済み。作業ブランチ: phase-01/local-environment

## 開始前の説明

### 何を作るか

Node.js + TypeScript + HonoのAPIをホスト環境で起動し、PostgreSQL 16をDocker Composeで起動する。APIにはAPI生存確認とDB接続確認の2つのEndpointを追加する。

### なぜ必要か

AWSサービスを使う前に、HTTP APIの起動、DB接続、DB障害時のレスポンスをローカルで検証するためである。Phase 1ではAWSや業務データを扱わないため、アプリケーションの基本動作に集中できる。

### 内部で何が起きるか

GET /healthはDBへ接続せず、APIプロセスの生存状態だけを返す。GET /health/dbはpg Connection PoolからPostgreSQLへSELECT 1を実行し、成功時は200、接続失敗時は503を返す。

### 選択肢と採用理由

- PostgreSQLをホストへ直接インストールする方法: OSごとの差が増えるため採用しない。
- PostgreSQLをDocker Composeで起動する方法: バージョンと設定を固定できるため採用した。
- APIもDockerで起動する方法: Phase 1の対象が広がるため、APIはホスト起動とした。
- /healthへDB確認を統合する方法: API生存とDB依存障害を分離できないため、/healthと/health/dbを分離した。

## 作ったもの

- Node.js v24系 + npmのTypeScriptプロジェクト
- Hono API
- pgのConnection Pool
- Docker ComposeのPostgreSQL 16 Alpine
- postgres_data Named Volume
- GET /health
- GET /health/db
- APIのSIGINT / SIGTERM処理
- Node.js標準test runnerによるテスト
- plans/phase-01.md

## データフロー

```text
HTTP Client
  ↓
Hono API
  ↓
pg Connection Pool
  ↓
Docker PostgreSQL
```

## TDDの記録

1. `/health`と`/health/db`の期待動作をテストに記述した。
2. App実装が存在しない状態でRedを確認した。
3. Hono AppとDB依存注入を実装した。
4. Greenを確認した。
5. API Server、App、DB依存を分離し、timeoutと安全なエラー応答を追加した。
6. Refactor後にtest、typecheck、buildを再実行して成功した。

## 重要コード

- `src/app.ts`: health EndpointとDB接続失敗時の503を定義。
- `src/server.ts`: 環境変数、Pool、HTTP Server、timeout、Graceful Shutdownを定義。
- `test/app.test.ts`: Fake DBを使ってDB接続の成功・失敗を検証。
- `docker-compose.yml`: PostgreSQL、healthcheck、Named Volumeを定義。

## 動作確認結果

- PostgreSQLコンテナ: `postgres:16-alpine`でhealthy
- `/health`: DB起動中・停止中ともにHTTP 200
- `/health/db`: DB起動中はHTTP 200、停止中はHTTP 503、復旧後はHTTP 200
- DB停止時の接続待機: Poolの接続・query timeoutにより短時間で503
- API停止時: `api_shutdown_started`から`api_shutdown_completed`まで確認
- `npm test`: 成功
- `npm run typecheck`: 成功
- `npm run build`: 成功
- `docker compose config`: 成功

## 障害時の挙動

PostgreSQL停止時もAPIプロセスは生存し、`/health`は200を返す。一方、DBに依存する`/health/db`は503を返す。DB内部エラー、接続文字列、パスワードはレスポンスへ含めない。

APIがSIGINTまたはSIGTERMを受けると、新規HTTP受付を止め、pg Poolを終了してから終了ログを出す。WorkerのMessage処理やSQSのGraceful ShutdownはPhase 6で扱う。

## Security

- `.env`は`.gitignore`に含め、commitしない。
- `.env.example`にはローカル開発専用の値だけを記載した。
- DB接続情報や内部エラーをHTTPレスポンスへ返さない。
- APIは127.0.0.1へbindし、Phase 1では外部公開しない。
- AWS credentialsは使用していない。

## Cost

Phase 1ではAWSリソースを作成していないため、ECS、RDS、ALB、NAT、Bedrock等の料金は発生しない。PostgreSQLはローカルDockerで実行し、Named Volumeはローカルディスクを使用する。

## 理解確認

### 1. /healthと/health/dbを分ける理由は何か

`/health`はAPIプロセス自体の生存、`/health/db`はDBという依存サービスの状態を確認するためである。DB停止時でも、APIが生きているかを別に確認できる。

### 2. Docker ComposeでPostgreSQLを起動する理由は何か

PostgreSQLのversion、環境変数、port、volume、healthcheckを設定ファイルで再現できるためである。

### 3. Named Volumeの役割は何か

PostgreSQLコンテナのライフサイクルとDBデータのライフサイクルを分離する。コンテナを再作成しても、volumeを削除しなければデータを保持できる。

### 4. Connection Poolの役割は何か

DB接続をPoolで管理し、各リクエストが接続を効率よく再利用できるようにする。API停止時にはPoolを閉じる。

### 5. DB停止時に503を返す理由は何か

APIは起動していてもDB依存処理は利用できないことを、HTTP標準のService Unavailableとして伝えるためである。

## Phase 1で扱わなかったもの

S3、SQS、Bedrock、ECS、CDK、Frontend、migration、statements、transactions、OCR、Worker、Retry、Idempotencyは後続Phaseで扱う。
