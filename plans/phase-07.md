# Phase 7 実装Plan: Bedrock AI-OCR

## 目的

画像bytesをAmazon Bedrock Converse APIへ渡し、クレジットカード利用明細の取引行を構造化して取得する。Bedrockの応答をそのまま後続処理へ渡さず、Zodでアプリケーションの許可値・形式・件数を検証する。

Phase 7の範囲は、次の境界までとする。

```text
画像bytes
  ↓
Bedrock Converse API
  ↓
Tool Useによる構造化候補
  ↓
Zod Validation
  ↓
OcrResult
```

S3 `GetObject`、Workerへの組み込み、`statements`のAtomic claim、transactions保存、`DB COMMIT → DeleteMessage`はPhase 8以降で実装する。Phase 7でDBやSQSへ接続しないことで、AIアダプター単体の入出力と失敗境界を先に確認する。

## 実装前のAWS仕様確認

確認日: 2026-09-06

対象Region: `ap-northeast-1`（Tokyo）

### Bedrock Model

既定値は `jp.amazon.nova-2-lite-v1:0` とする。Nova 2 Liteは画像入力をConverse APIへ渡せる。実AWSスモークで、選択モデルは`strict`フィールドをサポートしないことを確認した。JSON Schema Structured Outputsも使えないため、Phase 7ではTool Useのschema、強制Tool選択、Zod Validationで構造化境界を作る。

- Converse APIのTool Useを1個だけ定義する
- `toolChoice`でそのToolを強制する
- Toolのinput schemaで返却項目を指定する
- Tool Useの入力をZodで再検証する

Claude Haiku 4.5はJSON Schema Structured Outputsを使える候補だが、今回のTokyoでの画像入力要件との組み合わせを既定値にしなかった。モデルIDは環境変数にして、将来のモデル変更やリージョン変更でコードを変更しなくてよいようにする。

### 画像入力

Converse APIのuser messageに、`image.format`と`image.source.bytes`を設定する。S3 URLやFrontendからのAWS CredentialsはBedrockへ渡さない。Phase 7ではS3からの取得をまだ実装しないため、呼び出し側から受け取ったbytesをアダプターに渡す。

### 料金とRetry

Bedrock料金はモデル、入力token、出力token、Regionなどで変わるため、固定額をコードへ埋め込まない。Converse応答のusageを返し、運用時に料金見積もりへ使えるようにする。SDK Clientには`maxAttempts=3`を設定し、Throttlingなどの一時エラーを分類する関数を用意する。SQS MessageをACKするか、FAILEDへするかはPhase 9のWorker処理で決める。

## 小さな実装単位とTDD

### 1. Schemaを先に作る

Red:

- 日付、金額、merchant、category、subcategory、lineNumberの不正値を拒否するテストを書く
- `lineNumber`重複を拒否するテストを書く
- categoryとsubcategoryの不正な組み合わせを拒否するテストを書く

Green / Refactor:

- Zod schemaを実装する
- Tool Useの`"なし"`をドメイン結果の`null`へ変換する
- 許可カテゴリをアプリケーション側で固定する

### 2. Bedrock Adapterを作る

Red:

- Fake Bedrock ClientのTool Use応答から結果を返すテストを書く
- model ID、画像bytes、強制Tool、Tool schemaを確認するテストを書く
- Tool Useがない応答を拒否するテストを書く

Green / Refactor:

- AWS SDK v3の`ConverseCommand`を使う
- 入力をsystem prompt、user prompt、image contentへ分ける
- SDK依存を`BedrockRuntimeClientLike`に隠し、Fake Clientを注入できるようにする

### 3. 画像とエラー境界を固定する

Red:

- 空画像、対応外Content-Type、上限超過画像をBedrock呼び出し前に拒否する
- AbortSignalがSDKへ伝播することを確認する
- Throttling、timeout、network errorと、Validation・権限・モデル不存在を分類する

Green / Refactor:

- `InvalidOcrImageError`、`InvalidOcrResponseError`を定義する
- 生のAI応答や画像内容をエラーログへ含めない
- AWS SDKの標準Retryは3回までとし、アプリケーションの再配送制御とは分離する

### 4. 実接続確認用Fixtureとコマンド

実在の明細画像を保存せず、ローカルで生成した合成PNGを用意する。`npm run bedrock:ocr:smoke`でDefault Credential Provider Chainを使い、AWSへ接続できる環境だけ実Bedrock呼び出しを行う。成功時もログにはモデルID、件数、usageだけを出し、明細行や画像内容を出力しない。

## 完了条件

- `ConverseCommand`で画像bytesを送れる
- Tool Useの入力schemaを受け取り、Zodで検証して検証済み`OcrResult`だけを返す
- 不正画像・不正応答・一時エラー・恒久エラーの境界をテストできる
- 実在データを含まないFixtureで任意の実接続確認ができる
- S3、SQS、DB保存をまだ呼ばない境界を説明できる
- `docs/bedrock.md`、`learning/phase-07.md`、READMEの環境変数・実行手順を更新する

## Decision Required

Phase 7時点の推奨は以下である。実際のAWSアカウントでモデルアクセスが有効でない場合は、モデルアクセスを有効化するか、利用可能なモデルIDを環境変数で指定する。

| 項目 | 推奨 | 主な理由 |
|---|---|---|
| Model | `jp.amazon.nova-2-lite-v1:0` | Tokyoから利用できるJP Geo profileで画像OCRを試しやすく、Tool UseとZodで構造化境界を作れる |
| API | Converse API | モデル交換、画像入力、Tool Useを共通の呼び出し形式にできる |
| Validation | Zod | AI応答をDBへ渡す前の実行時検証ができる |
| 実接続確認 | 合成PNGの任意スモーク | 実データを保存せず、Fakeテストと実AWS確認を分離できる |
