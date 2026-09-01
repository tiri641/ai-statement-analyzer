# Bedrock

BedrockはAI-OCRとAI Insightsの2つのUseCaseに分ける。Model IDは環境変数にし、Converse adapterの下で交換可能にする。

2026-09-01時点の設計候補:

| Model | Image | Structured Output | Region / data path |
|---|---|---|---|
| Claude Haiku 4.5 | 対応 | bedrock-runtimeで対応 | JP inference profileはTokyo / Osaka |
| Amazon Nova Lite | 対応 | 現行Model Cardでは非対応 | Tokyo in-regionで利用候補 |

推奨はClaude Haiku 4.5のJP inference profile + Structured Output + Zod。東京だけに限定したい場合やコストを優先する場合はNova Liteが候補だが、JSON schemaをBedrockに強制できない。

WorkerはS3から画像bytesを取得し、Bedrock Runtime Converseのimage content blockとして送る。S3 URLをモデルに渡したり、FrontendからBedrockを呼んだりしない。OCR promptは、日付、raw merchant、normalized merchant、amount、lineNumber、category、subcategoryだけを返すstrict schemaにする。応答はJSON parse、Zod、カテゴリ許可リスト、日付・金額のpolicyを通す。

Structured Outputの初回schema compilationには追加時間が発生し得るため、APIの同期リクエストではなくWorkerで呼ぶ。schemaはモデルが対応するJSON Schema subsetに合わせ、Zodはアプリケーション境界の二重目の検証とする。入力画像のtoken量と出力token量を実際のレスポンスusageで記録し、料金はモデル・Region・入力画像サイズで再計算する。

参照: [model API compatibility](https://docs.aws.amazon.com/bedrock/latest/userguide/models-api-compatibility.html)、[Structured Outputs](https://docs.aws.amazon.com/en_en/bedrock/latest/userguide/structured-output.html)、[Claude Haiku 4.5](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-haiku-4-5.html)、[Nova Lite](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-amazon-nova-lite.html)。
料金: [Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/)、[Claude Haiku 4.5 pricing example](https://aws.amazon.com/blogs/machine-learning/live-meeting-assistant-with-amazon-transcribe-amazon-bedrock-and-strands-agents/)。
