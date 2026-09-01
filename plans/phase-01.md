# Phase 1: Local Environment 実装Plan

## 目的

ローカルでBackend APIを起動し、PostgreSQLへの接続とDB障害時のレスポンスを検証できる構成を作る。

Phase 1ではAWS、S3、SQS、Bedrock、ECS、CDK、Frontend、migration、業務テーブルを実装しない。

## 作業ブランチ

- 基点: GitHubのmain
- ブランチ: phase-01/local-environment
- mainへ直接commitしない

## 使用技術

- Node.js v24系
- npm
- TypeScript
- Hono
- @hono/node-server
- pg（node-postgres）
- dotenv
- tsx
- Node.js標準のnode:test
- Docker Compose
- PostgreSQL 16 Alpine

ローカルAPIは127.0.0.1にbindする。ECSへ移行するPhaseでは、コンテナの受信要件に合わせてHOSTを0.0.0.0へ変更する。

## ローカル構成

APIはホスト環境で起動し、PostgreSQLだけをDocker Composeで起動する。

ホスト:

- Node.js
- Hono API
- pg Connection Pool

Docker Compose:

- PostgreSQL 16
- Named Volume: postgres_data
- PostgreSQL healthcheck: pg_isready

APIをDocker化しない理由は、Phase 1ではNode.js APIとPostgreSQLの接続確認に集中し、DockerfileやECS用コンテナ設計をPhase 13まで持ち込まないためである。

## 作成・更新ファイル

- plans/phase-01.md
- package.json
- package-lock.json
- tsconfig.json
- .env.example
- .gitignore
- docker-compose.yml
- src/app.ts
- src/server.ts
- test/app.test.ts
- README.md
- learning/phase-01.md

## PostgreSQL

- Image: postgres:16-alpine
- Database: statement_analyzer
- User: app
- Port: 5432
- Named Volume: postgres_data
- healthcheck: pg_isready -U app -d statement_analyzer

Phase 1ではmigrationと業務テーブルを作らない。

## API契約

### GET /health

APIプロセスの生存確認だけを行う。DBへ接続しない。

- 成功: HTTP 200
- Body: status=ok、service=api

### GET /health/db

PostgreSQLへ接続し、SELECT 1を実行する。

- 成功: HTTP 200、status=ok、database=ok
- 失敗: HTTP 503、status=error、database=unavailable

DB接続文字列、hostname、username、password、stack traceはレスポンスへ返さない。

## Application設計

- src/app.tsはHono Appとrouteを定義する。
- src/server.tsはdotenv、pg.Pool、HTTP server、signal処理を定義する。
- AppとServerを分離し、testからAppを直接呼べるようにする。
- DB依存はAppへ注入し、テストではFake DBを使用する。
- API終了時はHTTP受付停止後にPoolを終了する。

Phase 1ではRepository層、Service層、DIコンテナを追加しない。

## TDD手順

### Red

実装前にtest/app.test.tsを作成する。

テスト内容:

1. /healthがHTTP 200を返す。
2. /healthがstatus=ok、service=apiを返す。
3. /healthがDB queryを実行しない。
4. /health/dbがquery成功時にHTTP 200を返す。
5. /health/dbがquery失敗時にHTTP 503を返す。
6. /health/dbが内部エラー詳細を返さない。

npm testを実行し、対象実装がないため失敗することを確認する。

### Green

テストを成功させるための最小限のHono App、health route、DB query、503 handlingだけを追加する。

### Refactor

- AppとHTTP Serverを分離する。
- DB依存をテスト可能な形にする。
- エラー詳細を外部レスポンスへ出さない。
- 不要な抽象化を追加しない。
- Phase 1の範囲外の機能を追加しない。

Refactor後にnpm testを再実行する。

## npm scripts

- npm run dev: tsx watchでAPI起動
- npm run api: API起動
- npm run build: TypeScript compile
- npm run start: compile済みAPI起動
- npm run typecheck: 型チェック
- npm test: Node.js標準test runner

## 環境変数

.env.exampleに以下を記載する。

- NODE_ENV=development
- PORT=3000
- DATABASE_URL=postgresql://app:local_dev_password@localhost:5432/statement_analyzer

.envは.gitignoreへ追加し、commitしない。本番Secret、AWS credentials、実際のパスワードは記載しない。

## 動作確認

### 自動確認

- npm test
- npm run typecheck
- npm run build
- docker compose config

### 正常系

1. docker compose up -d db
2. PostgreSQLのhealthcheckがhealthyになることを確認
3. npm run dev
4. GET /healthがHTTP 200になることを確認
5. GET /health/dbがHTTP 200になることを確認

### DB障害系

1. PostgreSQLを停止する。
2. GET /healthがHTTP 200であることを確認する。
3. GET /health/dbがHTTP 503であることを確認する。
4. APIプロセスが継続することを確認する。
5. PostgreSQLを再起動する。
6. GET /health/dbがHTTP 200へ戻ることを確認する。

### Volume確認

docker compose down後にdocker compose up -d dbを実行し、Named Volumeを再利用して起動できることを確認する。docker compose down -vは使用しない。

## Security

- .envをcommitしない。
- DATABASE_URLやDB credentialsをレスポンス・ログへ出さない。
- PostgreSQL内部エラーを外部へ返さない。
- APIを外部公開しない。
- AWS credentialsを使用しない。

## 完了条件

- mainからphase-01/local-environmentを作成している。
- plans/phase-01.mdが存在する。
- TDDのRed、Green、Refactorを確認している。
- APIとPostgreSQLがローカルで接続できる。
- DB停止時に/health/dbが503になる。
- typecheck、build、testが成功する。
- AWS、migration、業務テーブルが追加されていない。
- READMEのLocal Setupを更新している。
- learning/phase-01.mdへ実装後の学習記録を追記している。
- 作業ブランチへcommitしてpushしている。

## Phase 1で理解する質問

1. /healthと/health/dbを分ける理由は何か。
2. Docker ComposeでPostgreSQLを起動する理由は何か。
3. Named Volumeの役割は何か。
4. Connection Poolの役割は何か。
5. DB停止時に503を返す理由は何か。
