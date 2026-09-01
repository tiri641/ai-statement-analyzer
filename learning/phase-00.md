# Phase 00: Design Review

## Status

設計書作成済み。コード実装・AWS Resource作成は未実施。ユーザー承認待ち。

## 今回決めたこと

- FrontendからS3へ短期Presigned PUTを行う。
- APIはstatement作成・状態参照・SQS投入・SQL Analyticsを担当する。
- AI OCRはSQSを介したECS Workerで非同期に実行する。
- SQS Standardのduplicate deliveryを前提に、DB Atomic claim、lease、processing token、UNIQUE制約、Transactionを使う。
- 数値はPostgreSQL / Backendを正とし、Bedrockは解釈だけを行う。
- InsightsはAnalyticsと分離したEndpointとcacheを推奨する。
- APIとWorkerはMVPで同一Docker Image、Task Roleは別にする。
- LearningはNAT 1台 + S3 Gateway Endpoint、Production-likeはNAT 2台を基本候補にする。

## 設計を説明する練習

画像はAPIへ渡さず、APIが生成した短期URLでBrowserからprivate S3へPUTする。アップロード完了後、APIはstatementIdだけをSQSへ送る。WorkerはSQSから受信し、DBで処理権をAtomicに取得してからS3画像をBedrockへ渡す。AI結果をZodで検証し、DB TransactionをCOMMITした後にだけSQS Messageを削除する。重複配送やCOMMIT後の停止は、statusとUNIQUE制約によって二重登録にならない。SQLが月別の金額と件数を計算し、その確定値をBedrockが自然言語のInsightsへ解釈する。

## 障害時の説明

- DB保存前にWorkerが停止するとMessageは削除されず、Visibility Timeout後に再配送される。
- DB COMMIT後、DeleteMessage前に停止すると再配送されるが、次のWorkerはCOMPLETEDまたはUNIQUE制約を見て二重登録しない。
- PROCESSING中にWorkerが死亡するとlease期限後に別Workerが再claimする。
- Bedrock throttlingやnetwork errorはretry対象、不正画像やValidation不能はFAILED + ack、繰り返し失敗はDLQへ送る。

## Decision Required一覧

1. Claude Haiku 4.5 JP GeoでStructured Outputを優先するか、Nova Liteで東京in-regionを優先するか。
2. pg + SQL migrationを採用するか。
3. FrontendをVite + Reactにするか。
4. NAT 1 / 2台とInterface Endpoint案のどれを選ぶか。
5. Insightsを同期GET + cacheで始めるか。
6. API / Workerの同一Imageを採用するか。
7. Worker scalingをLearning手動1、Production min 1 / 2とするか。
8. S3 raw imageを30日または7日で削除するか。
9. 認証をどのPhaseで導入するか。
10. 返金・金額符号をどう扱うか。

## 理解確認

### Q1. なぜS3へ直接uploadするか

画像本体をAPIへ通すとAPIのmemory、timeout、帯域が画像サイズに影響される。Presigned URLならBrowserはAWS Credentialsを持たず、指定された短時間・指定keyへだけuploadできる。

### Q2. なぜSQSを使うか

Bedrockは遅くなったりthrottleされたりするため、HTTP requestと同じ同期処理にするとtimeoutしやすい。SQSで受付と処理を分けると、retry、visibility、DLQ、Worker scalingを使える。

### Q3. なぜ冪等性が必要か

Standard Queueはat-least-once deliveryなので、正常処理後のack前に同じMessageが再配送されることがある。DBのAtomic claimとUNIQUE制約で、複数回の入力を1回分の結果に収束させる。

### Q4. なぜLLMに金額計算をさせないか

金額の正しさはSQLのSUM / COUNT / GROUP BYで決定的に再現し、LLMには増減の意味づけだけをさせる。そうすれば、文体やモデルが変わってもDashboardの数値は変わらない。

### Q5. NAT Gatewayは必要か

ECSがAWS APIへ接続する経路としてNATまたは各種VPC Endpointが必要である。S3はGateway Endpointが無料だが、SQS、Bedrock Runtime、ECR等はInterface EndpointかNATが必要なので、endpoint数・AZ数・費用・private path要件を比較して決める。

## 次Phaseへの条件

ユーザーがroot設計書のDecision Requiredをレビューし、Phase 1の実装開始を明示的に承認したら、初めてDocker Composeと最小Hono APIを作る。
