# Phase 6 Plan: ECS Worker

## 目的

SQSを常時監視し、受信した解析ジョブを1件ずつ処理するWorkerプロセスを実装する。APIとは別プロセスとして動かし、HTTP受付と後続処理を分離する。

## Phase 6で作るもの

1. SQS Long Pollingを行う常駐Worker Loop
2. `statementId`を受け取る処理関数の注入境界
3. 処理成功後だけ`DeleteMessage`するACK制御
4. Receiveエラー時の指数バックオフ（1、2、4、8、16、最大30秒）
5. SIGTERM / SIGINTで新規受信を止めるGraceful Shutdown
6. Long PollingをAbortControllerで中断する処理
7. Worker専用の起動エントリポイント
8. Fake Queue / Handlerを使ったTDDテスト

## 今回は作らないもの

- ECS Service、Task Definition、`stopTimeout`のCDK設定
- S3からの画像取得
- Bedrock OCR
- PostgreSQLのAtomic claim、transactions保存、状態更新
- Visibility TimeoutのHeartbeat
- Retry可能エラーと恒久エラーの業務分類

これらは後続Phaseで実装する。Phase 6の処理関数は、受信したMessageの安全な記録だけを行う。

## 処理フロー

```text
Worker起動
  ↓
SQS ReceiveMessage（最大1件、WaitTimeSeconds=20）
  ↓
Message取得なし: 受信を継続
Message取得あり: 注入された処理関数を実行
  ↓ 成功
DeleteMessage
  ↓
次のMessageを受信
```

処理関数またはDeleteMessageが失敗した場合はMessageを削除しない。Visibility Timeout後の再配送に任せる。Standard Queueは重複配送があり得るため、実際のOCR保存処理では後続Phaseの冪等性が必要になる。

## Graceful Shutdown

SIGTERM / SIGINTを受信したら、Shutdown状態に変更して新しいReceiveMessageを開始しない。Long Polling中ならAbortControllerで中断する。すでにMessageを受信して処理中なら、処理とDeleteMessageの完了を待って終了する。

ECS Fargateの`stopTimeout`は2〜120秒の範囲で設定できる。Phase 6では30秒を目標とし、ECSへの明示的な設定はPhase 13で行う。

## TDD

RedでWorker Loop、ACK、エラー継続、バックオフ、Shutdownのテストを追加し、Greenで最小実装を行う。RefactorでQueue、処理関数、Logger、待機処理を注入可能な形に整理する。

## 完了条件

- APIとWorkerを別コマンドで起動できる。
- WorkerがLong PollingでSQSを監視できる。
- Messageを同時に複数処理しない。
- 処理成功後だけMessageを削除する。
- 処理失敗、不正Message、Delete失敗時にMessageを削除しない。
- Receiveエラー後もWorkerが継続する。
- SIGTERM時にReceiveを中断し、処理中Messageの完了を待つ。
- テスト、型チェック、ビルドが成功する。

## 公式仕様への参照

- [Amazon SQS Long Polling](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/best-practices-setting-up-long-polling.html)
- [Amazon SQS Visibility Timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)
- [Amazon ECS Task Lifecycle](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-lifecycle-explanation.html)
- [ECS ContainerDefinition stopTimeout](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerDefinition.html)
