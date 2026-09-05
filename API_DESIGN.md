# API_DESIGN.md

## 方針

APIはHTTPの受付、入力Validation、認可、DB参照・更新、SQS送信を担当する。画像本体のproxy、同期Bedrock OCR、LLMへの金額計算依頼は行わない。

Phase 3では認証・認可をまだ実装していないため、APIサーバーはloopback hostでのみ起動を許可する。公開環境での起動には、後続Phaseで認証Middlewareとowner_id条件を追加する。

APIの成功レスポンスはFrontend向けの公開DTOに変換し、s3_key、processing token、内部failure詳細を返さない。Presigned URLはPhase 4で、指定したS3 Objectへの短時間のPUTに限って返す。エラーは構造化したcodeを返す。

## 共通

- Base URL: /
- Content-Type: application/json
- 日時: ISO 8601 UTC
- 金額: MVPはJSON numberの日本円整数。将来の多通貨や巨大整数が必要ならstring DTOへ移行する。
- yearは2000〜2100、monthは1〜12に限定する。
- 認証導入後は全statement / transaction / analytics queryにowner_id条件を必須にする。

## POST /statements

### Request

```json
{
  "targetMonth": "2026-08",
  "fileName": "statement-2026-08.jpg",
  "contentType": "image/jpeg",
  "contentLength": 5242880
}
```

許可するContent-TypeはMVPではimage/jpeg、image/png（必要ならPDFをPhase 7で追加）とし、サイズ上限をBackendで事前に検査する。filenameは表示用の任意文字列であり、S3 key生成には使用しない。

### Response 201 Created

```json
{
  "statementId": "019abc00-0000-7000-8000-000000000001",
  "status": "UPLOAD_PENDING",
  "upload": {
    "method": "PUT",
    "url": "https://signed.example.invalid/...",
    "headers": {
      "Content-Type": "image/jpeg"
    },
    "expiresInSeconds": 600
  }
}
```

実際のURLは短期Bearer tokenなのでログへ出さない。署名対象のContent-TypeとFrontendのPUT時Content-Typeを一致させる。

Phase 3ではS3未接続のため、`upload`は`null`を返す。Phase 4でAPIがPresigned URLを返し、FrontendがそのURLへ画像本体をHTTP PUTする。

```text
Phase 3:
Frontend --POST /statements--> API
           画像情報だけ          ↓
                              PostgreSQL

Phase 4:
Frontend --PUT Presigned URL--> S3
           画像本体
```

### Errors

- 400 INVALID_REQUEST: JSON、Content-Type、月、画像形式などの入力不正
- 413 REQUEST_TOO_LARGE: JSON Request Bodyが64KiBを超過
- 413 FILE_TOO_LARGE: 画像サイズ上限超過
- 409 STATEMENT_CONFLICT: DBの一意制約などによる競合
- 404 STATEMENT_NOT_FOUND: 指定したstatementが存在しない
- 503 DEPENDENCY_UNAVAILABLE: DBまたはS3 signing依存障害

## PUT Presigned URL

これはAPI Endpointではなく、FrontendがS3へ直接送る。成功後、FrontendはS3の200を確認して次のEndpointを呼ぶ。PUT失敗時に解析開始を呼ばない。

Phase 3ではこのPUTはまだ実行しない。Phase 4で、APIが`statements.s3_key`を使ってPresigned URLを発行し、FrontendがURLの`body`へ選択した画像の`File`を設定してPUTする。

## POST /statements/{id}/analyze

### 処理

1. UUIDと所有者をValidationする。
2. S3 HeadObjectで画像存在、Content-Length、Content-Typeを再確認する。
3. DBを条件付きでUPLOAD_PENDING -> UPLOADED -> QUEUEDへ更新する。
4. SQS Standard Queueに {"statementId":"..."} だけを送信する。
5. 202 Acceptedを返す。

### Response 202 Accepted

```json
{
  "statementId": "019abc00-0000-7000-8000-000000000001",
  "status": "QUEUED"
}
```

すでにQUEUED、PROCESSING、COMPLETEDの場合、同じ要求を冪等に扱い、現在statusを返す。FAILEDを再解析できるかはfailure typeと再解析操作の仕様に従う。

### DB / SQS送信の境界

DB状態更新とSQS SendMessageは同一Transactionではない。MVPでは以下を必須にする。

- statementIdを固定したidempotentな送信・再実行
- SendMessage失敗時に状態をUPLOADEDへ戻す、または再送対象として記録
- QUEUEDなのに一定時間Messageが見えないstatementを検出するreconciliation

本番で送信漏れを許容しにくい場合は、DB TransactionでOutbox行を保存し、PublisherがSQSへ送る。

## GET /statements/{id}

### Response 200 OK

```json
{
  "statementId": "019abc00-0000-7000-8000-000000000001",
  "targetMonth": "2026-08",
  "status": "COMPLETED",
  "processedAt": "2026-08-21T03:10:00Z",
  "failure": null
}
```

失敗時の例:

```json
{
  "status": "FAILED",
  "failure": {
    "code": "UNSUPPORTED_IMAGE",
    "message": "画像を解析できませんでした。"
  }
}
```

内部のStack trace、S3 key、AI responseは返さない。

## GET /transactions?year=2026&month=8

完了済みstatementに属する取引を対象月の半開区間で取得する。

```json
{
  "year": 2026,
  "month": 8,
  "transactions": [
    {
      "id": 1,
      "transactionDate": "2026-08-20",
      "merchantRaw": "AMAZON.CO.JP",
      "merchantName": "Amazon",
      "amount": 3980,
      "category": "買い物",
      "subcategory": "EC",
      "lineNumber": 1
    }
  ]
}
```

ページングが必要になるまではMVPで上限件数を設け、無制限取得を避ける。

## GET /analytics/monthly?year=2026&month=8

SUM、COUNT、GROUP BYはSQLで行い、割合と前月比はBackendで算出する。浮動小数点の表示は小数1桁へ丸めるが、合計金額自体は整数のままにする。

```json
{
  "year": 2026,
  "month": 8,
  "totalAmount": 126430,
  "transactionCount": 47,
  "previousMonth": {
    "totalAmount": 110000,
    "transactionCount": 42,
    "amountChangePercentage": 14.9,
    "transactionCountChangePercentage": 11.9
  },
  "categories": [
    {
      "category": "食費",
      "amount": 38200,
      "count": 18,
      "percentage": 30.2,
      "previousAmount": 25400,
      "amountChangePercentage": 50.4
    }
  ],
  "merchants": [
    {
      "merchant": "Amazon",
      "amount": 21400,
      "count": 5,
      "percentage": 16.9,
      "previousAmount": 18000,
      "amountChangePercentage": 18.9
    }
  ]
}
```

前月データがない場合、前月関連フィールドはnullまたはpreviousMonth: nullとする。0円除算は行わない。

## GET /analytics/monthly/insights?year=2026&month=8

### 分離する理由

Analyticsの数値は低レイテンシー・低コスト・決定的なSQL結果である。一方InsightsはBedrockのレイテンシー、料金、Throttling、モデル変更の影響を受ける。Endpointを分けると、AI障害でもDashboardの数値を表示でき、cacheも独立して管理できる。

### 推奨動作

1. APIがSQL Analyticsを取得する。
2. 既存のmonthly_insights cacheが、analytics version・model・prompt versionと一致すれば返す。
3. cache missなら、確定済みの数値と前月比だけをBedrockへ渡す。
4. Bedrock応答をZodで検証し、許可されたtype / severityだけをcacheして返す。

```json
{
  "year": 2026,
  "month": 8,
  "insights": [
    {
      "type": "CATEGORY_INCREASE",
      "severity": "warning",
      "title": "食費が前月より増えています",
      "description": "食費が前月から50.4%増加しています。",
      "category": "食費"
    }
  ],
  "generatedAt": "2026-09-01T03:00:00Z",
  "cached": false
}
```

前月なしの場合はCATEGORY_INCREASEを生成せず、NOTABLE_SPENDING等の表現に限定する。Bedrock failure時は、数値APIを壊さず503 INSIGHTS_UNAVAILABLEを返す案を推奨する。将来、待ち時間がUX上問題になったらInsightsだけSQS非同期Jobにする。

## HTTP statusと再試行

| status | 意味 | Frontendの方針 |
|---|---|---|
| 200 | 参照成功 | 表示 |
| 201 | statement作成成功 | PUTを実行 |
| 202 | 非同期処理受付 | status polling |
| 400 | 入力不正 | 入力修正、retryしない |
| 404 | 所有者に見えない / 存在しない | 詳細を漏らさない |
| 409 | 状態上競合 | GETして現在状態を表示 |
| 413 | 画像サイズ超過 | 別画像を選ぶ |
| 429 | rate limit / model throttle | backoff |
| 500 | 未知のサーバーエラー | request idで調査 |
| 503 | 一時依存障害 / Insights unavailable | exponential backoff、数値Dashboardは表示 |

## Decision Required

- 認証・ユーザー単位のowner_idをいつ導入するか。
- Insightsを同期GET + cacheで始めるか、Phase 11から非同期生成にするか。推奨は同期GET + cache。
- DB更新とSQS送信の漏れ対策を、MVPのreconciliationで始めるかOutboxから始めるか。
