# PLAN.md

## 現在の状態

Phase 0（設計）を完了し、Phase 1（ローカル開発環境）の実装・動作確認を完了した。Phase 2（Database）の開始前にPhase 1の学習内容を確認する。

## 作業ルール

- 1回の作業で1つの小さな責務だけを実装する。
- 各Phase開始前に、目的、必要性、内部処理、選択肢、採用理由を説明する。
- 各小実装後に成功・失敗の動作確認を行う。
- 各Phase終了後に、データフロー、重要コード、障害、Security、Cost、理解確認を記録する。
- ユーザーの設計承認なしにPhase 1へ進めない。
- 実装理由と未決定事項をドキュメントへ残す。
- AWSの現行仕様・料金は該当Phaseの開始時に公式情報を再確認する。

## Phase Gate

### Phase 0: Design

Deliverables:

- REQUIREMENTS.md
- ARCHITECTURE.md
- DATABASE_DESIGN.md
- API_DESIGN.md
- SECURITY_DESIGN.md
- COST_DESIGN.md
- LEARNING_PLAN.md
- PLAN.md
- README.md
- docs/配下の設計リファレンス
- learning/phase-00.md

Gate:

- Decision Requiredの項目をユーザーが確認する。
- 実装開始を明示的に承認する。

Phase 0 Gate: 完了。ユーザーのPhase 1着手指示を受けて実装した。

### Phase 1: Local Environment

1. Docker ComposeでPostgreSQLだけを起動する。
2. HonoのGET /healthを追加する。
3. DB接続healthを追加する。
4. 起動・停止・接続失敗を確認し、phase-01.mdを作る。

Status: 完了。TDD、typecheck、build、Docker PostgreSQL、APIとDBの正常系・障害系を確認済み。

次のGate: ユーザーがPhase 1の実装と学習記録を確認する。

### Phase 2: Database

1. migration実行基盤を追加する。
2. statements tableとstatus constraintを追加する。
3. transactions table、FK、UNIQUEを追加する。
4. Repositoryのinsert / state updateを追加する。
5. rollback、duplicate、FK failureをテストする。

Status: 実装・動作確認完了。Migration、Schema制約、Index、Repository、DB Transactionを追加し、ローカルPostgreSQLで20件のテストに成功した。

次のGate: Phase 2のMigration、制約、Transaction、学習記録を確認する。

### Phase 3: API

1. Honoのrequest / response型とZodを追加する。
2. POST /statementsを実装する。
3. GET /statements/{id}を実装する。
4. 400 / 404 / 409を確認する。

### Phase 4: S3

1. S3 clientとkey生成を追加する。
2. Presigned PUTを追加する。
3. HeadObjectでupload確認を追加する。
4. private access、TTL、Content-Type mismatchを確認する。

### Phase 5: SQS

1. QueueとDLQのlocal/AWS接続方針を決める。
2. analyze EndpointからstatementIdだけ送る。
3. 最小ConsumerでReceive / Deleteを確認する。
4. visibility timeoutとredriveを確認する。

### Phase 6: ECS Worker

1. API / Workerのprocess entrypointを分ける。
2. long pollingを追加する。
3. SIGTERMで受信停止・処理完了待ちを追加する。
4. heartbeat / stopTimeoutの設計を確認する。

### Phase 7: Bedrock AI-OCR

1. 実装開始時にModel Card、Region、画像入力、Structured Output、料金を再確認する。
2. Bedrock client adapterを追加する。
3. fixture imageでOCR responseを取得する。
4. JSON schema + Zod validationを追加する。
5. invalid response、throttle、timeoutをテストする。

### Phase 8: Idempotency

1. QUEUED -> PROCESSINGのAtomic claimを追加する。
2. leaseとprocessing tokenを追加する。
3. OCR結果保存とCOMPLETEDを同一Transactionにする。
4. COMMIT後DeleteMessageを固定する。
5. duplicate / crash / A-B raceをテストする。

### Phase 9: Retry / DLQ

1. retryable / permanent errorの分類を追加する。
2. transient error時にackしない。
3. permanent error時にFAILED + safe failure_codeを保存する。
4. maxReceiveCount、DLQ、Alarmを検証する。

### Phase 10: Monthly Analytics

1. 月境界を半開区間として実装する。
2. total / countをSQLで取得する。
3. category / merchant集計を追加する。
4. percentage / previous monthをBackendで追加する。
5. zero / first month / refundをテストする。

### Phase 11: AI Spending Insights

1. compact Analytics DTOを定義する。
2. Insights promptを作る。
3. Structured Output + Zodを追加する。
4. monthly_insights cacheを追加する。
5. invalid output / no previous month / Bedrock failureをテストする。

### Phase 12: Observability

1. JSON loggerとrequestIdを追加する。
2. statementIdをAPI・SQS・Workerでつなぐ。
3. SQS visible / oldest age / DLQ countを監視する。
4. Worker / Bedrock errorをAlarm対象にする。
5. sensitive dataが出ないテストを追加する。

### Phase 13: AWS Infrastructure

1. CDKでVPCとsubnetを作る。
2. S3、SQS、DLQ、RDSを作る。
3. ECR、ECS Cluster、API / Worker Serviceを作る。
4. ALB、HTTPS、Security Groupを作る。
5. IAM Role、Secrets、CloudWatchを最小権限で接続する。
6. NAT / Endpointの承認案を実装する。

### Phase 14: Cost Optimization

1. Cost Explorer / Pricing Calculatorで前提を更新する。
2. Learning stop procedureを実行する。
3. RDS stopの7日自動再起動を確認する。
4. S3 Lifecycle、Logs retention、ECS desiredCountを確認する。
5. cost.mdとCost Alarmを更新する。

## Definition of Done

- 実装だけでなく、開始前説明、動作確認、理解確認が残っている。
- Unit / Integration / Failure Scenarioテストが対応Phaseに存在する。
- SQS duplicate、DB rollback、lease recovery、DLQが説明できる。
- AI値のValidation、SQLの正確な集計、ログmasking、IAM分離を確認できる。
- AWS構成を削除・停止しても、意図したデータ保持とsnapshot方針が守られる。
