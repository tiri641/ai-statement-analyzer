# Phase 5 Plan: SQS

## 目的

画像解析開始のHTTP受付と、時間のかかるAI処理を分離するために、SQS Standard Queueへ解析ジョブを投入する。Phase 5ではSQSとの接続境界を小さく実装し、SQSがMessageを実行する仕組みではなく、ConsumerがMessageを受け取って処理する仕組みであることを確認する。

## Phase 5で作るもの

1. SQS Standard QueueとDLQを定義するCDK `MessagingStack`
2. `POST /statements/{id}/analyze`
3. `UPLOADED -> QUEUED`の条件付きDB更新
4. `{"statementId":"..."}`だけを送るSQS Message契約
5. AWS SDK v3のSQS送信・受信・削除アダプター
6. Receive / Message Validation / Deleteだけを行う最小Consumer境界
7. Fake Queueを使った単体テストと、AWS CLIを使った実環境確認

## 今回は作らないもの

- ECS Worker Service
- SQSから受け取った後のS3取得
- Bedrock OCR、ZodによるOCR結果検証
- `PROCESSING`のAtomic claim、lease、heartbeat
- transactions保存、`COMPLETED` / `FAILED`への更新
- SIGTERM、Graceful Shutdown、Workerの自動スケーリング
- Outbox、reconciliation job

これらはPhase 6以降で実装する。Phase 5の最小Consumerは、SQSから受け取ったMessageの形式を検証し、確認用にDeleteMessageするだけである。

## 処理フロー

```text
Frontend
  ↓ POST /statements/{id}/analyze
API
  ↓ DB: UPLOADED -> QUEUED（条件付きUPDATE）
  ↓ SQS SendMessage: { statementId }
  ↓ HTTP 202
SQS Standard Queue
  ↓ ReceiveMessage（Long Polling設定）
最小Consumer
  ↓ Message Validation
  ↓ DeleteMessage
```

SQSはWorkerそのものではない。SQSはMessageを保持して配送するサービスで、Workerは後続Phaseで実装するConsumerプログラムである。

## 設計判断

### Queue方式

Standard Queueを採用する。FIFOは順序と重複排除を追加で提供するが、今回の解析ジョブでは順序を要求せず、at-least-once deliveryを前提に冪等性を学ぶことを優先する。FIFOを選んでもConsumerやDBの冪等性は不要にならない。

### Local接続

単体テストはFake Queueを使う。LocalStackは導入しない。実際のAWS接続は、認証済み環境でMessagingStackをデプロイし、APIから送ったMessageをAWS CLIで確認する。

### DBとSQSの境界

Phase 5は直接送信方式にする。

1. `UPLOADED`だけを`QUEUED`へAtomicに更新する。
2. SQS `SendMessage`を実行する。
3. 送信エラーを検知できた場合は、`QUEUED`から`UPLOADED`へ戻して503を返す。
4. DB更新直後からSQS送信前のプロセス停止、または送信結果が不明な通信断は残る。

この境界はACID Transactionではない。Phase 5ではOutboxを追加せず、送信漏れを厳密に防ぐ設計は後続Phaseで再検討する。送信後にAPIが202を返せなかった場合の重複Messageも、後続Workerの冪等性で安全に処理する。

### Queue設定

| 項目 | Main Queue | DLQ | 理由 |
|---|---:|---:|---|
| 種類 | Standard | Standard | 順序不要、重複配送を前提にする |
| Message保持 | 4日 | 14日 | DLQで調査する期間を長くする |
| Visibility Timeout | 300秒 | 既定値 | 将来のOCR処理時間の初期値。Phase 6で見直す |
| Long Poll | 20秒 | - | 空Receiveのリクエスト数を抑える |
| 暗号化 | SSE-SQS | SSE-SQS | 保存時暗号化 |
| SSL強制 | 有効 | 有効 | HTTPS経由に限定 |
| maxReceiveCount | 3 | - | 一時失敗を3回まで再配送してから隔離 |

CDK Stack削除時の学習環境コストを抑えるため、QueueとDLQは`RemovalPolicy.DESTROY`とする。実運用では保持・削除方針を別途承認する。

## TDDの進め方

1. Red: Message schema、Queueアダプター、解析開始API、CDK設定、DB状態遷移の失敗テストを先に追加する。
2. Green: 必要最小限のSQS送受信、API、CDK、Repositoryを実装する。
3. Refactor: AWS SDKの詳細をアダプターに閉じ込め、APIがSQSコマンドを直接扱わない形に整理する。
4. `npm test`、型チェック、CDKテスト、`cdk synth`を実行する。
5. 実AWSでProducer送信、CLI受信・削除、未削除Messageの再配送、DLQ移動を確認する。

## 理解確認の合格条件

- SQSとWorkerの責務を区別して説明できる。
- Message bodyに画像を入れず、`statementId`だけを入れる理由を説明できる。
- DeleteMessageをしなかった場合のVisibility Timeout、再配送、DLQの流れを説明できる。
- `UPLOADED -> QUEUED`を条件付きUPDATEにする理由を説明できる。
- DB更新とSQS送信の間に残る障害窓と、Outboxが解決する問題を説明できる。
