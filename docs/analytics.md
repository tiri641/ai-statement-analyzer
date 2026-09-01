# Analytics

SQLを数値の正とする。

- 対象月は月初以上、翌月月初未満の半開区間。
- COMPLETED statementのtransactionsだけを対象にする。
- totalAmount = SUM(amount)
- transactionCount = COUNT(*)
- category / merchantはSUMとCOUNTのGROUP BY。
- percentage、平均単価、前月比はBackendで計算・丸める。
- 前月なしはchangeをnullとし、「使いすぎ」を断定しない。

同じAnalytics DTOをDashboardとInsights promptで共有し、LLMへ全明細を送らず、確定済みの集計値のみ渡す。

