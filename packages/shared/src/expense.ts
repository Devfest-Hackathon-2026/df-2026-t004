// 医療費のまとめ（Requirement 6.1〜6.5）。手入力のみで、申請は代行しない。

import {
  addMonthsClamped,
  compareIsoDate,
  formatIsoDate,
  parseIsoDate,
  toSlashDate,
} from "./date.js";
import { matchPrograms, type MatchHousehold, type Program, isSearchable } from "./programs.js";
import { charCount, type FieldError, type ValidationResult } from "./validation.js";

export const FACILITY_MAX = 100;
export const AMOUNT_MAX = 9_999_999;
export const EXPENSE_YEARS_BACK = 5;
/** 保護者を対象者にするときの subjectId */
export const GUARDIAN_SUBJECT_ID = "guardian";

/** `users/{uid}/expenses/{expenseId}` */
export type ExpenseRecord = {
  readonly id: string;
  /** YYYY-MM-DD（表示は YYYY/MM/DD） */
  readonly date: string;
  readonly facility: string;
  readonly amountYen: number;
  /** 子どもの id、または "guardian" */
  readonly subjectId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type ExpenseInput = {
  /** YYYY-MM-DD または YYYY/MM/DD */
  readonly date: string;
  readonly facility: string;
  /** フォームの文字列のままでもよい（全角数字・カンマは受け付ける） */
  readonly amountYen: number | string;
  readonly subjectId: string;
};

/** 入力できる最も古い日（今日から5年前の同日。存在しない日は月末） */
export function expenseDateMin(today: string): string | null {
  const t = parseIsoDate(today);
  return t ? formatIsoDate(addMonthsClamped(t, -12 * EXPENSE_YEARS_BACK)) : null;
}

function normalizeDate(value: string): string {
  return value.trim().replaceAll("/", "-");
}

/** 金額を整数にする。整数でない・数字以外を含むときは null */
export function parseAmount(value: number | string): number | null {
  if (typeof value === "number") return Number.isInteger(value) ? value : null;
  const half = value
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[,，]/g, "");
  return /^\d{1,9}$/.test(half) ? Number(half) : null;
}

/**
 * 医療費記録の検証（Property 31）。問題のある欄ごとにエラーを返す。
 * - 日付: 今日以前かつ5年前以内
 * - 医療機関名: 1〜100文字（前後の空白は数えない）
 * - 金額: 1〜9,999,999 の整数
 * - 対象者: 登録済みの子どもの id、または保護者
 */
export function validateExpense(
  input: ExpenseInput,
  today: string,
  subjectIds: readonly string[],
): ValidationResult {
  const errors: FieldError[] = [];
  const date = normalizeDate(input.date);
  const min = expenseDateMin(today);
  if (input.date.trim() === "") {
    errors.push({ field: "date", message: "受診日を入れてください" });
  } else if (!parseIsoDate(date) || !min) {
    errors.push({ field: "date", message: "受診日は YYYY/MM/DD の形式で入れてください" });
  } else if (compareIsoDate(date, today) > 0) {
    errors.push({ field: "date", message: "未来の日付は入れられません" });
  } else if (compareIsoDate(date, min) < 0) {
    errors.push({
      field: "date",
      message: `${toSlashDate(min)} 以降の日付を入れてください（5年前まで）`,
    });
  }

  const facilityLength = charCount(input.facility.trim());
  if (facilityLength === 0) {
    errors.push({ field: "facility", message: "医療機関名を入れてください" });
  } else if (facilityLength > FACILITY_MAX) {
    errors.push({
      field: "facility",
      message: `医療機関名は${FACILITY_MAX}文字以内で入れてください`,
    });
  }

  const amount = parseAmount(input.amountYen);
  if (typeof input.amountYen === "string" && input.amountYen.trim() === "") {
    errors.push({ field: "amountYen", message: "金額を入れてください（1〜9,999,999円）" });
  } else if (amount === null || amount < 1 || amount > AMOUNT_MAX) {
    errors.push({ field: "amountYen", message: "金額は1〜9,999,999円の整数で入れてください" });
  }

  if (!subjectIds.includes(input.subjectId) && input.subjectId !== GUARDIAN_SUBJECT_ID) {
    errors.push({ field: "subjectId", message: "だれの医療費かを選んでください" });
  }
  return { ok: errors.length === 0, errors };
}

export function canSaveExpense(
  input: ExpenseInput,
  today: string,
  subjectIds: readonly string[],
): boolean {
  return validateExpense(input, today, subjectIds).ok;
}

/** 検証済みの入力を保存形式に整える（検証に失敗する入力では null） */
export function toExpenseRecord(
  input: ExpenseInput,
  ids: { readonly id: string; readonly now: string; readonly createdAt?: string },
  today: string,
  subjectIds: readonly string[],
): ExpenseRecord | null {
  if (!canSaveExpense(input, today, subjectIds)) return null;
  return {
    id: ids.id,
    date: normalizeDate(input.date),
    facility: input.facility.trim(),
    amountYen: parseAmount(input.amountYen) ?? 0,
    subjectId: input.subjectId,
    createdAt: ids.createdAt ?? ids.now,
    updatedAt: ids.now,
  };
}

// ---- 集計（Property 32） ----

export type ExpenseBucket = {
  readonly key: string;
  readonly totalYen: number;
  readonly count: number;
};

export type ExpenseSummary = {
  readonly totalYen: number;
  readonly count: number;
  /** key は YYYY-MM。新しい順 */
  readonly byMonth: readonly ExpenseBucket[];
  /** key は YYYY。新しい順 */
  readonly byYear: readonly ExpenseBucket[];
  /** key は subjectId。金額の多い順 */
  readonly bySubject: readonly ExpenseBucket[];
};

function bucketize(
  records: readonly ExpenseRecord[],
  keyOf: (r: ExpenseRecord) => string,
): Map<string, { totalYen: number; count: number }> {
  const m = new Map<string, { totalYen: number; count: number }>();
  for (const r of records) {
    const k = keyOf(r);
    const cur = m.get(k) ?? { totalYen: 0, count: 0 };
    m.set(k, { totalYen: cur.totalYen + r.amountYen, count: cur.count + 1 });
  }
  return m;
}

const toBuckets = (m: Map<string, { totalYen: number; count: number }>): ExpenseBucket[] =>
  [...m.entries()].map(([key, v]) => ({ key, ...v }));

/** 暦月・暦年・家族ごとの合計。どの区分の合計も全記録の合計に等しい */
export function aggregateExpenses(records: readonly ExpenseRecord[]): ExpenseSummary {
  const byKeyDesc = (a: ExpenseBucket, b: ExpenseBucket) => compareIsoDate(b.key, a.key);
  return {
    totalYen: records.reduce((s, r) => s + r.amountYen, 0),
    count: records.length,
    byMonth: toBuckets(bucketize(records, (r) => r.date.slice(0, 7))).sort(byKeyDesc),
    byYear: toBuckets(bucketize(records, (r) => r.date.slice(0, 4))).sort(byKeyDesc),
    bySubject: toBuckets(bucketize(records, (r) => r.subjectId)).sort(
      (a, b) => b.totalYen - a.totalYen || compareIsoDate(a.key, b.key),
    ),
  };
}

// ---- 医療費からの制度の提示（Property 33） ----

export const EXPENSE_SUGGESTION_LIMIT = 5;

export type ExpenseSuggestion = {
  readonly programId: string;
  readonly name: string;
  readonly label: "対象の可能性";
  readonly needsCheck: boolean;
  readonly source: {
    readonly name: string | null;
    readonly url: string;
    readonly fetchedAt: string;
  };
  /** 集計の対象期間（今日の属する暦年） */
  readonly period: { readonly from: string; readonly to: string };
  readonly periodTotalYen: number;
  readonly recordIds: readonly string[];
  /** 必要書類のうち、まだそろっていないもの */
  readonly missingDocs: readonly string[];
};

/**
 * 医療費の記録があるとき、確認済みの医療費カテゴリの制度を最大5件提示する。
 * - 世帯が分かるときは matchPrograms（自治体・年齢区分）で絞る
 * - 出典URLと取得日がそろわない制度は、出典を示せないので提示しない
 * - 申請はユーザー自身が行う（このアプリは代行しない）
 */
export function suggestProgramsFromExpenses(
  records: readonly ExpenseRecord[],
  programs: readonly Program[],
  options: {
    readonly today: string;
    readonly household?: MatchHousehold;
    /** 申請ごとに、そろえ終わった書類 */
    readonly preparedDocs?: Readonly<Record<string, readonly string[]>>;
    readonly limit?: number;
  },
): ExpenseSuggestion[] {
  const year = options.today.slice(0, 4);
  const period = { from: `${year}-01-01`, to: options.today };
  const inPeriod = records.filter(
    (r) => compareIsoDate(r.date, period.from) >= 0 && compareIsoDate(r.date, period.to) <= 0,
  );
  if (inPeriod.length === 0) return [];
  const periodTotalYen = inPeriod.reduce((s, r) => s + r.amountYen, 0);

  const candidates = options.household
    ? matchPrograms(options.household, programs, options.today, "medical").map((m) => ({
        program: m.program,
        needsCheck: m.needsCheck,
      }))
    : programs
        .filter((p) => isSearchable(p) && p.category === "medical")
        .map((program) => ({ program, needsCheck: true }));

  const prepared = new Map(Object.entries(options.preparedDocs ?? {}));
  const out: ExpenseSuggestion[] = [];
  for (const { program: p, needsCheck } of candidates) {
    const fetchedAt = p.fetchedAt?.slice(0, 10) ?? null;
    if (!p.sourceUrl || !fetchedAt || !parseIsoDate(fetchedAt)) continue;
    const done = new Set(prepared.get(p.id) ?? []);
    out.push({
      programId: p.id,
      name: p.name,
      label: "対象の可能性",
      needsCheck,
      source: { name: p.sourceName, url: p.sourceUrl, fetchedAt },
      period,
      periodTotalYen,
      recordIds: inPeriod.map((r) => r.id),
      missingDocs: (p.requiredDocs ?? []).filter((d) => !done.has(d)),
    });
    if (out.length >= (options.limit ?? EXPENSE_SUGGESTION_LIMIT)) break;
  }
  return out;
}
