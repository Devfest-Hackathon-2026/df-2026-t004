// 情報源の登録の検証（Requirement 13.4, 13.5）
// `sources add` と `sources import` は、この結果が ok のときだけ登録する。

import {
  SOURCE_AGE_BANDS,
  SOURCE_CATEGORIES,
  type SourceAgeBand,
  type SourceCategory,
  type SourceFormat,
  type SourceLevel,
} from "./collection.js";

export type SourceRegistration = {
  id: string;
  url: string;
  municipalityCode: string;
  level: SourceLevel;
  format: SourceFormat;
  category: SourceCategory | null;
  ageBands: SourceAgeBand[];
  title: string | null;
  relatedSourceId: string | null;
  intervalHours: number;
};

export type RegistrationError = { field: string; kind: "missing" | "invalid" };

export type RegistrationResult =
  { ok: true; value: SourceRegistration } | { ok: false; errors: RegistrationError[] };

// レベルごとに決まっている自治体コード。市区町村は5桁の数字なら受け付ける
function expectedCodeFor(level: unknown): string | undefined {
  if (level === "national") return "00000";
  if (level === "tokyo") return "13000";
  return undefined;
}
const LEVELS: readonly SourceLevel[] = ["national", "tokyo", "city"];
const FORMATS: readonly SourceFormat[] = ["html", "pdf"];
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,99}$/;

function get(input: unknown, key: string): unknown {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return undefined;
  return Object.prototype.hasOwnProperty.call(input, key) ? Reflect.get(input, key) : undefined;
}

function isBlank(value: unknown): boolean {
  return (
    value === undefined || value === null || (typeof value === "string" && value.trim() === "")
  );
}

// http(s) の絶対 URL で、ホスト名があり、ユーザー名・パスワードを含まないもの
export function isValidSourceUrl(value: string): boolean {
  if (value !== value.trim()) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.hostname !== "" &&
    url.username === "" &&
    url.password === ""
  );
}

export function isValidMunicipalityCode(value: string): boolean {
  return /^\d{5}$/.test(value);
}

/**
 * 情報源の登録内容を検証する。
 * 必須: id、url（出典URL）、municipalityCode、level。
 * 失敗時は、欠けている（missing）または無効な（invalid）すべての項目名を返す。
 * 省略できる項目は既定値で埋める（format は URL から推定、intervalHours は defaultIntervalHours）。
 */
export function validateSourceRegistration(
  input: unknown,
  defaultIntervalHours = 24,
): RegistrationResult {
  const errors: RegistrationError[] = [];
  const need = (field: string, valid: (v: unknown) => boolean): unknown => {
    const value = get(input, field);
    if (isBlank(value)) errors.push({ field, kind: "missing" });
    else if (!valid(value)) errors.push({ field, kind: "invalid" });
    return value;
  };
  const optional = (field: string, valid: (v: unknown) => boolean): unknown => {
    const value = get(input, field);
    if (isBlank(value)) return undefined;
    if (!valid(value)) errors.push({ field, kind: "invalid" });
    return value;
  };

  const id = need("id", (v) => typeof v === "string" && ID_PATTERN.test(v));
  const url = need("url", (v) => typeof v === "string" && isValidSourceUrl(v));
  const code = need("municipalityCode", (v) => typeof v === "string" && isValidMunicipalityCode(v));
  const level = need("level", (v) => LEVELS.includes(v as SourceLevel));
  const format = optional("format", (v) => FORMATS.includes(v as SourceFormat));
  const category = optional("category", (v) => SOURCE_CATEGORIES.includes(v as SourceCategory));
  const ageBands = optional(
    "ageBands",
    (v) => Array.isArray(v) && v.every((b) => SOURCE_AGE_BANDS.includes(b as SourceAgeBand)),
  );
  const title = optional("title", (v) => typeof v === "string");
  const related = optional("relatedSourceId", (v) => typeof v === "string" && ID_PATTERN.test(v));
  const interval = optional(
    "intervalHours",
    (v) => typeof v === "number" && Number.isInteger(v) && v > 0,
  );

  // レベルと自治体コードの組み合わせ（国は 00000、東京都は 13000）
  const expectedCode = expectedCodeFor(level);
  if (
    expectedCode !== undefined &&
    typeof code === "string" &&
    isValidMunicipalityCode(code) &&
    code !== expectedCode
  ) {
    errors.push({ field: "municipalityCode", kind: "invalid" });
  }

  if (errors.length > 0) return { ok: false, errors };

  const urlText = url as string;
  const inferredFormat: SourceFormat = new URL(urlText).pathname.toLowerCase().endsWith(".pdf")
    ? "pdf"
    : "html";
  const bands = [...new Set((ageBands as SourceAgeBand[] | undefined) ?? [])];
  return {
    ok: true,
    value: {
      id: id as string,
      url: urlText,
      municipalityCode: code as string,
      level: level as SourceLevel,
      format: (format as SourceFormat | undefined) ?? inferredFormat,
      category: (category as SourceCategory | undefined) ?? null,
      ageBands: bands.length > 0 ? bands : ["unknown"],
      title: (title as string | undefined) ?? null,
      relatedSourceId: (related as string | undefined) ?? null,
      intervalHours: (interval as number | undefined) ?? defaultIntervalHours,
    },
  };
}
