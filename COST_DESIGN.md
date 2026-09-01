# COST_DESIGN.md

## 前提

- 料金確認日: 2026-09-01
- Region: ap-northeast-1（Tokyo）
- 通貨: USD。税、無料枠、Savings Plans、予約、CloudFront、Route 53、WAF、バックアップ超過、データ転送超過は除外。
- 1か月 = 730時間。
- Learningの概算: API 1 task、Worker 1 task、各0.25 vCPU / 0.5 GiB、ALB 1台・0.5 LCU、RDS PostgreSQL db.t4g.micro Single-AZ・gp3 20GB、NAT 1台、ECR 2GB、Secrets 2件、CloudWatchログ1GB/月。
- Production-likeの概算: API 2 task、Worker 2 task、同じtaskサイズ、ALB 1台・0.5 LCU、RDS Multi-AZ相当、NAT 2台、同じECR / Secrets。
- 画像100枚/月、1画像5MB、画像は最大30日保持、OCR 100回、Insights生成1回/月を例にする。
- Bedrockの入力tokenは画像内容・解像度・モデルで変わるため、以下のBedrock金額は計画用の例であり、実際のUsageを確認する。

料金は変更される。デプロイ前にAWS Pricing Calculatorと各サービスのRegion別ページで再計算する。

## Production-like構成

| Service | 構成 | 月額の考え方 |
|---|---|---:|
| ECS Fargate | API 2 + Worker 2、各0.25 vCPU / 0.5GiB | 約$45.00 |
| ALB | 1台、730h、0.5 LCU | 約$20.66 |
| RDS PostgreSQL | db.t4g.micro相当、Multi-AZ、gp3 20GB | 約$42.02 |
| NAT Gateway | 2 AZ、各730h | 約$65.70 + data processing |
| S3 | 0.5GB程度 + PUT/GET | $1未満想定 |
| SQS + DLQ | 少量リクエスト | 無料枠内〜$1未満想定 |
| Bedrock | Haiku 4.5の計画例 | 約$2.65 |
| CloudWatch | Logs 1GB + 少数Alarm | 約$1未満〜数ドル |
| ECR | private image 2GB | 約$0.20 |
| Secrets Manager | 2 secrets | 約$0.80 |
| 合計 | 上記の代表値のみ | 約$178〜180/月 + 変動費 |

Production-likeで最初からdb.t4g.micro Multi-AZが十分とは限らない。可用性・接続数・CPUを測定し、必要ならサイズを上げる。Multi-AZはコストだけでなくfailover設計の学習対象になる。

## Learning環境構成

Learningでは可用性を一部下げるが、S3 private、TLS、IAM、Private RDS、暗号化、ログmaskingは維持する。

| Service | 計算例 |
|---|---:|
| Fargate 1 API | CPU $9.23 + memory $2.02 = $11.25 |
| Fargate 1 Worker | $11.25 |
| ALB | hourly $17.74 + 0.5 LCU $2.92 = $20.66 |
| RDS Single-AZ db.t4g.micro | compute $18.25 + gp3 20GB $2.76 = $21.01 |
| NAT 1台 | $0.045/h x 730 = $32.85 + data processing |
| ECR 2GB | $0.20 |
| Secrets 2件 | $0.80 |
| CloudWatch Logs 1GB | $0.76 ingestionを上限目安にする（free tier適用前） |
| Bedrock | 下記の100 OCR例で約$2.65 |
| S3 / SQS / 小量データ転送 | $1未満〜少額想定 |
| 合計 | 約$101〜110/月 + 税・データ変動 |

Learning用でも、ECSを常時起動すると「学習だから無料」にはならない。最安はローカル実行であり、AWS構成を学ぶ時間だけ起動する運用を推奨する。

## 1日だけ起動した概算

24時間、API 1 + Worker 1、ALB、RDS Single-AZ、NAT 1台を動かし、インフラを日割りした例である。

| Service | 24時間の目安 |
|---|---:|
| Fargate 2 task | $0.74 |
| ALB + 0.5 LCU | $0.68 |
| RDS compute + storage日割り | $0.69 |
| NAT Gateway | $1.08 + data processing |
| ECR / Secrets / Logs日割り | 約$0.06 |
| Bedrock | 使用量次第。3画像程度なら数セント〜 |
| 合計 | 約$3.4〜5 + 税・通信・実使用量 |

ALB、NAT、RDSなどは「ECS desiredCount=0」にしても自動で消えない。1日だけ利用しても、残したResourceの時間課金は継続する。学習終了後はECS desiredCount=0、RDS停止に加え、不要ならALB・NATも削除またはStack全体をdestroyする。DB削除時のデータ消失にはDeletion Protection、snapshot、保持方針を使う。

## Bedrock計算例

計画用にClaude Haiku 4.5を input $1.10 / 1M tokens、output $5.50 / 1M tokensとし、1 OCRあたり20,000 input tokens、800 output tokensを仮定する。

```
100 x ((20,000 / 1,000,000 x $1.10)
     + (800 / 1,000,000 x $5.50))
= $2.64
```

Insightsをinput 4,000、output 500 tokensで1回行うと約$0.00715。画像の実際のtoken量、再試行、モデル、Inference Profile、Region、Batch利用可否で変わるため、使用量をCloudWatch / Bedrockの請求明細で確認する。LLMに全transactionsを渡さず、SQLで圧縮した集計だけを渡すことがコストにも効く。

## NAT Gateway vs VPC Endpoint

### NAT案

- Learning: NAT 1台を1 AZに置き、ECS private subnetから外向きAWS APIへ出す。S3だけGateway Endpointにする。
- Production-like: AZごとにNAT 1台、合計2台。1台集中よりAZ障害時の経路を分離できる。
- 代表的な計画単価: $0.045/NAT Gateway-hour、$0.045/GB processed。Tokyoの現行単価はデプロイ時に再確認する。
- 1台730h: 約$32.85。2台: 約$65.70。NAT data processingとPublic IPv4等は別。
- 長所: 構成が単純、AWS以外のInternet endpointにも接続可能、Endpoint数が少ない。
- 短所: 常時のhourly費用、data processing、Internetへの経路、AZ障害時の設計。

### Endpoint案

- S3はGateway VPC Endpoint。hourly / data processingがないため、Private SubnetからS3へはまずこれを使う。
- ECR API、ECR DKR、CloudWatch Logs、Secrets Manager、SQS、Bedrock RuntimeはInterface Endpoint候補。
- 6 service x 2 AZ x $0.01/endpoint-hour x 730h = 約$87.60/月 + interface data processing（最初の1PBは$0.01/GBの計画値）。
- 長所: AWSサービスへのprivate path、Internet/NAT依存低下、endpoint policyで制限可能。
- 短所: 2 AZに置くとendpoint ENI数が増える、hourly費用、data processing、DNS / SG / endpoint policyの運用が増える。

### 採用方針

低トラフィックのLearningはNAT 1台 + S3 Gateway Endpointを推奨する。Production-likeは、単純さと費用を重視する限りNAT 2台を推奨する。組織ポリシーでInternet/NATが禁止、またはprivate pathが要件ならInterface Endpoint案を選ぶ。Interface Endpointが常に安い、NATをなくせば常に安い、とは判断しない。

## ECS / RDSの停止運用

- ECS ServiceのdesiredCountは0にできる。SQSを見て自動起動するわけではないため、Learningでは手動1、終了時0が分かりやすい。
- ECS Service Auto Scalingのmin capacity 0も可能だが、0台からのscale-outはメトリクスの次のdatapoint待ちになる。Interactiveな学習では手動起動が理解しやすい。
- RDSは停止中にDB instance hoursがかからないが、storage、backup、必要なPublic IPv4等は残る。停止DBは7日後に自動再起動する。
- RDS停止はProductionの可用性設計ではなく、Learningの節約手段である。
- ALB、NAT、Interface Endpoint、ECR、Secrets、S3、CloudWatchはECS停止・RDS停止だけではゼロにならない。
- S3 raw imageはLifecycleで30日、または承認後7日に削除する。incomplete uploadは1日程度でabortする。
- CloudWatch Logs retentionは7〜30日から開始し、debugログ量を抑える。重要なAlarmは削除しない。

## サービス別料金の参照先

- [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/): vCPU、memory、storageを秒単位（最低1分）で課金。東京の計画例はAWS公式Japan CDPの0.25 vCPU / 0.5GB例を参照。
- [AWS Application Load Balancer pricing](https://aws.amazon.com/elasticloadbalancing/pricing/): ALB-hourとLCU-hour。
- [Amazon RDS for PostgreSQL pricing](https://aws.amazon.com/rds/postgresql/pricing/): instance、storage、backup、Multi-AZ。
- [Amazon S3 pricing](https://aws.amazon.com/s3/pricing/): storage、request、data transfer、Lifecycle。
- [Amazon SQS pricing](https://aws.amazon.com/sqs/pricing/): request単位。DLQもqueue request / storageとして考える。
- [Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/): model、input/output token、画像、Region、Batch等で変化。
- [Amazon CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/): Logs ingestion/storage、metrics、alarms。Service metricsは別扱い。
- [NAT Gateway / VPC pricing](https://aws.amazon.com/vpc/pricing/): hourly、data processing、IPv4。
- [AWS PrivateLink pricing](https://aws.amazon.com/privatelink/pricing/): Interface Endpointのendpoint-hourとdata processing。Gateway Endpointは別途課金なし。
- [Amazon ECR pricing](https://aws.amazon.com/ecr/pricing/): private image storageとtransfer。
- [AWS Secrets Manager pricing](https://aws.amazon.com/secrets-manager/pricing/): secret-monthとAPI call。
- [AWS Japan Fargate example](https://aws.amazon.com/jp/cdp/streamlit/): TokyoのFargate / ALB料金を使った計算例。
- [RDS DB instance stopping](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_OnDemandDBInstances.html): 停止中の課金、storage / backupの扱い。
- [ECS Service Auto Scaling](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-auto-scaling.html): desiredCount 0を含むscaleの仕様。

## 削減方法と失われるもの

| 削減策 | 節約 | 失われるもの / 注意 |
|---|---|---|
| Worker desiredCount=0 | Fargate費用 | 即時処理、scale-out待ち |
| RDS停止 | DB instance hours | 7日で自動再起動、backup/storage費用は残る |
| NATを1台にする | NAT hourly | AZ障害時の独立性 |
| Interface Endpointを増やさない | endpoint hourly | private pathの細かい制御 |
| ALBを学習後削除 | ALB hourly | URLの継続性、再作成待ち |
| Logs retention短縮 | storage費用 | 長期調査の履歴 |
| S3 image retention短縮 | storage / 漏洩面 | 再OCR・再確認の余裕 |
| Insights cache | Bedrock呼び出し | 最新prompt / modelでの再生成タイミング |

## Decision Required

- 学習中のAWS環境を常時起動するか、セッション単位で起動・停止するか。推奨は後者。
- LearningはNAT 1台、Production-likeはNAT 2台で承認するか。
- private path要件がある場合、6種類のInterface Endpointを2 AZへ置くか。
- S3 raw imageの保持を30日または7日にするか。
- Cost Alarmの月額閾値（例: $50 Learning、$250 Production-like）を決めるか。

## 価格確認メモ

2026-09-01時点の計画値として、TokyoのPrice List APIでRDS db.t4g.micro Single-AZ $0.025/h、Multi-AZ $0.050/h、GP3 Single-AZ $0.138/GB-month、Multi-AZ $0.276/GB-month、ALB $0.0243/h、ALB LCU $0.008/hを確認した。FargateはAWS公式Japan CDP掲載のTokyo例（Linux x86 $0.05056/vCPU-h、$0.00553/GB-h）を使った。BedrockのHaiku 4.5 token単価、NAT、Endpoint単価は公式料金ページ・公式資料を併記し、実装開始時に必ず再確認する。
