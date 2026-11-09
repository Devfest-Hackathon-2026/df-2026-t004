// 保存形式との変換（Requirement 3.4, 14.6）
// decode は外から来た値を検証してから型付きの値にする。encode は保存する形にする。
// Program と ExpenseRecord の変換は、型を定義する PR（#73, #74）のマージ後に足す。

import { z } from "zod";
import { SOURCE_AGE_BANDS } from "./collection.js";
import { issuesToErrors, type DecodeResult } from "./evaluation.js";
import type { ChunkDraft } from "./extraction.js";
import type { EmbeddingMeta, EmbeddingTarget } from "./reembed.js";

// chunks/{chunkId}。ベクトル本体（emb_{version}）は Firestore の VectorValue のため、
// api が別に読み書きする。decode は emb_ のフィールドを読み捨てる
export type Chunk = Omit<ChunkDraft, "searchable"> & {
  searchable: boolean;
  embeddingMeta: Record<string, EmbeddingMeta>;
};

const text = z.string().refine((s) => s.trim() !== "", "空です");
// 版の名前。__proto__ などをキーにさせない
const versionKey = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/);
const isoDateTime = z.string().refine((s) => !Number.isNaN(Date.parse(s)), "日時が不正です");

const embeddingMetaSchema = z.object({
  model: text,
  dimensions: z.number().int().positive(),
  createdAt: isoDateTime,
});

const bandFields = Object.fromEntries(
  SOURCE_AGE_BANDS.map((b) => [`band_${b}`, z.boolean()] as const),
) as Record<`band_${(typeof SOURCE_AGE_BANDS)[number]}`, z.ZodBoolean>;

const chunkSchema = z.object({
  id: text,
  programId: text,
  sourceId: text,
  excerpt: text,
  sourceUrl: text,
  heading: z.string().optional(),
  pdfPage: z.number().int().positive().optional(),
  contentHash: text,
  fetchedAt: isoDateTime,
  municipalityCode: z.string().regex(/^\d{5}$/),
  level: z.enum(["national", "tokyo", "city"]),
  category: z.string(),
  searchable: z.boolean(),
  ...bandFields,
  embeddingMeta: z.record(versionKey, embeddingMetaSchema),
});

/** Firestore に書く形にする。値の無い任意項目は書かない */
export function encodeChunk(chunk: Chunk): Record<string, unknown> {
  const data: Record<string, unknown> = Object.fromEntries(
    Object.entries(chunk).filter(([, value]) => value !== undefined),
  );
  data.embeddingMeta = Object.fromEntries(
    Object.entries(chunk.embeddingMeta).map(([v, m]) => [v, { ...m }]),
  );
  return data;
}

/** Firestore から読んだ値を検証して Chunk にする */
export function decodeChunk(data: unknown): DecodeResult<Chunk> {
  const parsed = chunkSchema.safeParse(data);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: issuesToErrors(parsed.error) };
}

// eval/results/{runId}.json
export type EvalResult = {
  runId: string;
  ranAt: string;
  evalSetVersion: string;
  models: { generation: string; judge: string; embedding: EmbeddingTarget };
  metrics: { recallAt5?: number; groundedRate?: number; citationValidRate?: number };
  perQuestion: {
    id: string;
    retrievedHit?: boolean;
    groundedClaims?: number;
    totalClaims?: number;
    validCitations?: number;
    totalCitations?: number;
    behavior?: "answered" | "fallback" | "not_found";
  }[];
  // eval perf の結果。キーは計測の種類（例: "warmFirstDelta"、"coldWaiting"）
  perf?: Record<string, { p50Ms: number; p90Ms: number; samples: number }>;
};

const rate = z.number().min(0).max(1);
const count = z.number().int().min(0);
const ms = z.number().min(0).finite();

const evalResultSchema = z.object({
  runId: text,
  ranAt: isoDateTime,
  evalSetVersion: text,
  models: z.object({
    generation: text,
    judge: text,
    embedding: z.object({ model: text, dimensions: z.number().int().positive(), version: text }),
  }),
  metrics: z.object({
    recallAt5: rate.optional(),
    groundedRate: rate.optional(),
    citationValidRate: rate.optional(),
  }),
  perQuestion: z.array(
    z.object({
      id: text,
      retrievedHit: z.boolean().optional(),
      groundedClaims: count.optional(),
      totalClaims: count.optional(),
      validCitations: count.optional(),
      totalCitations: count.optional(),
      behavior: z.enum(["answered", "fallback", "not_found"]).optional(),
    }),
  ),
  perf: z.record(versionKey, z.object({ p50Ms: ms, p90Ms: ms, samples: count })).optional(),
});

/** 評価結果を JSON の文字列にする（Git に保存するため、読みやすく整形する） */
export function encodeEvalResult(result: EvalResult): string {
  return `${JSON.stringify(result, null, 2)}\n`;
}

/** JSON の文字列を検証して評価結果にする */
export function decodeEvalResult(json: string): DecodeResult<EvalResult> {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return { ok: false, errors: ["(root): JSON として読めません"] };
  }
  const parsed = evalResultSchema.safeParse(raw);
  return parsed.success
    ? { ok: true, value: parsed.data }
    : { ok: false, errors: issuesToErrors(parsed.error) };
}
