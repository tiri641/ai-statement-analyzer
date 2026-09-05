# Architecture Reference

設計の正本は [../ARCHITECTURE.md](../ARCHITECTURE.md)。このページは実装Phaseで参照するsequence集である。

## AWS Architecture

```mermaid
flowchart LR
  FE[Frontend] --> ALB[HTTPS ALB]
  ALB --> API[ECS API]
  API --> DB[(RDS PostgreSQL)]
  API --> SQS[SQS Standard]
  FE -->|Presigned PUT| S3[(Private S3)]
  SQS --> W[ECS OCR Worker]
  W --> S3
  W --> B[Bedrock]
  W --> DB
  SQS --> DLQ[DLQ]
  API -.-> CW[CloudWatch]
  W -.-> CW
```

### Phase 5 / Phase 6 / Phase 7の実装範囲

Phase 5で実際に動くのは、APIからMain Queueへの送信と、1回だけ動く最小ConsumerによるReceive / Validation / Deleteである。Phase 6では、ローカルで常駐Workerを起動し、SQS Long Polling、1件ずつの処理、成功後ACK、SIGTERMによるGraceful Shutdownを実装した。Phase 7では、Workerとは独立したBedrock Converseアダプター、強制Tool選択、Tool input schema、Zod Validation、合成PNGスモークを追加した。実AWSスモークで選択モデルがstrictフィールドをサポートしないことも確認した。S3 GetObject、WorkerへのBedrock組み込み、DB Transaction、ECS Serviceへのデプロイは後続Phaseで実装する。

```mermaid
sequenceDiagram
  participant F as Frontend
  participant A as API
  participant D as PostgreSQL
  participant Q as SQS Standard Queue
  participant C as 最小Consumer
  F->>A: POST /statements/{id}/analyze
  A->>D: UPDATE UPLOADED -> QUEUED
  A->>Q: SendMessage({statementId})
  A-->>F: 202 QUEUED
  C->>Q: ReceiveMessage(Long Poll)
  C->>C: JSON / UUID Validation
  C->>Q: DeleteMessage(ReceiptHandle)
```

### Phase 6 Worker Sequence

```mermaid
sequenceDiagram
  participant Q as SQS Standard Queue
  participant W as 常駐Worker
  participant H as 注入された処理関数

  W->>Q: ReceiveMessage（最大1件、Long Poll）
  Q-->>W: Messageまたは空応答
  alt Messageあり
    W->>H: handleJob(statementId)
    alt 処理成功
      W->>Q: DeleteMessage(ReceiptHandle)
    else 処理失敗
      W-->>Q: Deleteしない
      Note over Q,W: Visibility Timeout後に再配送
    end
  else 空応答
    W->>Q: 次のReceiveMessage
  end
  Note over W: SIGTERMでReceiveをAbortし、処理中Job完了後に停止。30秒超過時は削除せず終了
```

## Upload Sequence

```mermaid
sequenceDiagram
  participant F as Frontend
  participant A as API
  participant S as S3
  participant D as DB
  F->>A: POST /statements
  A->>D: INSERT UPLOAD_PENDING
  A-->>F: Presigned PUT URL
  F->>S: PUT image
  F->>A: POST /upload/complete
  A->>S: HeadObject
  A->>D: UPLOAD_PENDING -> UPLOADED
  F->>A: POST /analyze (Phase 5)
  A->>D: UPLOADED -> QUEUED
```

## OCR Sequence

```mermaid
sequenceDiagram
  participant Q as SQS
  participant W as Worker
  participant D as DB
  participant S as S3
  participant B as Bedrock
  Q->>W: long poll Receive
  W->>D: atomic claim
  W->>S: GetObject
  W->>B: image Converse + Tool Use
  B-->>W: Tool Use OCR候補
  W->>W: Zod validation
  W->>D: transaction save + COMPLETED
  W->>Q: DeleteMessage after COMMIT
```

### Phase 7 Bedrock Adapter Sequence

```mermaid
sequenceDiagram
  participant C as 呼び出し側
  participant A as BedrockOcrAnalyzer
  participant B as Bedrock Converse
  participant Z as Zod
  C->>A: image bytes + contentType
  A->>A: 形式・空・10 MiBを検証
  A->>B: ConverseCommand（画像 + 強制Tool + input schema）
  B-->>A: Tool Use
  A->>A: Tool名・stopReason・content数を確認
  A->>Z: Tool入力をValidation
  Z-->>A: OcrResult
  A-->>C: 検証済み結果 + usage
```

## Retry Sequence

```mermaid
sequenceDiagram
  participant Q as Queue
  participant W as Worker
  participant D as DLQ
  Q->>W: receive
  W-->>Q: transient error, no delete
  Q->>W: visibility expiry redelivery
  Q->>D: maxReceiveCount exceeded
```

## Analytics Sequence

```mermaid
sequenceDiagram
  participant F as Frontend
  participant A as API
  participant D as PostgreSQL
  participant B as Bedrock
  F->>A: monthly analytics
  A->>D: SUM COUNT GROUP BY
  D-->>A: exact metrics
  A-->>F: Dashboard numbers
  F->>A: insights
  A->>B: metrics only
  B-->>A: validated interpretation
  A-->>F: Insights
```
