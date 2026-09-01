# API Reference

正本は [../API_DESIGN.md](../API_DESIGN.md)。

| Method | Path | 役割 |
|---|---|---|
| POST | /statements | DB rowとPresigned PUT URLを作成 |
| POST | /statements/{id}/analyze | S3確認後、statementIdをSQSへ送信 |
| GET | /statements/{id} | statusを取得 |
| GET | /transactions?year&month | 完了済み取引を取得 |
| GET | /analytics/monthly?year&month | SQL Analyticsを取得 |
| GET | /analytics/monthly/insights?year&month | cacheまたはBedrock Insightsを取得 |

画像本体はAPIへ送らない。Insightsは数値Analyticsと分離し、Bedrock unavailableでも数値Dashboardを表示する。

