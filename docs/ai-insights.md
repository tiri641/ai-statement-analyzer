# AI Insights

InsightsはAnalyticsの解釈であり、計算ではない。

入力:

- totalAmount、transactionCount
- category / merchantのamount、count、percentage
- 前月amount、count、change percentage
- previous monthの有無

入力しないもの:

- DB credentials
- raw image
- card number等
- SQLを実行する権限

Structured OutputのschemaとZodでtype、severity、title、description、category等を検証する。前月がない場合はNOTABLE_SPENDING等に限定し、CATEGORY_INCREASEや「使いすぎ」を作らせない。検証済みresponseはmodel / prompt / analytics version付きでcacheする。

