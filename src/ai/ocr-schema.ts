import { z } from "zod";

export const MAX_OCR_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_OCR_TRANSACTIONS = 100;

export const OCR_CATEGORIES = [
  "食費",
  "交通",
  "買い物",
  "娯楽",
  "サブスク",
  "旅行",
  "その他",
] as const;

export const OCR_SUBCATEGORIES = [
  "外食",
  "コンビニ",
  "スーパー",
  "カフェ",
  "電車",
  "タクシー",
  "飛行機",
  "日用品",
  "衣服",
  "EC",
  "なし",
] as const;

const subcategoriesByCategory: Record<
  (typeof OCR_CATEGORIES)[number],
  readonly string[]
> = {
  食費: ["外食", "コンビニ", "スーパー", "カフェ"],
  交通: ["電車", "タクシー", "飛行機"],
  買い物: ["日用品", "衣服", "EC"],
  娯楽: [],
  サブスク: [],
  旅行: [],
  その他: [],
};

const transactionBaseSchema = {
  transactionDate: z
    .string()
    .regex(
      /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
      "取引日はYYYY-MM-DD形式である必要があります",
    )
    .refine(isValidCalendarDate, "取引日が不正です"),
  merchantRaw: z
    .string()
    .trim()
    .min(1, "merchantRawは必須です")
    .max(200, "merchantRawが長すぎます"),
  merchantName: z
    .string()
    .trim()
    .min(1, "merchantNameは必須です")
    .max(200, "merchantNameが長すぎます"),
  amount: z
    .number()
    .int("金額は整数である必要があります")
    .refine(Number.isSafeInteger, "金額は安全な整数である必要があります")
    .refine((value) => value !== 0, "金額は0以外の整数である必要があります")
    .refine(
      (value) => Math.abs(value) <= 100_000_000,
      "金額が上限を超えています",
    ),
  category: z.enum(OCR_CATEGORIES),
  subcategory: z.enum(OCR_SUBCATEGORIES),
  lineNumber: z
    .number()
    .int("lineNumberは整数である必要があります")
    .positive("lineNumberは1以上である必要があります")
    .max(MAX_OCR_TRANSACTIONS, "lineNumberが上限を超えています"),
};

const ocrToolTransactionSchema = z
  .object(transactionBaseSchema)
  .strict()
  .superRefine(validateCategoryAndSubcategory);

export const ocrToolInputSchema = z
  .object({
    transactions: z
      .array(ocrToolTransactionSchema)
      .min(1, "取引が1件以上必要です")
      .max(MAX_OCR_TRANSACTIONS, "取引件数が上限を超えています"),
  })
  .strict()
  .superRefine(validateLineNumbers);

const ocrTransactionSchema = z
  .object({
    transactionDate: transactionBaseSchema.transactionDate,
    merchantRaw: transactionBaseSchema.merchantRaw,
    merchantName: transactionBaseSchema.merchantName,
    amount: transactionBaseSchema.amount,
    category: transactionBaseSchema.category,
    subcategory: z.string().nullable(),
    lineNumber: transactionBaseSchema.lineNumber,
  })
  .strict()
  .superRefine((transaction, context) => {
    const subcategory = transaction.subcategory;
    const allowed = subcategoriesByCategory[transaction.category];

    if (subcategory !== null && !allowed.includes(subcategory)) {
      context.addIssue({
        code: "custom",
        path: ["subcategory"],
        message: "カテゴリとsubcategoryの組み合わせが不正です",
      });
    }
  });

export const ocrResultSchema = z
  .object({
    transactions: z
      .array(ocrTransactionSchema)
      .min(1, "取引が1件以上必要です")
      .max(MAX_OCR_TRANSACTIONS, "取引件数が上限を超えています"),
  })
  .strict()
  .superRefine(validateLineNumbers);

export type OcrToolInput = z.infer<typeof ocrToolInputSchema>;
export type OcrResult = z.infer<typeof ocrResultSchema>;
export type OcrTransaction = OcrResult["transactions"][number];

export function parseOcrToolInput(input: unknown): OcrResult {
  const parsed = ocrToolInputSchema.safeParse(input);

  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(issue?.message ?? "OCR結果の形式が不正です");
  }

  const result = {
    transactions: parsed.data.transactions.map((transaction) => ({
      ...transaction,
      subcategory:
        transaction.subcategory === "なし" ? null : transaction.subcategory,
    })),
  };
  const validatedResult = ocrResultSchema.safeParse(result);

  if (!validatedResult.success) {
    const issue = validatedResult.error.issues[0];
    throw new Error(issue?.message ?? "OCR結果の形式が不正です");
  }

  return validatedResult.data;
}

function validateCategoryAndSubcategory(
  transaction: OcrToolInput["transactions"][number],
  context: z.RefinementCtx,
): void {
  const allowed = subcategoriesByCategory[transaction.category];

  if (!allowed.includes(transaction.subcategory) && transaction.subcategory !== "なし") {
    context.addIssue({
      code: "custom",
      path: ["subcategory"],
      message: "カテゴリとsubcategoryの組み合わせが不正です",
    });
  }

  if (allowed.length > 0 && transaction.subcategory === "なし") {
    context.addIssue({
      code: "custom",
      path: ["subcategory"],
      message: "カテゴリとsubcategoryの組み合わせが不正です",
    });
  }
}

function validateLineNumbers(
  value: { transactions: Array<{ lineNumber: number }> },
  context: z.RefinementCtx,
): void {
  const lineNumbers = new Set<number>();

  for (const [index, transaction] of value.transactions.entries()) {
    if (lineNumbers.has(transaction.lineNumber)) {
      context.addIssue({
        code: "custom",
        path: ["transactions", index, "lineNumber"],
        message: "lineNumberが重複しています",
      });
    }
    lineNumbers.add(transaction.lineNumber);
  }
}

function isValidCalendarDate(value: string): boolean {
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}
