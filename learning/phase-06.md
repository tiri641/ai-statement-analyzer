# Phase 06: ECS Worker

Status: 実装・動作確認完了。

## 1. 今回作ったもの

Phase 6では、APIとは別に起動する常駐Workerプロセスを作った。WorkerはSQSをLong Pollingし、Messageを1件ずつ処理する。

今回の処理関数は、`messageId`、`statementId`、`receiveCount`を安全にログへ記録するだけである。S3からの画像取得、Bedrock OCR、DB更新はまだ行わない。

起動コマンド:

```bash
npm run worker
```

APIは`npm run api`、Workerは`npm run worker`で別々に起動する。この分離により、APIのHTTP処理と時間のかかるジョブ処理を別のプロセスとして扱える。

## 2. なぜ必要か

SQSはMessageを保持・配送するサービスであり、処理を実行するプログラムではない。WorkerがSQSの`ReceiveMessage`を呼び、受け取ったMessageを業務処理する。

Workerを常駐させることで、APIのリクエスト中にOCRが終わるまで待たずに済む。後続PhaseではWorkerだけを増やす、Retryする、DLQを調査する、といった運用が可能になる。

## 3. データフロー

```text
Worker起動
  ↓
SQS ReceiveMessage
  ├─ 最大1件
  └─ WaitTimeSeconds=20
  ↓
Messageなし: 次の受信
Messageあり: 注入された処理関数
  ↓ 成功
SQS DeleteMessage
  ↓
次の受信
```

処理関数が成功した後にだけDeleteMessageする。処理中にWorkerが停止した場合や処理関数が失敗した場合は、Messageを削除しない。Visibility Timeoutが切れるとMessageが再配送される。

## 4. 重要な実装

### QueueのAbortSignal

`AnalyzeJobQueue.receiveOne()`が任意のAbortSignalを受け取れるようにした。SQSアダプターはAWS SDKの`SQSClient.send()`へSignalを渡す。

これにより、WorkerがLong Polling中にShutdown要求を受けたとき、20秒の待機が終わるまで待たずに受信を中断できる。

### Worker Loop

`AnalyzeWorker`はQueue、処理関数、Logger、待機関数をコンストラクタで受け取る。AWS SDKや実時間の待機処理を直接固定しないため、Fakeを使ってテストできる。

- 受信は最大1件
- 処理と削除が終わるまで次を受信しない
- 処理成功後にだけ削除
- Receiveエラー後は1、2、4、8、16、最大30秒で再試行
- Receive成功または空応答でバックオフを初期値へ戻す

### Graceful Shutdown

SIGTERMまたはSIGINTでShutdownを要求する。

1. Shutdown状態にする。
2. 新しいReceiveMessageを開始しない。
3. Receive中ならAbortControllerで中断する。
4. すでに受信したMessageの処理を待つ。
5. 処理成功後にDeleteMessageする。
6. Workerを終了する。

処理関数の実行中にShutdown要求が来ても、処理とDeleteMessageの完了を待つ。ECSのTask Definitionへ`stopTimeout=30秒`を設定する作業はPhase 13で行う。

## 5. 障害時の挙動

| 状況 | Workerの動作 | SQSで起きること |
|---|---|---|
| Queueが空 | Long Pollingを継続 | 空応答を減らす |
| Receiveエラー | ログ、バックオフ、受信継続 | Messageは処理されない |
| 不正Message | ログ、削除せず継続 | Visibility Timeout後に再配送され、最終的にDLQ対象になる |
| 処理関数の失敗 | ログ、削除せず継続 | Visibility Timeout後に再配送される |
| DeleteMessageの失敗 | ログ、Workerは継続 | Messageは削除されず、後で再配送される |
| Receive中にSIGTERM | ReceiveをAbortして終了 | 受信中Messageは処理されていないため、削除されない |
| 処理中にSIGTERM | 処理とDeleteを待って終了 | 成功したMessageだけ削除される |

SQS Standard Queueでは重複配送があり得る。したがって、後続PhaseでS3取得やDB保存を追加するときは、同じMessageが複数回処理されても安全な冪等性が必要になる。

## 6. Security

- ログにMessage本文、画像、カード番号、Receipt Handleを出さない。
- エラー本文ではなく、エラー種別を`errorCode`として記録する。
- AWS CredentialsはWorkerのソースコードへ記述しない。
- Phase 6では既存のローカルAWS認証方式を使用する。
- ECSへデプロイするときのWorker Task Roleは、Phase 13でReceive/Deleteなど必要な権限だけを付与する。

## 7. Cost

Long Pollingにより、Messageがないときの空のReceiveMessage応答とリクエスト数を抑える。SQSはECSのようなWorker常駐時間の課金ではなく、主にAPIリクエスト数とデータ量がコストに影響する。

Phase 6では新しいAWSリソースを作成しない。ECS Fargateで常駐Workerを動かす料金、Workerの台数、SQSリクエスト料金の詳細比較はPhase 13・14で行う。

## 8. テスト

Fake Queue、Fake Handler、Fake Sleep、Fake Loggerを使用し、次を確認した。

- 処理成功後にだけDeleteMessageする
- Messageを1件ずつ処理する
- 空Queueでも受信を継続する
- 処理失敗時にDeleteMessageしない
- Delete失敗時もWorkerが継続する
- Receiveエラー後にバックオフする
- バックオフが30秒を上限にする
- 不正Messageを削除しない
- Receive中のShutdownでAbortする
- 処理中のShutdownで処理と削除を待つ
- SIGTERM / SIGINTがShutdown要求になる
- SQSアダプターへAbortSignalが渡る

## 9. 理解確認

### Q1. なぜSQSとWorkerを分けるのか？

SQSはMessageを保持・配送するサービスで、WorkerはMessageを受け取って処理するアプリケーションだからである。役割を分けることで、APIと非同期処理を独立して運用できる。

### Q2. なぜ1件ずつ処理するのか？

Phase 6では処理の順序とACKの境界を明確にするためである。1件の処理とDeleteが終わるまで次を受信しないため、同時実行数を1として挙動を確認しやすい。並列化は後続のWorker scalingで検討する。

### Q3. 処理関数が失敗したらなぜDeleteMessageしないのか？

DeleteするとSQSからMessageが消え、処理が完了していなくても再試行できなくなるからである。削除しなければVisibility Timeout後に再配送され、RetryやDLQへつなげられる。

### Q4. SIGTERMをReceive中と処理中に受けたらどうなるか？

Receive中ならAbortControllerでLong Pollingを中断して、新しい受信を行わず終了する。処理中なら処理とDeleteMessageの完了を待って終了する。これにより、処理済みなのにACKしない状態を減らす。

### Q5. Heartbeatはなぜ必要で、なぜPhase 6では実装しないのか？

Visibility Timeoutより処理が長くなると、処理中でもMessageが再配送されるためHeartbeatが必要になる。Phase 6の処理関数は短いログ記録だけなので、S3・Bedrock・DBを追加する後続Phaseで`ChangeMessageVisibility`を実装する。
