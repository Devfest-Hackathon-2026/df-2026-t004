// 公的情報の収集の判定（Requirement 3.1〜3.3, 3.6, 3.11, 3.12）
// collector はこれらの純粋関数の結果に従って、取得・置換・除外・後回しを決める。

export type SourceLevel = "national" | "tokyo" | "city";
export type SourceFormat = "html" | "pdf";
export type SourceStatus = "active" | "excluded";

// 情報源の年齢区分。"unknown" は資料から読み取れないとき
export const SOURCE_AGE_BANDS = [
  "pregnancy",
  "age_0_2",
  "age_3_5",
  "age_6_11",
  "age_12_14",
  "age_15_18",
  "unknown",
] as const;
export type SourceAgeBand = (typeof SOURCE_AGE_BANDS)[number];

export const SOURCE_CATEGORIES = [
  "childcare",
  "medical",
  "pregnancy",
  "education",
  "welfare",
] as const;
export type SourceCategory = (typeof SOURCE_CATEGORIES)[number];

// sources/{sourceId}
export type SourceDoc = {
  id: string;
  url: string;
  municipalityCode: string;
  level: SourceLevel;
  format: SourceFormat;
  category: SourceCategory | null;
  // 制度とチャンクの年齢区分はこの値を使う（本文からは読み取らない）
  ageBands: SourceAgeBand[];
  title: string | null;
  // PDF のとき、同じ制度の HTML の情報源 ID。チャンクはその制度に足す
  relatedSourceId: string | null;
  intervalHours: number;
  status: SourceStatus;
  lastFetchedAt?: string;
  lastHash?: string;
  // 「見つからない」の連続回数
  missCount: number;
};

const HOUR_MS = 60 * 60 * 1000;

/**
 * 取得期限が来ているか。
 * - 除外済みの情報源は取得しない
 * - 一度も取得していない（または取得日時が読めない）ときは取得する
 * - それ以外は、前回の取得から取得間隔が経過したときだけ取得する
 */
export function isDue(
  source: Pick<SourceDoc, "status" | "intervalHours" | "lastFetchedAt">,
  now: Date,
): boolean {
  if (source.status !== "active") return false;
  if (source.lastFetchedAt === undefined) return true;
  const last = Date.parse(source.lastFetchedAt);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= source.intervalHours * HOUR_MS;
}

// 「見つからない」がこの回数だけ連続したら除外する
export const NOT_FOUND_EXCLUDE_THRESHOLD = 2;

export type SourceAction =
  // ハッシュが同じ。チャンクは変えず、最終取得日時だけ更新する
  | "skip"
  // 新規または内容が変わった。チャンクを作り直して置き換える
  | "replace"
  // 見つからなかったが、まだ除外しない。チャンクは保持する
  | "miss"
  // 見つからないが連続した。チャンクを検索対象から外す
  | "exclude";

export type SourceDecision = { action: SourceAction; missCount: number };

/**
 * 取得結果から、情報源に対して行うことを決める。
 * @param prevHash 前回保存した内容のハッシュ（初回は null）
 * @param newHash 今回取得した内容のハッシュ。「見つからない」応答のときは null
 * @param missCount これまでの「見つからない」の連続回数
 * 通信エラーやタイムアウトは「見つからない」ではないため、この関数を呼ばずにチャンクを保持する。
 */
export function decideSourceAction(
  prevHash: string | null,
  newHash: string | null,
  missCount: number,
): SourceDecision {
  if (newHash === null) {
    const next = Math.max(0, missCount) + 1;
    return { action: next >= NOT_FOUND_EXCLUDE_THRESHOLD ? "exclude" : "miss", missCount: next };
  }
  if (prevHash !== null && prevHash === newHash) {
    return { action: "skip", missCount: 0 };
  }
  return { action: "replace", missCount: 0 };
}

export type FetchTarget = {
  url: string;
  format: SourceFormat;
  // PDF の件数を数えるまとまり。PDF は同じ制度の HTML の ID、それ以外は自分の ID
  groupId: string;
};

export type FetchLimits = { maxPagesPerRun: number; maxPdfPerSource: number };

export type DeferReason = "maxPagesPerRun" | "maxPdfPerSource";

export type FetchPlan<T extends FetchTarget> = {
  selected: T[];
  deferred: { target: T; reason: DeferReason }[];
};

/**
 * 1回の実行で取得する対象を、一覧の順に上限まで選ぶ。
 * - 取得はすべて（PDF も）1ページとして数え、最大 maxPagesPerRun ページ
 * - 同じまとまり（groupId）の PDF は最大 maxPdfPerSource 件
 * 選ばなかった対象は理由を付けて deferred に入れ、次回の実行で取得する。
 */
export function planFetch<T extends FetchTarget>(
  targets: readonly T[],
  limits: FetchLimits,
): FetchPlan<T> {
  const selected: T[] = [];
  const deferred: { target: T; reason: DeferReason }[] = [];
  const pdfCount = new Map<string, number>();
  for (const target of targets) {
    if (selected.length >= limits.maxPagesPerRun) {
      deferred.push({ target, reason: "maxPagesPerRun" });
      continue;
    }
    if (target.format === "pdf") {
      const count = pdfCount.get(target.groupId) ?? 0;
      if (count >= limits.maxPdfPerSource) {
        deferred.push({ target, reason: "maxPdfPerSource" });
        continue;
      }
      pdfCount.set(target.groupId, count + 1);
    }
    selected.push(target);
  }
  return { selected, deferred };
}
