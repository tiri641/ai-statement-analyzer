# API Reference

正本は [../API_DESIGN.md](../API_DESIGN.md)。

| Method | Path | 役割 | 実装状況 |
|---|---|---|---|
| POST | /statements | DB rowとPresigned PUT URLを作成 | Phase 4 |
| POST | /statements/{id}/upload/complete | S3のObjectとMetadataを確認してUPLOADEDへ更新 | Phase 4 |
| POST | /statements/{id}/analyze | S3確認後、statementIdをSQSへ送信 | Phase 5以降 |
| GET | /statements/{id} | statusを取得 | Phase 3 |
| GET | /transactions?year&month | 完了済み取引を取得 | Phase 10以降 |
| GET | /analytics/monthly?year&month | SQL Analyticsを取得 | Phase 10以降 |
| GET | /analytics/monthly/insights?year&month | cacheまたはBedrock Insightsを取得 | Phase 11以降 |

画像本体はAPIへ送らない。Insightsは数値Analyticsと分離し、Bedrock unavailableでも数値Dashboardを表示する。

## Phase 4の実装範囲

Phase 4では、`POST /statements`が画像情報を検証し、サーバー側で生成したS3 keyに対するPresigned PUT URLを返す。DBには`UPLOAD_PENDING`でstatementを保存する。

```text
Frontend --POST /statements--> API --Presigned URL--> Frontend
           targetMonth等         ↓                       │
                              PostgreSQL                 │ PUT image
                                                         ▼
                                                        S3
```

FrontendはPUT成功後、`POST /statements/{id}/upload/complete`を呼ぶ。APIはHeadObjectでObjectの存在、Content-Type、Content-Lengthを確認し、値が一致した場合だけ`UPLOAD_PENDING`から`UPLOADED`へ更新する。

```text
Frontend --POST upload/complete--> API --HeadObject--> S3
                                      ↓
                              PostgreSQL: UPLOADED
```

`POST /statements/{id}/analyze`とSQSへの解析ジョブ投入はPhase 5で実装する。Phase 4の完了確認ではSQSを呼ばない。
