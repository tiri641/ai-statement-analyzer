# API Reference

正本は [../API_DESIGN.md](../API_DESIGN.md)。

| Method | Path | 役割 | 実装状況 |
|---|---|---|---|
| POST | /statements | DB rowとPresigned PUT URLを作成 | Phase 4 |
| POST | /statements/{id}/upload/complete | S3のObjectとMetadataを確認してUPLOADEDへ更新 | Phase 4 |
| POST | /statements/{id}/analyze | `UPLOADED`を`QUEUED`へ更新し、statementIdをSQSへ送信 | Phase 5 |
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

## Phase 5: POST /statements/{id}/analyze

Frontendは画像PUTと`upload/complete`が成功した後、このEndpointを呼ぶ。APIは画像本体を受け取らず、`statementId`だけをSQSへ送信する。

```text
Frontend --POST /analyze--> API
                              ↓ find statement
                         UPLOADEDだけを
                         QUEUEDへAtomic update
                              ↓ SendMessage
                         SQS Standard Queue
                              ↓
                         HTTP 202
```

Message bodyは次のstrict schemaである。

```json
{"statementId":"019abc00-0000-7000-8000-000000000001"}
```

### Response

```json
{
  "statementId": "019abc00-0000-7000-8000-000000000001",
  "status": "QUEUED"
}
```

### 状態ごとの扱い

| 現在のstatus | APIの扱い |
|---|---|
| `UPLOAD_PENDING` | 409 `STATEMENT_NOT_READY` |
| `UPLOADED` | 条件付きで`QUEUED`へ更新し、SQS送信後202 |
| `QUEUED` / `PROCESSING` / `COMPLETED` | 再送せず現在statusを200 |
| `FAILED` | 409 `STATEMENT_NOT_ANALYZABLE` |

SQS送信が明確に失敗した場合、APIは`QUEUED`から`UPLOADED`へ戻す処理を試み、503 `DEPENDENCY_UNAVAILABLE`を返す。DB更新とSQS送信は同一ACID Transactionではないため、DB更新後のプロセス停止による送信漏れや、送信結果不明時の重複可能性は残る。Phase 5ではOutboxを実装せず、後続Phaseで再検討する。
