# Phase 7: Bedrock AI-OCR

## Status

実装・単体テスト・実AWSスモーク確認完了。合成PNGを`jp.amazon.nova-2-lite-v1:0`へ送り、2件のTool Use OCR結果をZodで検証できた。実測usageはinput 1,646、output 144、total 1,790 tokenだった。このusageは画像内容やPromptで変わるため、固定値として扱わない。

## 1. 今回作ったもの

- Bedrock Runtime SDK v3の`ConverseCommand`を呼び出すOCRアダプター
- 画像bytesをimage content blockへ変換する処理
- Tool Useを1個に限定し、指定Toolを強制する設定
- Tool入力を検証するZod Schema
- category / subcategory、日付、金額、merchant、行番号の検証
- 空画像、対応外形式、サイズ超過の事前検証
- Bedrock応答の形式不正と一時的エラーの分類
- 実在データを含まない合成PNGと、実AWS接続用スモークコマンド

このPhaseではS3からの画像取得、Workerとの接続、DB保存、SQS削除はまだ作っていない。Phase 8以降で接続する。

## 2. なぜ必要か

Bedrockは画像を読んで候補の取引情報を返せるが、AIの応答をDBへそのまま保存してはいけない。誤った日付、未定義カテゴリ、重複行、異常な金額が混ざる可能性があるためである。

そこで、Bedrockは「画像の読み取り・正規化・分類」を担当し、通常プログラムは「形式・許可値・範囲・重複」の検証を担当する。これにより、AIが返した値をDBやFrontendへ渡す境界を明確にできる。

## 3. 処理フロー

```text
呼び出し側の画像bytes
  ↓
画像形式・空・10 MiB上限を確認
  ↓
ConverseCommand
  ├─ system prompt
  ├─ user prompt
  ├─ image.format
  ├─ image.source.bytes
  └─ Tool Use設定（強制Tool、input schema）
  ↓
BedrockのTool Use応答
  ↓
Tool名・stopReason・content blockの実行時形式・件数を確認
  ↓
Zod Validation
  ↓
OcrResult（subcategoryの「なし」はnull）
```

実アプリケーションでの後続フローは次のPhaseで追加する。

```text
SQS Message
  ↓
WorkerがS3 GetObject
  ↓
BedrockOcrAnalyzer
  ↓
Zod Validation
  ↓
DB Transaction
  ↓
COMMIT後にDeleteMessage
```

## 4. 重要コード

### `src/ai/bedrock-ocr.ts`

`BedrockOcrAnalyzer`はAWS SDKへの依存を内部に閉じ込める。`BedrockRuntimeClientLike`を注入できるため、単体テストでは実AWSを呼ばずFake ClientでTool Use応答を再現できる。

`toolChoice`で`extract_credit_card_transactions`を強制し、input schemaで構造化されたTool入力を要求する。実AWSスモークで選択したNova 2 Liteが`strict`フィールドをサポートしないことが分かったため、strictは送信しない。最終的な信頼境界はZodである。

### `src/ai/ocr-schema.ts`

Tool入力ではsubcategoryの値として`「なし」`を許可する。アプリケーション内部へ変換するときに`null`へ置き換える。カテゴリに対応しないsubcategoryや、食費なのに`「なし」`といった組み合わせは拒否する。

金額は日本円の整数として扱い、0、非整数、安全でない整数、上限超過を拒否する。返金は負数にする方針だが、画像から符号を判断できない場合に勝手に推測しない指示をPromptへ入れている。

### `src/ai/synthetic-statement-fixture.ts`

実在のクレジットカード明細をリポジトリに置かず、テスト実行時に文字と罫線を含むPNGを生成する。実AWS接続を試すときも学習用の合成データだけを送る。

## 5. 障害時の挙動

| 事象 | Phase 7での挙動 | 後続Phaseの判断 |
|---|---|---|
| 対応外形式・空・サイズ超過 | Bedrockを呼ばず`InvalidOcrImageError` | 恒久エラーとしてFAILED候補 |
| Tool Useがない | `InvalidOcrResponseError` | 再試行またはFAILEDの方針をPhase 9で決定 |
| Zod Validation失敗 | `InvalidOcrResponseError` | 不正入力なら再試行せずFAILED候補 |
| Throttling / 一時AWS障害 | `RETRYABLE`に分類 | SQS再配送とDLQの方針をPhase 9で接続 |
| 権限・モデル不存在 | `NON_RETRYABLE`に分類 | 設定・IAMを修正し、無限Retryしない |
| AbortSignal | SDKへ伝播 | Worker停止時はACKせず再配送に任せる |

AWS SDK Clientの`maxAttempts=3`はSDK内部のHTTPリトライである。Visibility Timeout後のSQS再配送とは別であり、両方の回数・時間を考えてPhase 9で設定する。

## 6. Security

- FrontendやFixtureにAWS Credentialsを持たせない
- Bedrockへカード番号、セキュリティコード、口座番号を出力させないPromptを入れる
- エラーメッセージへ生のAI応答や画像内容を含めない
- スモークコマンドもmerchant・金額・画像をログへ出さず、件数とusageだけ出す
- IAMは実接続時にTask Roleへ`bedrock:InvokeModel`だけを対象モデルに限定して付与する
- 本番ではS3の画像保持期間を短くし、分析に不要な情報をDBへ保存しない

## 7. Cost

Bedrockの料金はModel、Region、入力・出力token数などで変わる。実装ではConverse応答の`usage`を返し、入力token・出力token・合計tokenを記録可能にした。固定料金をコードへ埋め込まず、利用モデルを変更したときは公式料金表で再計算する。

入力画像のサイズ、明細行数、出力上限を抑えることがコストとレイテンシの両方に影響する。ただし画像を過度に縮小してOCR精度を落とさないよう、品質とのバランスが必要である。

## 8. 理解確認

### 1. なぜBedrockの応答をそのままDBへ保存してはいけないか？

AIは形式、日付、カテゴリ、金額を誤る可能性があるためである。Tool Useのschemaは形式を揃える補助であり、アプリケーション側のZod Validationで許可値・範囲・重複を確認してからDBへ渡す。モデルがstrictをサポートする場合でも、Zodを省略しない。

### 2. なぜ金額の合計をBedrockにさせないのか？

支出合計は1円の違いでも業務データとして問題になる。PostgreSQLの`SUM`や`COUNT`で正確に計算し、Bedrockには確定済みAnalyticsの解釈だけをさせる。

### 3. Structured Outputが使えないモデルで、なぜTool Useを使うのか？

画像入力を優先してNova 2 Liteを既定モデルにしたため、JSON Schema Structured Outputsとstrictフィールドの代わりにToolの入力schemaを構造化境界として使う。ただしTool UseもAIの出力なので、最後はZodで検証する。

### 4. SDKのRetryとSQSのRetryは何が違うか？

SDKのRetryは、1回のBedrock API呼び出しでHTTPリクエストを再試行する機能である。SQSのRetryは、WorkerがMessageを削除しなかった場合にVisibility Timeout後へ再配送される仕組みである。異なる層なので、合計実行時間と重複処理を別々に設計する。

### 5. なぜPhase 7でS3やDBまで一気に接続しないのか？

画像入力、Bedrock応答、Validationの責務を単独でテストし、どこで失敗したかを分かりやすくするためである。S3取得、Worker、DB Transaction、冪等性、SQS ACKを同時に入れると、AIの不正応答とメッセージ処理の障害境界が混ざる。
