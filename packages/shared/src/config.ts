import { z } from "zod";

// 雛形（config/app.config.json）に入っているプレースホルダ。
// 未確認事項 U-5 が解消するまでモデル名はこの値のままになる。
export const CONFIG_PLACEHOLDER = "<設定する>";

// 「未設定」と判定した問題の印。zod の issue の params に載せて区別する。
const MISSING_KIND = "missing";

// 値が無いときは「必須です」、それ以外は zod の既定のメッセージにする
const requiredMessage = (issue: { input: unknown }): string | undefined =>
  issue.input === undefined ? "必須です" : undefined;

// 必須の文字列。空文字・空白のみ・プレースホルダは「未設定」として扱う。
const requiredString = z.string({ error: requiredMessage }).superRefine((value, ctx) => {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed === CONFIG_PLACEHOLDER) {
    ctx.addIssue({
      code: "custom",
      message: trimmed === "" ? "空です" : "プレースホルダのままです",
      params: { kind: MISSING_KIND },
    });
  }
});

const positiveInt = z.number({ error: requiredMessage }).int().positive();
const nonNegativeInt = z.number({ error: requiredMessage }).int().min(0);

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
    minSimilarity: z.number({ error: requiredMessage }).min(0).max(1),
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

// 入力の中の、パスが指す値を取り出す（キーの欠落の判定に使う）
function valueAt(raw: unknown, path: readonly PropertyKey[]): unknown {
  let current: unknown = raw;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = Reflect.get(current, segment);
  }
  return current;
}

function toConfigError(raw: unknown, issue: z.core.$ZodIssue): ConfigError {
  const key = issue.path.map(String).join(".") || "(root)";
  const isMissing =
    (issue.code === "invalid_type" && valueAt(raw, issue.path) === undefined) ||
    (issue.code === "custom" &&
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
  const errors = parsed.error.issues.map((issue) => toConfigError(raw, issue));
  const missingKeys = [...new Set(errors.filter((e) => e.kind === "missing").map((e) => e.key))];
  return { ok: false, missingKeys, errors };
}
