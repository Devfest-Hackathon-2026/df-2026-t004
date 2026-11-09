// AI 相談の根拠探索のクエリ計画と結果の統合（Requirement 4.7, 5.1）
// Firestore のベクトル検索の事前フィルタは等価条件（==）だけで組み立てる。

import type { SourceAgeBand } from "./collection.js";

// 1クエリあたりの件数と、統合後に残す件数
export const SEARCH_TOP_K = 5;
// クエリ本数の上限（自治体3つ × 年齢区分7つ）
export const MAX_SEARCH_QUERIES = 21;

// 等価条件のみ。例: { municipalityCode: "13201", searchable: true, band_age_0_2: true }
export type SearchFilters = Record<string, string | boolean>;

export type SearchPlanInput =
  // 世帯の条件で探す。ageBands が null のときは年齢区分が未設定（Requirement 2.7）
  | {
      municipalityCodes: readonly string[];
      ageBands: readonly SourceAgeBand[] | null;
      category?: string | null;
    }
  // 「AIに聞く」で制度に限定する。カテゴリは使わない
  | { programId: string };

/**
 * 検索条件を等価条件のみのクエリ群にする。
 * - 制度に限定: { programId, searchable: true } の1本
 * - 年齢区分が未設定: 自治体コードごとに { municipalityCode, searchable: true [, category] }
 * - 通常: 自治体コード × (年齢区分 ∪ unknown) ごとに
 *   { municipalityCode, searchable: true, band_X: true [, category] }
 * クエリが MAX_SEARCH_QUERIES 本を超える入力は、黙って削らずに例外にする。
 */
export function planSearchQueries(input: SearchPlanInput): SearchFilters[] {
  if ("programId" in input) return [{ programId: input.programId, searchable: true }];

  const codes = [...new Set(input.municipalityCodes)];
  const category = input.category ?? null;
  const withCategory = (filters: SearchFilters): SearchFilters =>
    category === null ? filters : { ...filters, category };

  const queries: SearchFilters[] = [];
  if (input.ageBands === null) {
    for (const code of codes) {
      queries.push(withCategory({ municipalityCode: code, searchable: true }));
    }
  } else {
    const bands = [...new Set<SourceAgeBand>([...input.ageBands, "unknown"])];
    for (const code of codes) {
      for (const band of bands) {
        queries.push(
          withCategory({ municipalityCode: code, searchable: true, [`band_${band}`]: true }),
        );
      }
    }
  }
  if (queries.length > MAX_SEARCH_QUERIES) {
    throw new RangeError(
      `検索クエリが ${queries.length} 本になり、上限の ${MAX_SEARCH_QUERIES} 本を超えます`,
    );
  }
  return queries;
}

/** 文書が等価条件のクエリにすべて一致するか（テストとローカルの検索用） */
export function matchesFilters(doc: object, filters: SearchFilters): boolean {
  return Object.entries(filters).every(([key, value]) => Reflect.get(doc, key) === value);
}

export type ScoredChunk = { chunkId: string; similarity: number };

/**
 * 並列クエリの結果を chunkId で重複排除し、類似度の降順で上位 limit 件にする。
 * 同じチャンクが複数あれば類似度の高いほうを残す。同点は chunkId の順。
 */
export function mergeResults<T extends ScoredChunk>(
  lists: readonly (readonly T[])[],
  limit: number = SEARCH_TOP_K,
): T[] {
  const best = new Map<string, T>();
  for (const list of lists) {
    for (const item of list) {
      const prev = best.get(item.chunkId);
      if (prev === undefined || item.similarity > prev.similarity) best.set(item.chunkId, item);
    }
  }
  return [...best.values()]
    .sort((a, b) => b.similarity - a.similarity || compareText(a.chunkId, b.chunkId))
    .slice(0, Math.max(0, limit));
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * 埋め込みを L2 正規化する（DOT_PRODUCT で検索するため）。
 * 零ベクトルや有限でない値は向きが決まらないので例外にする。
 */
export function l2Normalize(vec: readonly number[]): number[] {
  if (!vec.every(Number.isFinite)) throw new RangeError("埋め込みに有限でない値があります");
  // 桁あふれを避けるため、最大の絶対値で割ってからノルムを求める
  const scale = vec.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  if (scale === 0) throw new RangeError("零ベクトルは正規化できません");
  const scaled = vec.map((x) => x / scale);
  const norm = Math.sqrt(scaled.reduce((s, x) => s + x * x, 0));
  return scaled.map((x) => x / norm);
}
