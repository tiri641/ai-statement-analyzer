# Analytics

SQLを数値の正とする。

- Phase 10は`GET /analytics/monthly?year=YYYY&month=M`を提供する。
- Request Body、画像、取引配列、合計金額は受け取らず、年月だけをQuery Parameterで受け取る。
- 取引データは、Phase 8・9のWorkerがOCR後に`transactions`へ保存したものを使用する。
- 対象月は月初以上、翌月月初未満の半開区間。
- `statements.status = 'COMPLETED'`のstatementに属するtransactionsだけを対象にする。
- totalAmount = SUM(amount)
- transactionCount = COUNT(*)
- category / merchantはSUMとCOUNTのGROUP BY。
- percentageは純額のtotalAmountを分母にし、Backendで計算・小数1桁へ丸める。純額が0円の場合はnullにする。
- 前月の取引がない場合はpreviousMonthをnullにする。
- 前月の金額が0円の場合、前月の総額・件数は返し、前月比だけnullにする。
- 前月比は`(current - previous) / abs(previous) * 100`で計算し、前月が0円の場合はnullにする。
- 返金は負数としてSUMに含める。

同じAnalytics DTOをDashboardとInsights promptで共有し、LLMへ全明細を送らず、確定済みの集計値のみ渡す。
