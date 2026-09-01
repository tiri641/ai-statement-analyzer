# LEARNING_PLAN.md

## 学習の進め方

各Phaseは次の順序で進める。

1. 開始前説明: 何を作るか、なぜ必要か、内部で何が起きるか、選択肢、採用理由
2. 小さな実装: 1つの責務だけを追加
3. 動作確認: 成功系と失敗系を確認
4. 理解整理: データフロー、重要コード、障害、Security、Costを自分の言葉で記録
5. 3〜5問の理解確認に回答
6. 次Phaseへ進むかレビューする

ユーザーによる設計承認まではPhase 1のコードを作らない。各Phaseの実施後に learning/phase-XX.md を作成し、未実施のPhaseの学習記録を先に捏造しない。

## Phase 0: Design（現在のPhase）

### 開始前に説明すること

- 何を作るか: Requirements、Architecture、DB、API、Security、Cost、学習計画を固定する。
- なぜ必要か: 実装後に責務・状態・障害対応が場当たり的になることを防ぐ。
- 内部で起きること: Frontend -> Presigned S3 -> API -> SQS -> Worker -> Bedrock -> DB -> SQL Analytics -> Insightsという境界を定義する。
- 選択肢: 同期OCR / 非同期OCR、NAT / Endpoint、同一Image / 分離Image、同期Insights / 非同期Insights。
- 採用理由: OCRは非同期、金額はSQL、AIは解釈、低コストLearningとProduction-likeを分ける。

### 完了条件

- 8つのルート設計書があり、Decision Requiredが明示されている。
- MermaidでAWS、Upload、OCR、Retry、Analytics sequenceを説明できる。
- AWSの現行仕様・料金・Bedrock model確認日が記録されている。
- ユーザーが設計をレビューし、Phase 1開始を承認する。

### 理解確認（回答付き）

1. なぜ最初に設計書を作るのか。責務、状態、障害、コストをコードより先に比較し、後から説明できる形にするため。
2. なぜAIに金額計算をさせないのか。LLMは決定的な算術・再現性・監査に向かないため、SQLを正とする。
3. なぜDB COMMIT -> DeleteMessageの順か。逆だとMessage削除後のWorker停止でDB保存なしにジョブが消えるため。
4. なぜSQS Standardで冪等性が必要か。at-least-once deliveryで同じMessageが複数回配送される可能性があるため。
5. なぜInsights APIを分けるのか。Bedrockの遅延・費用・失敗を数値Dashboardから分離し、cacheできるため。

## Phase 1: Local Environment

- 作るもの: Docker ComposeのPostgreSQLと最小Hono health API。
- 必要性: AWSへ出す前にHTTP、DB接続、環境変数、ログの基本を安定させる。
- 内部処理: Browser / curl -> Hono -> process -> response、DBはまだhealth確認に限定する。
- 選択肢: local PostgreSQL、Docker PostgreSQL、RDS。推奨はDocker。
- 選択理由: 再現可能で低コスト、AWS障害とアプリ障害を切り分けやすい。
- 完了条件: GET /health、DB接続health、起動・停止、失敗時ログを確認。
- 質問: Honoの責務は何か / DBをlocalにする理由は何か / envをcommitしない理由は何か。

## Phase 2: Database

- 作るもの: migrations、statements、transactions、制約、最小Repository。
- 必要性: 状態遷移と整合性の土台を作る。
- 内部処理: migration -> schema -> parameterized query -> transaction。
- 選択肢: pg + SQL、Kysely、Prisma。推奨はpg + SQL。
- 選択理由: SQL、UNIQUE、FK、Atomic updateを理解しやすい。
- 完了条件: insert、FK違反、duplicate line、rollbackをテスト。
- 質問: UNIQUEは何を守るか / FKは何を守るか / rollback後に何が残るか。

## Phase 3: API

- 作るもの: statement作成、status取得、入力Validation、Presigned URLの契約（URL生成は次Phaseでもよい）。
- 必要性: FrontendとBackendの責務境界を固定する。
- 内部処理: HTTP -> Zod -> DB -> DTO。
- 選択肢: REST、GraphQL。推奨はREST。
- 選択理由: endpointとHTTP statusを説明しやすく、MVPに十分。
- 完了条件: success、bad request、not found、state conflictを確認。
- 質問: APIが画像を受けない理由は何か / 202の意味は何か / DTOを分ける理由は何か。

## Phase 4: S3

- 作るもの: private bucket、Presigned PUT、upload確認、Lifecycle。
- 必要性: 大きい画像をAPIへ通さず、CredentialsをBrowserへ渡さない。
- 内部処理: API署名 -> Browser PUT -> S3 -> API HeadObject。
- 選択肢: API proxy upload、Presigned PUT、multipart。推奨は小画像のPresigned PUT。
- 選択理由: API帯域・memoryを節約し、AWS認証情報をBrowserへ出さない。
- 完了条件: 正しいContent-Type成功、期限切れ失敗、公開GET失敗、Lifecycle確認。
- 質問: Presigned URLは何者か / なぜ短命か / Block Public Accessだけで十分か。

## Phase 5: SQS

- 作るもの: Standard Queue、DLQ、API Producer、最小Consumer。
- 必要性: AI処理の遅延・retry・HTTP timeoutを分離する。
- 内部処理: DB状態 -> SendMessage(statementId) -> Receive -> Delete。
- 選択肢: 同期Bedrock、SQS、EventBridge等。推奨はSQS。
- 選択理由: retry、visibility、DLQ、Consumer学習に適する。
- 完了条件: long polling、visibility expiry、delete、redriveを確認。
- 質問: Producer/Consumerとは / Visibility Timeoutとは / Deleteしないとどうなるか / なぜ重複するか。

## Phase 6: ECS Worker

- 作るもの: SQS long polling Worker、SIGTERM、heartbeatの骨格。
- 必要性: 常駐APIと重い処理を分離し、ECS停止時も処理を壊さない。
- 内部処理: Receive -> handler -> ack or leave for retry、SIGTERMでreceive停止。
- 選択肢: Lambda、ECS、Kubernetes。推奨はECS Fargate。
- 選択理由: long-running worker、同一image、AWSの実務構成を学べる。
- 完了条件: graceful shutdown、visibility、例外時にackしないことを確認。
- 質問: SIGTERM時にMessageを消さない理由は / stopTimeoutとは / long pollingの利点は。

## Phase 7: Bedrock AI-OCR

- 作るもの: image input、Converse、Structured Output、Zod validation。
- 必要性: OCRと分類を実装する。
- 内部処理: S3 bytes -> Bedrock -> JSON -> Zod -> domain object。
- 選択肢: Claude Haiku 4.5、Nova Lite、専用OCR。推奨はClaude Haiku 4.5 Structured Output案。
- 選択理由: current model cardで画像入力・Converse・Structured Outputを確認。ただしJP Geoのデータ経路を承認する。
- 完了条件: valid、invalid date、invalid amount、unknown category、throttlingの挙動を確認。
- 質問: Structured OutputでもなぜZodが必要か / model IDをenv化する理由は / OCRと分類の責務は。

## Phase 8: Idempotency

- 作るもの: Atomic claim、lease、processing token、UNIQUE、DB Transaction。
- 必要性: duplicate deliveryとWorker crashに耐える。
- 内部処理: conditional UPDATE -> process -> transaction -> commit -> delete。
- 選択肢: distributed lock、FIFO deduplication、DB claim。推奨はDB claim + constraint。
- 選択理由: RDSを正とし、Standard Queueでも保証できる。
- 完了条件: same message twice、A/B race、crash before commit、crash after commitをテスト。
- 質問: 0 rows updatedの意味は / UNIQUEとidempotencyの違いは / fencing tokenの意味は。

## Phase 9: Retry / DLQ

- 作るもの: error classification、visibility、maxReceiveCount、FAILED更新、Alarm対象。
- 必要性: 一時障害は救い、恒久エラーは無限retryしない。
- 内部処理: SDK retry -> worker result -> SQS redrive -> DLQ。
- 選択肢: 全てretry、全てFAILED、分類。推奨は分類。
- 完了条件: throttling retry、unsupported image FAILED、DLQ redriveを確認。
- 質問: SDK retryとSQS retryの違いは / maxReceiveCountとは / DLQ後に自動再実行してよいか。

## Phase 10: Monthly Analytics

- 作るもの: 月別総額・件数・category・merchant・前月比較。
- 必要性: 正確なDashboardとAI入力を作る。
- 内部処理: PostgreSQL SUM/COUNT/GROUP BY -> Backend percentage/delta。
- 選択肢: Frontend集計、Backend集計、DB集計。推奨はSQL + Backend整形。
- 完了条件: 0件、初月、返金、割合丸め、前月比をテスト。
- 質問: なぜFrontendで集計しないか / 半開区間とは / 0円除算をどう扱うか。

## Phase 11: AI Spending Insights

- 作るもの: 集計値からのStructured Insights、Zod、cache。
- 必要性: 数値の理由を自然言語で説明する。
- 内部処理: SQL analytics -> compact prompt -> Bedrock -> Zod -> cache。
- 選択肢: 毎回生成、cache、非同期Insights。推奨は分離Endpoint + cache。
- 完了条件: 前月比較あり・なし、invalid insight、Bedrock timeout、cache hitを確認。
- 質問: LLMに何を渡してはいけないか / 初月に何と表現するか / cache invalidationはいつか。

## Phase 12: Observability

- 作るもの: structured logs、MVP metrics、Alarm。
- 必要性: 非同期処理の見えない失敗を追跡する。
- 内部処理: API / Worker event -> CloudWatch Logs、SQS metrics -> Alarm。
- 選択肢: 全てcustom metrics、Logsのみ、主要service metrics。推奨は主要service metrics + structured logs。
- 完了条件: statementIdで一連の処理を追える、DLQとoldest ageを検知。
- 質問: 何をログに出してはいけないか / DLQ alarmの価値は / message ageは何を示すか。

## Phase 13: AWS Infrastructure

- 作るもの: CDKでVPC、ALB、ECS、RDS、S3、SQS、DLQ、IAM、CloudWatch。
- 必要性: Localで確認した処理をAWSのprivate networkへ移す。
- 内部処理: CDK -> CloudFormation -> Resource -> ECS task -> AWS SDK。
- 選択肢: NAT、Interface Endpoint、managed DB、local DB。各費用と通信先で選ぶ。
- 完了条件: deploy、HTTPS、private RDS、task role、ECR image、ECS stop/redeploy。
- 質問: execution roleとtask roleの違いは / private subnetから何へ通信するか / SGの向きは。

## Phase 14: Cost Optimization

- 作るもの: cost documentation、停止手順、retention、cost alarm。
- 必要性: セキュリティを落とさず学習コストを制御する。
- 内部処理: desiredCount / RDS stop / Lifecycle / endpoint choice -> bill。
- 選択肢: 常時起動、時間起動、ローカル中心。推奨は時間起動。
- 完了条件: 1日概算、月額概算、NAT vs Endpoint、削減による損失を説明。
- 質問: ECS=0で何が残るか / RDS stop後も何に課金されるか / NATをなくせば必ず安いか。
