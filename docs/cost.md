# Cost Reference

正本は [../COST_DESIGN.md](../COST_DESIGN.md)。料金確認日は2026-09-01、RegionはTokyo、税・無料枠・変動データ費用を除く。

- Learning常時起動: 約$101〜110/月。API 1、Worker 1、ALB、RDS Single-AZ、NAT 1を含む。Phase 4のS3-only構成はこの概算より小さい。
- Production-like: 約$178〜180/月。API 2、Worker 2、RDS Multi-AZ、NAT 2を含む。
- Learningの1日利用: 約$3.4〜5 + Bedrock / data usage。
- Interface Endpointを6 service x 2 AZで常時配置する計画値は約$87.60/月 + data processing。
- S3画像はPhase 4からLifecycleで7日後に削除する。保存量を抑えられる一方、再OCRや長期調査の余裕は減る。

ECS desiredCount=0でもALB、NAT、Endpointは残る。RDS停止でもstorage / backupは残り、7日後に自動再起動する。最も効果が大きいのは、学習終了時にECSを0、RDSを停止し、不要なALB・NAT・Endpointを削除すること。ただし削除・snapshot・再作成時間・可用性を失う。
