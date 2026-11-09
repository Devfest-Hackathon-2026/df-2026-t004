// 推定年齢と年齢区分（Requirement 2.7, 2.9, 2.14, 3.4, 4.2, 9.3）
// 年齢区分は制度の候補を探すための大まかな分類で、利用資格の判定には使わない。

import { compareIsoDate, parseIsoDate } from "./date.js";

export const AGE_BANDS = [
  "pregnancy",
  "age_0_2",
  "age_3_5",
  "age_6_11",
  "age_12_14",
  "age_15_18",
] as const;
export type AgeBand = (typeof AGE_BANDS)[number];
/** 制度・チャンク側だけが持つ「資料から読み取れない」区分 */
export type ProgramAgeBand = AgeBand | "unknown";

export const AGE_BAND_LABELS: Record<ProgramAgeBand, string> = {
  pregnancy: "妊娠中",
  age_0_2: "0〜2歳",
  age_3_5: "3〜5歳",
  age_6_11: "6〜11歳",
  age_12_14: "12〜14歳",
  age_15_18: "15〜18歳",
  unknown: "資料から読み取れません",
};

/** 保存している子どもの情報（`users/{uid}.household.children[]`） */
export type StoredChild = {
  readonly id: string;
  readonly ageYears: number;
  /** 0歳のときのみ 0〜11 */
  readonly ageMonths?: number;
  /** 年齢を入力した日（YYYY-MM-DD）。estimateAge の基準 */
  readonly recordedAt: string;
};

export type EstimatedAge = { readonly years: number; readonly months: number };

/** a から b までに満了した月数（b が a より前なら 0） */
function fullMonthsBetween(a: string, b: string): number {
  const x = parseIsoDate(a);
  const y = parseIsoDate(b);
  if (!x || !y || compareIsoDate(b, a) <= 0) return 0;
  const months = (y.year - x.year) * 12 + (y.month - x.month) - (y.day < x.day ? 1 : 0);
  return Math.max(0, months);
}

/**
 * 入力時の年齢（年・月）と記録日から、today 時点の推定年齢を求める。
 * 1歳以上で月齢を入れていない場合は、入力時を「ちょうど n 歳0か月」とみなす（少なめに見積もる）。
 * today が進んでも減少しない（Property 8）。
 */
export function estimateAge(child: StoredChild, today: string): EstimatedAge {
  const base = child.ageYears * 12 + (child.ageYears === 0 ? (child.ageMonths ?? 0) : 0);
  const total = base + fullMonthsBetween(child.recordedAt, today);
  return { years: Math.floor(total / 12), months: total % 12 };
}

/** 0〜18歳を年齢区分に変換する。19歳以上・負の値・整数でない値は null */
export function ageToBand(ageYears: number): Exclude<AgeBand, "pregnancy"> | null {
  if (!Number.isInteger(ageYears) || ageYears < 0) return null;
  if (ageYears <= 2) return "age_0_2";
  if (ageYears <= 5) return "age_3_5";
  if (ageYears <= 11) return "age_6_11";
  if (ageYears <= 14) return "age_12_14";
  if (ageYears <= 18) return "age_15_18";
  return null;
}

export type HouseholdAgeBands = {
  /** AGE_BANDS の順に並んだ、重複のない区分 */
  readonly bands: readonly AgeBand[];
  /** 区分が1つも無い（子ども0人で出産予定日の同意を拒否した、など）。Requirement 2.7 */
  readonly unset: boolean;
};

/**
 * 世帯の年齢区分を導出する。保存はせず、リクエストごとに求める。
 * - 子どもごとに estimateAge → ageToBand（19歳以上は区分なし）
 * - `pregnancy` は、要配慮情報への同意があり、出産予定日が実在する日付で today 以降のときだけ含める
 */
export function deriveAgeBands(
  children: readonly StoredChild[],
  pregnancy: { readonly dueDate: string } | null | undefined,
  consent: boolean,
  today: string,
): HouseholdAgeBands {
  const set = new Set<AgeBand>();
  for (const c of children) {
    const band = ageToBand(estimateAge(c, today).years);
    if (band) set.add(band);
  }
  if (
    consent &&
    pregnancy &&
    parseIsoDate(pregnancy.dueDate) &&
    compareIsoDate(pregnancy.dueDate, today) >= 0
  ) {
    set.add("pregnancy");
  }
  const bands = AGE_BANDS.filter((b) => set.has(b));
  return { bands, unset: bands.length === 0 };
}
