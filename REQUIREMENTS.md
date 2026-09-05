# REQUIREMENTS.md

## 目的

クレジットカード利用明細の画像を安全にアップロードし、Amazon BedrockでOCR・正規化・カテゴリ分類を行い、PostgreSQLの正確な集計をもとに月別DashboardとAI支出分析を提供する。

このプロジェクトの第一目的は、実装者が処理フロー、設計理由、重複配送、再試行、障害復旧、コスト、セキュリティを自分の言葉で説明できるようになることである。実装はPhaseごとに小さく進め、各Phaseで動作確認と理解確認を行う。

## スコープ

### MVPに含めるもの

- TypeScript / Node.js / HonoによるBackend API
- PostgreSQLによる明細状態・取引データ保存
- FrontendからS3へのPresigned URL PUTアップロード
- SQS Standard QueueとDLQによる非同期OCRジョブ
- ECS Fargate上のAPI ServiceとOCR Worker Service
- Amazon Bedrockによる画像OCR、merchant正規化、カテゴリ分類
- ZodによるAI出力Validation
- 月別の総支出、取引件数、カテゴリ別集計、merchant別集計
- 前月が存在する場合の増減計算
- SQLで確定したAnalyticsをBedrockに渡すAI Insights
- CloudWatch LogsとMVPに必要なメトリクス・Alarm
- IAM Least Privilege、Private RDS、S3 Block Public Access、暗号化、Lifecycle
- Unit / Integration / Failure Scenarioテスト

### MVPに含めないもの

- カード番号、セキュリティコード、口座情報の保存
- 明細画像の常時公開、FrontendへのAWS Credentials配布
- LLMによる金額計算、SQLの代替、根拠のない「使いすぎ」断定
- 複雑な家計簿ルール、予算管理、通知、モバイルアプリ
- 過剰なDDD、過剰なClean Architecture、不要なマイクロサービス分割
- 認証・認可の最終方式（公開利用には別途承認が必要）

## 対象データ

OCRで1明細行から以下を抽出する。

| 項目 | 要件 |
|---|---|
| 利用日 | ISO形式 `YYYY-MM-DD` に正規化できること |
| 利用先 | `merchantRaw` と正規化後の `merchantName` を持つこと |
| 金額 | 日本円の整数として保持すること。符号・返金の扱いはDecision Required |
| 行番号 | 1始まりで、同一statement内で一意であること |
| category | 許可されたカテゴリからのみ選ぶこと |
| subcategory | categoryに対応する許可値からのみ選ぶこと |

分析対象外のカード番号等をDBや通常ログに保存しない。画像に含まれる情報は、必要最小限の保持期間で削除する。

## カテゴリ

過剰に細分化せず、Backendの許可リストとZod schemaを単一の定義から生成する。

| category | subcategory |
|---|---|
| 食費 | 外食、コンビニ、スーパー、カフェ、その他 |
| 交通 | 電車、タクシー、飛行機、その他 |
| 買い物 | 日用品、衣服、EC、その他 |
| 娯楽 | その他 |
| サブスク | その他 |
| 旅行 | その他 |
| その他 | その他 |

## ユーザーストーリー

1. ユーザーは対象年月とファイル情報を送信し、画像アップロード用URLを取得できる。
2. ユーザーは取得した短期Presigned URLで、画像本体をBackendを経由せずS3にPUTできる。
3. ユーザーは解析開始を要求でき、APIはBedrockを同期呼び出しせずSQSに小さなジョブを投入できる。
4. WorkerはS3画像を取得し、Bedrock OCR結果をValidationしてDBへ保存できる。
5. 同じSQS Messageが二重配送されても、取引が二重登録されない。
6. ユーザーはstatementの処理状態と失敗理由を確認できる。ただし内部秘密やS3キーは返さない。
7. ユーザーは年月を選び、完了済み取引だけで月別集計を確認できる。
8. ユーザーはSQLで算出されたAnalyticsをもとにAI Insightsを取得できる。
9. 前月比較がない初月は、AIが「使いすぎ」と断定せず「目立つ支出」として表現する。

## API要件

- `POST /statements`: statementを作成し、Presigned PUT URLを返す。
- `POST /statements/{id}/analyze`: S3アップロード済みを確認してSQSへ投入する。
- `GET /statements/{id}`: 処理状態を返す。
- `GET /transactions?year=YYYY&month=M`: 完了済みの月別取引を返す。
- `GET /analytics/monthly?year=YYYY&month=M`: SQL集計を返す。
- `GET /analytics/monthly/insights?year=YYYY&month=M`: SQL集計をBedrockが解釈した、Validation済みInsightsを返す。

全エンドポイントは、認証を導入する場合はユーザー所有データだけを返す。認証を入れないローカルMVPをインターネットへ公開してはならない。

## 状態要件

画面上のアップロード前状態を表すため、実装上は `UPLOAD_PENDING` を許可する。ユーザー要求にある基本状態は以下の5つであり、`UPLOAD_PENDING` はその前段である。

```text
UPLOAD_PENDING -> UPLOADED -> QUEUED -> PROCESSING -> COMPLETED
                                      \\-> FAILED
```

`PROCESSING` のままWorkerが死亡した場合は、lease期限を過ぎたジョブを再取得できる。`FAILED`からの再解析を許すかは、retryable / permanent errorを区別して設計する。

## 非機能要件

- SQS Standardのat-least-once deliveryを前提に冪等処理する。
- DBのUNIQUE制約をアプリケーションコードの重複防止と併用する。
- DB COMMIT後にSQS `DeleteMessage`する。
- Visibility TimeoutはOCR処理のp99とheartbeatを考慮して設定する。
- WorkerはSIGTERMを受けたら新規受信を停止する。処理中Messageは通常、処理とDeleteMessageの完了を待つが、Shutdown要求後30秒を超えて完了しない場合は削除せず終了する。
- 失敗時に例外を握りつぶさず、statement status、構造化ログ、SQS受信回数を追跡できる。
- ログにカード番号、画像、raw AI response全体、Presigned URLを出さない。
- RDSはPrivate Subnetに置き、ALBのみを入口にする。
- API Task RoleとWorker Task Roleを分離し、AdministratorAccessを使わない。
- 料金・Region・確認日をコスト設計に記録する。

## 受け入れ条件

- 同じMessageを2回処理しても `transactions` の件数と合計金額が増えない。
- DB COMMIT成功後、DeleteMessage前にWorkerが停止しても、再配送されたMessageが安全にskipできる。
- DB保存前にWorkerが停止した場合、MessageがVisibility Timeout後に再配送され、lease取得に成功したWorkerが再処理できる。
- Bedrockが不正なJSON、未許可カテゴリ、不正日付、異常金額を返した場合、Frontendへ未検証値を返さず、定義したretryまたはFAILEDになる。
- 前月なしのAnalyticsでは、前月比や断定的な「使いすぎ」を生成しない。
- `GET /analytics/monthly` の金額・件数・割合はBackend / SQLの結果と一致する。
- S3公開アクセスが無効で、短時間のPresigned URL以外では画像を取得できない。
- APIとWorkerのIAM権限が設計した対象Resourceに限定されている。

## Decision Required（承認が必要）

以下は推奨案を記載しているが、Phase 1開始前にユーザーが選択・承認する。

1. **Bedrock Model / データレジデンシー**
   - Phase 7採用: `jp.amazon.nova-2-lite-v1:0`を既定値にし、Converse APIの画像入力、強制Tool選択、Tool input schemaを使う。実AWSで選択モデルが`strict`フィールドをサポートしないことを確認したため、Tool入力をZodで検証する。日本向けGeo inference profileのデータパスと利用可能RegionはModel Cardで確認する。
   - 代替: Claude Haiku 4.5。JSON Schema Structured Outputsは使いやすいが、今回のTokyoで画像入力を使う既定候補には採用しなかった。モデルIDは`BEDROCK_OCR_MODEL_ID`で変更可能にする。
2. **DB Library / Migration**
   - 推奨: `pg` + SQL migration（`node-pg-migrate`等の薄い実行器）。SQL、transaction、constraintを直接学べる。
   - 代替: Kysely（型安全SQL）、Prisma（生産性は高いがSQL理解が薄くなりやすい）。
3. **Frontend Framework**
   - 推奨: Vite + React + TypeScriptの小さなSPA。MVPの画面要件に対して十分。
   - 代替: Next.js（SSR / routingは強いが今回の学習対象には重い）、Vanilla TypeScript（依存は少ないが画面状態管理を自前化）。
4. **NAT Gateway vs VPC Endpoint**
   - 推奨Learning: 1 NAT Gateway + S3 Gateway Endpoint。低トラフィックではInterface Endpointを多数置くより単純・安価になりやすい。
   - 推奨Production-like: 2 AZにNAT Gatewayを各1台。NAT禁止・AWSサービスへの私設経路を優先する場合は、ECR、Logs、Secrets Manager、SQS、Bedrock Runtime等のInterface Endpointを2 AZに配置する。
5. **AI Insights API**
   - 推奨: 月次Analytics APIと分離したGET。SQL結果をキャッシュし、Bedrock障害でもDashboardの数値を表示する。最初は同期GET + キャッシュ、将来はInsights生成Jobの非同期化を検討する。
6. **ECS API / Worker Image**
   - 推奨MVP: 同じImage、`npm run api` / `npm run worker` をECS commandで切り替える。Task RoleとServiceは分離する。
   - 代替: Imageを分離。Worker依存が重い、リリース頻度が違う、攻撃面を分けたい場合に採用する。
7. **Worker scaling**
   - 推奨Learning: 必要な時間だけdesiredCount=1、終了時は0。ECS Service Auto Scalingのmin=0も可能だが、scale-outに遅延がある。
   - 推奨Production-like: min=1（可用性重視なら2）、SQSの可視メッセージ数・最古Message年齢をもとにmaxを制限してスケールする。
8. **S3 image retention**
   - 推奨MVP: 処理完了後も再確認・再処理のため最大30日、Lifecycleで自動削除。厳格なプライバシー優先なら完了後7日に短縮する。
   - 構造化済みtransactionsは画像とは別の保持方針にし、カード番号等は保存しない。
9. **認証**
   - Decision Required: ローカルMVPを単一ユーザー前提にするか、Cognito等で所有者分離をPhase 13までに入れるか。公開環境で認証なしは禁止。
10. **金額符号・返金**
    - 推奨: `amount`は円の整数で、返金を負数として扱う。OCRが符号を判定できない場合のmanual review方針はPhase 7で決める。

## 仕様確認時点

- 確認日: 2026-09-01
- 対象Region: `ap-northeast-1`（Tokyo）
- AWS仕様・モデル・料金は変わるため、Phase 7で公式ドキュメントを確認した。Phase 13のdeploy開始時にも、利用可能Region、モデルアクセス、料金、IAMアクションを再確認する。
