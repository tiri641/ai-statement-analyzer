import { z } from "zod";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

const targetMonthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "対象年月はYYYY-MM形式で指定してください")
  .refine((value) => {
    const year = Number(value.slice(0, 4));
    return year >= 2000 && year <= 2100;
  }, "対象年は2000年から2100年までです");

export const createStatementRequestSchema = z
  .object({
    targetMonth: targetMonthSchema,
    fileName: z
      .string()
      .min(1, "ファイル名を指定してください")
      .max(255, "ファイル名は255文字以内で指定してください"),
    contentType: z.enum(["image/jpeg", "image/png"]),
    contentLength: z
      .number()
      .int("ファイルサイズは整数で指定してください")
      .positive("ファイルサイズは1以上で指定してください")
      .max(MAX_UPLOAD_BYTES, "ファイルサイズが上限を超えています"),
  })
  .strict();

export const statementIdSchema = z.string().uuid();

export type CreateStatementRequest = z.infer<
  typeof createStatementRequestSchema
>;
