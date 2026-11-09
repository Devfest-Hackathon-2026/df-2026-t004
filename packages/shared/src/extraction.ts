// 抽出結果の正規化とチャンク化（Requirement 3.4, 3.7, 3.9, 3.10）

import type { SourceAgeBand, SourceLevel } from "./collection.js";

// 構造化情報。表示と絞り込みにだけ使い、回答の根拠にはしない
export type StructuredInfo = {
  name: string | null;
  summary: string | null;
  eligibility: string | null;
  procedure: string | null;
  requiredDocs: string[] | null;
  deadline: string | null; // YYYY-MM-DD
  contact: { name: string; phone?: string; url?: string } | null;
  sourceName: string | null;
};

function field(raw: unknown, key: string): unknown {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return Object.prototype.hasOwnProperty.call(raw, key) ? Reflect.get(raw, key) : undefined;
}

// 空白だけの文字列は「見つからなかった」として扱う。値は変えない
function presentText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

// 実在する日付の YYYY-MM-DD だけを受け付ける
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function normalizeContact(value: unknown): StructuredInfo["contact"] {
  const name = presentText(field(value, "name"));
  if (name === null) return null;
  const contact: { name: string; phone?: string; url?: string } = { name };
  const phone = presentText(field(value, "phone"));
  const url = presentText(field(value, "url"));
  if (phone !== null) contact.phone = phone;
  if (url !== null) contact.url = url;
  return contact;
}

/**
 * AI による構造化抽出の結果を正規化する。
 * 見つからない・形が違う項目は null にし、推測で補わない。見つかった項目の値は変えない。
 */
export function normalizeExtraction(raw: unknown): StructuredInfo {
  const docs = field(raw, "requiredDocs");
  const keptDocs = Array.isArray(docs)
    ? docs.filter((d): d is string => presentText(d) !== null)
    : [];
  const deadline = field(raw, "deadline");
  return {
    name: presentText(field(raw, "name")),
    summary: presentText(field(raw, "summary")),
    eligibility: presentText(field(raw, "eligibility")),
    procedure: presentText(field(raw, "procedure")),
    requiredDocs: keptDocs.length > 0 ? keptDocs : null,
    deadline: typeof deadline === "string" && isIsoDate(deadline) ? deadline : null,
    contact: normalizeContact(field(raw, "contact")),
    sourceName: presentText(field(raw, "sourceName")),
  };
}

// 抽出した本文の区切り。HTML は見出しごと、PDF はページごと
export type SourceSection = { text: string; heading?: string; pdfPage?: number };

export type ChunkMeta = {
  programId: string;
  sourceId: string;
  sourceUrl: string;
  fetchedAt: string;
  contentHash: string;
  municipalityCode: string;
  level: SourceLevel;
  category: string;
  // 情報源に登録した年齢区分。空なら unknown
  ageBands: readonly SourceAgeBand[];
};

// 埋め込みを付ける前のチャンク。構造化情報のフィールドは持たない
export type ChunkDraft = {
  id: string;
  programId: string;
  sourceId: string;
  excerpt: string;
  sourceUrl: string;
  heading?: string;
  pdfPage?: number;
  contentHash: string;
  fetchedAt: string;
  municipalityCode: string;
  level: SourceLevel;
  category: string;
  searchable: false;
  band_pregnancy: boolean;
  band_age_0_2: boolean;
  band_age_3_5: boolean;
  band_age_6_11: boolean;
  band_age_12_14: boolean;
  band_age_15_18: boolean;
  band_unknown: boolean;
};

export type ChunkOptions = { maxChars: number; minChars: number };

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxChars: 500, minChars: 200 };

// 文の終わりとみなす文字。ここで切ると文の途中で切れにくい
const BOUNDARY = /[。．！？!?\n]/;

// 文字列を、なるべく文の終わりで maxChars 以下の区間 [start, end) に分ける
function splitRanges(text: string, opts: ChunkOptions): [number, number][] {
  const maxChars = Math.max(1, Math.floor(opts.maxChars));
  const minChars = Math.min(Math.max(0, Math.floor(opts.minChars)), maxChars);
  const ranges: [number, number][] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      for (let i = end - 1; i >= start + minChars; i--) {
        if (BOUNDARY.test(text.charAt(i))) {
          end = i + 1;
          break;
        }
      }
      // サロゲートペアの途中で切らない
      const code = text.charCodeAt(end - 1);
      if (end - start > 1 && code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    ranges.push([start, end]);
    start = end;
  }
  return ranges;
}

function bandFlags(ageBands: readonly SourceAgeBand[]) {
  const set = new Set<SourceAgeBand>(ageBands.length > 0 ? ageBands : ["unknown"]);
  return {
    band_pregnancy: set.has("pregnancy"),
    band_age_0_2: set.has("age_0_2"),
    band_age_3_5: set.has("age_3_5"),
    band_age_6_11: set.has("age_6_11"),
    band_age_12_14: set.has("age_12_14"),
    band_age_15_18: set.has("age_15_18"),
    band_unknown: set.has("unknown"),
  };
}

/**
 * 原文を抜粋のチャンクに分ける。要約や言い換えはしない。
 * 各チャンクの excerpt は、その区切りの原文の部分文字列（前後の空白だけ除く）。
 * 新しいチャンクは確認前なので searchable は false。
 */
export function chunkSource(
  sections: readonly SourceSection[],
  meta: ChunkMeta,
  options: ChunkOptions = DEFAULT_CHUNK_OPTIONS,
): ChunkDraft[] {
  const bands = bandFlags(meta.ageBands);
  const chunks: ChunkDraft[] = [];
  for (const section of sections) {
    for (const [start, end] of splitRanges(section.text, options)) {
      const excerpt = section.text.slice(start, end).trim();
      if (excerpt === "") continue;
      const chunk: ChunkDraft = {
        id: `${meta.sourceId}_${meta.contentHash.slice(0, 12)}_${chunks.length}`,
        programId: meta.programId,
        sourceId: meta.sourceId,
        excerpt,
        sourceUrl: meta.sourceUrl,
        contentHash: meta.contentHash,
        fetchedAt: meta.fetchedAt,
        municipalityCode: meta.municipalityCode,
        level: meta.level,
        category: meta.category,
        searchable: false,
        ...bands,
      };
      if (section.heading !== undefined && section.heading.trim() !== "") {
        chunk.heading = section.heading;
      }
      if (section.pdfPage !== undefined) chunk.pdfPage = section.pdfPage;
      chunks.push(chunk);
    }
  }
  return chunks;
}
