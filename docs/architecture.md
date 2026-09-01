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
  F->>A: POST /analyze
  A->>S: HeadObject
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
  W->>B: image Converse
  B-->>W: structured OCR
  W->>W: Zod validation
  W->>D: transaction save + COMPLETED
  W->>Q: DeleteMessage after COMMIT
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

