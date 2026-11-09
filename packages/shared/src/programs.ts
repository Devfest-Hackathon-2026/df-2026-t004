// 制度の確認状態・候補判定・表示モデル（Requirement 3.13〜3.16, 4.1〜4.10, 10.5, 10.6, 12.4）

import {
  AGE_BAND_LABELS,
  type AgeBand,
  type HouseholdAgeBands,
  type ProgramAgeBand,
} from "./age.js";
import { compareIsoDate, isValidIsoDate, toSlashDate } from "./date.js";
import {
  HACHIOJI_MUNICIPALITY_CODE,
  NATIONAL_MUNICIPALITY_CODE,
  TOKYO_MUNICIPALITY_CODE,
} from "./validation.js";

export type ProgramLevel = "national" | "tokyo" | "city";
export const PROGRAM_CATEGORIES = [
  "childcare",
  "medical",
  "pregnancy",
  "education",
  "welfare",
] as const;
export type ProgramCategory = (typeof PROGRAM_CATEGORIES)[number];

export const LEVEL_LABELS: Record<ProgramLevel, string> = {
  national: "国",
  tokyo: "東京都",
  city: "市",
};
export const CATEGORY_LABELS: Record<ProgramCategory, string> = {
  childcare: "子育て",
  medical: "医療費",
  pregnancy: "妊娠・出産",
  education: "教育",
  welfare: "手当・福祉",
};

/** `programs/{programId}`（設計書の Data Models） */
export type Program = {
  readonly id: string;
  readonly sourceId: string;
  readonly name: string;
  readonly level: ProgramLevel;
  readonly municipalityCode: string;
  readonly category: ProgramCategory;
  /** 読み取れないときは ["unknown"] */
  readonly ageBands: readonly ProgramAgeBand[];
  readonly summary: string | null;
  readonly eligibility: string | null;
  readonly procedure: string | null;
  readonly requiredDocs: readonly string[] | null;
  /** YYYY-MM-DD */
  readonly deadline: string | null;
  readonly contact: {
    readonly name: string;
    readonly phone?: string;
    readonly url?: string;
  } | null;
  readonly sourceName: string | null;
  readonly sourceUrl: string | null;
  /** 取得日（YYYY-MM-DD、または ISO 8601 の日時） */
  readonly fetchedAt: string | null;
  readonly verified: boolean;
  readonly verifiedAt?: string;
  readonly verifiedBy?: string;
  readonly verifiedContentHash?: string;
  readonly contentHash: string;
  readonly needsReview: boolean;
  readonly status: "active" | "excluded";
  readonly updatedAt: string;
};

// ---- 確認状態（Property 15, 16, 17） ----

/** 確認済みで、要再確認でなく、除外されていない制度だけが検索・表示の対象 */
export function isSearchable(p: Program): boolean {
  return p.verified && !p.needsReview && p.status === "active";
}

/**
 * 新しい取得版のハッシュを反映する。確認時のハッシュと異なれば要再確認にする。
 * 確認時のハッシュと同じなら、確認状態は変えない。
 */
export function applyContentChange(p: Program, newHash: string): Program {
  const needsReview = p.verifiedContentHash !== undefined && p.verifiedContentHash !== newHash;
  return { ...p, contentHash: newHash, needsReview };
}

/** 運営者の確認を記録する（today は YYYY-MM-DD） */
export function applyVerification(
  p: Program,
  hash: string,
  today: string,
  verifiedBy?: string,
): Program {
  if (!isValidIsoDate(today)) throw new Error("today must be YYYY-MM-DD");
  return {
    ...p,
    verified: true,
    verifiedAt: today,
    verifiedContentHash: hash,
    contentHash: hash,
    needsReview: false,
    ...(verifiedBy === undefined ? {} : { verifiedBy }),
  };
}

/** カスタムクレーム `admin` が真の主体だけが確認できる */
export function canVerify(claims: Readonly<Record<string, unknown>> | null | undefined): boolean {
  return claims?.["admin"] === true;
}

// ---- 候補判定（Property 10, 18, 21） ----

/** 世帯の住所から、対象になる自治体コード（国・東京都・市）を返す。市外は国のみ */
export function municipalityCodesFor(householdMunicipalityCode: string | null): readonly string[] {
  return householdMunicipalityCode === HACHIOJI_MUNICIPALITY_CODE
    ? [NATIONAL_MUNICIPALITY_CODE, TOKYO_MUNICIPALITY_CODE, HACHIOJI_MUNICIPALITY_CODE]
    : [NATIONAL_MUNICIPALITY_CODE];
}

export type MatchHousehold = {
  /** 八王子市なら "13201"。市外で国の制度のみのときは null など */
  readonly municipalityCode: string | null;
  readonly ageBands: HouseholdAgeBands;
};

export const POSSIBLE_ELIGIBILITY_LABEL = "対象の可能性";
export const NEEDS_CHECK_LABEL = "要確認";
export const MAYBE_CLOSED_LABEL = "受付が終了している可能性があります";

export type ProgramMatch = {
  readonly program: Program;
  /** 常に「対象の可能性」（確定した対象としては表示しない） */
  readonly label: typeof POSSIBLE_ELIGIBILITY_LABEL;
  /** 年齢区分が不明・未設定、または世帯の年齢区分が未設定 */
  readonly needsCheck: boolean;
  /** 締切が今日より前 */
  readonly maybeClosed: boolean;
};

export function filterByCategory(
  programs: readonly Program[],
  category: ProgramCategory | null,
): Program[] {
  return category === null ? [...programs] : programs.filter((p) => p.category === category);
}

/**
 * ダッシュボードの候補を、条件判定で選ぶ（ベクトル検索は使わない）。
 * - 確認済み（isSearchable）で、世帯の自治体コードに含まれる制度だけ
 * - カテゴリは判定の前に適用する
 * - 制度の年齢区分が unknown / 空なら除外せず「要確認」
 * - 世帯の年齢区分が unset なら年齢区分で除外せず、すべて「要確認」
 * - 締切を過ぎた制度も除外せず、注意を付ける
 */
export function matchPrograms(
  household: MatchHousehold,
  programs: readonly Program[],
  today: string,
  category: ProgramCategory | null = null,
): ProgramMatch[] {
  const codes = new Set(municipalityCodesFor(household.municipalityCode));
  const bands = new Set<AgeBand>(household.ageBands.bands);
  const out: ProgramMatch[] = [];
  for (const p of filterByCategory(programs, category)) {
    if (!isSearchable(p) || !codes.has(p.municipalityCode)) continue;
    const unknownBand = p.ageBands.length === 0 || p.ageBands.includes("unknown");
    let needsCheck: boolean;
    if (household.ageBands.unset || unknownBand) {
      needsCheck = true;
    } else if (p.ageBands.some((b) => b !== "unknown" && bands.has(b))) {
      needsCheck = false;
    } else {
      continue;
    }
    const maybeClosed = p.deadline !== null && compareIsoDate(p.deadline, today) < 0;
    out.push({ program: p, label: POSSIBLE_ELIGIBILITY_LABEL, needsCheck, maybeClosed });
  }
  return out;
}

// ---- 申請と締切（Property 20） ----

export type ApplicationTask = {
  readonly id: string;
  readonly label: string;
  readonly done: boolean;
};
export type Application = {
  readonly programId: string;
  readonly status: "not_started" | "in_progress" | "done";
  readonly deadline: string | null;
  readonly tasks: readonly ApplicationTask[];
};

export const UPCOMING_DEADLINES_LIMIT = 5;

/** 進行中の申請を締切の昇順で最大 limit 件（締切のないものは後ろ。完了は含めない） */
export function upcomingDeadlines(
  applications: readonly Application[],
  limit: number = UPCOMING_DEADLINES_LIMIT,
): Application[] {
  return applications
    .filter((a) => a.status === "in_progress")
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      const dx = x.a.deadline;
      const dy = y.a.deadline;
      if (dx === dy) return x.i - y.i;
      if (dx === null) return 1;
      if (dy === null) return -1;
      return compareIsoDate(dx, dy) || x.i - y.i;
    })
    .slice(0, Math.max(0, limit))
    .map(({ a }) => a);
}

export function applicationProgress(a: Application): { done: number; total: number } {
  return { done: a.tasks.filter((t) => t.done).length, total: a.tasks.length };
}

// ---- 表示モデル（Property 19, 35） ----

export const CARD_SUMMARY_MAX = 60;
export const SOURCE_UNVERIFIED_LABEL = "出典未確認";
export const CHECK_WITH_OFFICE_NOTICE = "最新の情報は問い合わせ窓口で確認してください。";

/** 60文字（コードポイント数）を超える要約は、59文字＋「…」に切り詰める */
export function truncateSummary(text: string, max: number = CARD_SUMMARY_MAX): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max - 1).join("") + "…";
}

/** 取得日・更新日の先頭10文字が YYYY-MM-DD なら、それを返す */
function datePart(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = value.slice(0, 10);
  return isValidIsoDate(d) ? d : null;
}

export function targetFamilyLabel(bands: readonly ProgramAgeBand[]): string {
  const known = bands.filter((b) => b !== "unknown");
  return known.length === 0
    ? AGE_BAND_LABELS.unknown
    : known.map((b) => AGE_BAND_LABELS[b]).join("・");
}

export type ProgramCard = {
  readonly id: string;
  readonly name: string;
  readonly levelLabel: string;
  readonly targetLabel: string;
  /** 60文字以内。資料から読み取れないときは null */
  readonly summary: string | null;
  readonly sourceName: string;
  /** YYYY/MM/DD（取得日。無ければ更新日） */
  readonly updatedAt: string | null;
  readonly eligibilityLabel: typeof POSSIBLE_ELIGIBILITY_LABEL;
  readonly needsCheck: boolean;
  readonly maybeClosed: boolean;
};

/** Program_Card の表示モデル（Requirement 4.5） */
export function toProgramCard(
  p: Program,
  match?: Pick<ProgramMatch, "needsCheck" | "maybeClosed">,
): ProgramCard {
  const date = datePart(p.fetchedAt) ?? datePart(p.updatedAt);
  return {
    id: p.id,
    name: p.name,
    levelLabel: LEVEL_LABELS[p.level],
    targetLabel: targetFamilyLabel(p.ageBands),
    summary: p.summary === null ? null : truncateSummary(p.summary),
    sourceName: p.sourceName ?? SOURCE_UNVERIFIED_LABEL,
    updatedAt: date === null ? null : toSlashDate(date),
    eligibilityLabel: POSSIBLE_ELIGIBILITY_LABEL,
    needsCheck: match?.needsCheck ?? (p.ageBands.length === 0 || p.ageBands.includes("unknown")),
    maybeClosed: match?.maybeClosed ?? false,
  };
}

export type ProgramView = {
  readonly id: string;
  readonly name: string;
  readonly levelLabel: string;
  readonly targetLabel: string;
  readonly summary: string | null;
  readonly eligibility: string | null;
  readonly procedure: string | null;
  readonly requiredDocs: readonly string[];
  /** YYYY/MM/DD */
  readonly deadline: string | null;
  readonly contact: Program["contact"];
  readonly source: {
    readonly name: string | null;
    readonly url: string | null;
    /** YYYY-MM-DD */
    readonly fetchedAt: string | null;
    /** 出典URLと取得日がそろっているか */
    readonly verified: boolean;
    /** そろっていなければ「出典未確認」 */
    readonly label: string | null;
  };
  /** 窓口での確認を促す注意書き（省略しない） */
  readonly notice: string;
};

/** 制度詳細の表示モデル。出典URLか取得日が欠けていれば「出典未確認」を付ける（Requirement 10.5, 10.6） */
export function toProgramView(p: Program): ProgramView {
  const fetchedAt = datePart(p.fetchedAt);
  const url = p.sourceUrl && p.sourceUrl.length > 0 ? p.sourceUrl : null;
  const verified = url !== null && fetchedAt !== null;
  return {
    id: p.id,
    name: p.name,
    levelLabel: LEVEL_LABELS[p.level],
    targetLabel: targetFamilyLabel(p.ageBands),
    summary: p.summary,
    eligibility: p.eligibility,
    procedure: p.procedure,
    requiredDocs: p.requiredDocs ?? [],
    deadline: p.deadline && isValidIsoDate(p.deadline) ? toSlashDate(p.deadline) : null,
    contact: p.contact,
    source: {
      name: p.sourceName,
      url,
      fetchedAt,
      verified,
      label: verified ? null : SOURCE_UNVERIFIED_LABEL,
    },
    notice: verified
      ? CHECK_WITH_OFFICE_NOTICE
      : `${SOURCE_UNVERIFIED_LABEL}です。${CHECK_WITH_OFFICE_NOTICE}`,
  };
}

// ---- オフラインキャッシュ（Property 46） ----

export const OFFLINE_CACHE_LIMIT = 50;

/** 開いた制度を先頭に移し、上限を超えたら最も長く開かれていないものから削除する */
export function touchCache(
  cache: readonly string[],
  id: string,
  limit: number = OFFLINE_CACHE_LIMIT,
): string[] {
  return [id, ...cache.filter((x) => x !== id)].slice(0, Math.max(1, limit));
}
