import { z } from "zod";

// 雛形（config/app.config.json）に入っているプレースホルダ。
// 未確認事項 U-5 が解消するまでモデル名はこの値のままになる。
export const CONFIG_PLACEHOLDER = "<設定する>";

// 「未設定」と判定した問題の印。zod の issue の params に載せて区別する。
const MISSING_KIND = "missing";

// 必須の文字列。空文字・空白のみ・プレースホルダは「未設定」として扱う。
const requiredString = z.string({ required_error: "必須です" }).superRefine((value, ctx) => {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === CONFIG_PLACEHOLDER) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: trimmed === "" ? "空です" : "プレースホルダのままです",
      params: { kind: MISSING_KIND },
    });
  }
});

const positiveInt = z.number({ required_error: "必須です" }).int().positive();
const nonNegativeInt = z.number({ required_error: "必須です" }).int().min(0);

export const appConfigSchema = z.object({
  region: requiredString,
  ai: z.object({
    generationModel: requiredString,
    judgeModel: requiredString,
    intentModel: requiredString,
    location: requiredString,
    maxOutputTokens: positiveInt,
  }),
  embedding: z.object({
    model: requiredString,
    dimensions: positiveInt,
    version: requiredString,
    fieldPrefix: requiredString,
  }),
  search: z.object({
    topK: positiveInt,
    minSimilarity: z.number({ required_error: "必須です" }).min(0).max(1),
    parallelQueryLimit: positiveInt,
  }),
  limits: z.object({
    maxQuestionChars: positiveInt,
    perUserPerDay: positiveInt,
    globalPerDay: positiveInt,
  }),
  rateLimit: z.object({
    perUserPerMinute: positiveInt,
    perIpPerMinute: positiveInt,
    windowSec: positiveInt,
    maxEntries: positiveInt,
  }),
  operations: z.object({
    cacheTtlSec: positiveInt,
    maxStaleSec: positiveInt,
  }),
  collector: z.object({
    maxPagesPerRun: positiveInt,
    maxPdfPerSource: positiveInt,
    maxRetries: nonNegativeInt,
    timeoutSec: positiveInt,
    defaultIntervalHours: positiveInt,
  }),
  chat: z.object({
    maxRegenerations: nonNegativeInt,
    firstTokenTimeoutSec: positiveInt,
  }),
  offline: z.object({
    maxCachedPrograms: positiveInt,
    networkTimeoutSec: positiveInt,
  }),
});

export type AppConfig = z.infer<typeof appConfigSchema>;

export interface ConfigError {
  // ドット区切りのキー名（例: "ai.generationModel"）
  key: string;
  // missing: 欠落・空・プレースホルダ / invalid: 型や範囲の誤り
  kind: "missing" | "invalid";
  message: string;
}

export type LoadConfigResult =
  | { ok: true; config: AppConfig }
  | { ok: false; missingKeys: string[]; errors: ConfigError[] };

function toConfigError(issue: z.ZodIssue): ConfigError {
  const key = issue.path.join(".") || "(root)";
  const isMissing =
    (issue.code === z.ZodIssueCode.invalid_type && issue.received === "undefined") ||
    (issue.code === z.ZodIssueCode.custom &&
      (issue.params as { kind?: string } | undefined)?.kind === MISSING_KIND);
  return { key, kind: isMissing ? "missing" : "invalid", message: issue.message };
}

// 設定の検証（純粋関数。ファイルは読まない）。
// 失敗時は、問題のあるすべてのキー名を missingKeys / errors に載せて返す。
export function loadConfig(raw: unknown): LoadConfigResult {
  const parsed = appConfigSchema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, config: parsed.data };
  }
  const errors = parsed.error.issues.map(toConfigError);
  const missingKeys = [...new Set(errors.filter((e) => e.kind === "missing").map((e) => e.key))];
  return { ok: false, missingKeys, errors };
}
