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

## Phase 3の実装範囲

Phase 3では、`POST /statements`が画像情報を検証してDBへstatementを作成する。S3 keyはサーバー側で生成するが、S3への通信は行わない。

```text
Frontend --POST /statements--> API
           targetMonth等         ↓
                              PostgreSQL
```

Phase 3のResponseでは`upload`が`null`になる。Phase 4でAPIがPresigned URLを返し、Frontendが次の別通信で画像本体をS3へ送る。

```text
Frontend --PUT Presigned URL--> S3
           body: File
```

S3へのPUT成功後、Frontendは`POST /statements/{id}/analyze`を呼ぶ。Phase 3ではこのEndpointもまだ実装しない。
