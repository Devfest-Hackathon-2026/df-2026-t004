import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decodeChunk,
  decodeEvalResult,
  encodeChunk,
  encodeEvalResult,
  SOURCE_AGE_BANDS,
  type Chunk,
  type EvalResult,
} from "../src/index.js";

const nonBlank = fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim() !== "");
const isoDate = fc
  .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2030, 0, 1) })
  .map((t) => new Date(t).toISOString());
const meta = fc.record({
  model: nonBlank,
  dimensions: fc.integer({ min: 1, max: 3072 }),
  createdAt: isoDate,
});
const bands = fc.record(
  Object.fromEntries(SOURCE_AGE_BANDS.map((b) => [`band_${b}`, fc.boolean()])) as Record<
    `band_${(typeof SOURCE_AGE_BANDS)[number]}`,
    fc.Arbitrary<boolean>
  >,
);

const chunk: fc.Arbitrary<Chunk> = fc
  .tuple(
    fc.record(
      {
        id: nonBlank,
        programId: nonBlank,
        sourceId: nonBlank,
        excerpt: nonBlank,
        sourceUrl: fc.webUrl(),
        heading: fc.string({ maxLength: 20 }),
        pdfPage: fc.integer({ min: 1, max: 500 }),
        contentHash: fc.stringMatching(/^[0-9a-f]{64}$/),
        fetchedAt: isoDate,
        municipalityCode: fc.constantFrom("00000", "13000", "13201"),
        level: fc.constantFrom("national" as const, "tokyo" as const, "city" as const),
        category: fc.constantFrom("childcare", "medical", "welfare"),
        searchable: fc.boolean(),
        embeddingMeta: fc.dictionary(fc.constantFrom("v1", "v2", "v3"), meta, { maxKeys: 3 }),
      },
      {
        requiredKeys: [
          "id",
          "programId",
          "sourceId",
          "excerpt",
          "sourceUrl",
          "contentHash",
          "fetchedAt",
          "municipalityCode",
          "level",
          "category",
          "searchable",
          "embeddingMeta",
        ],
      },
    ),
    bands,
  )
  .map(([base, b]) => ({ ...base, ...b }));

const rate = fc.double({ min: 0, max: 1, noNaN: true }).map((x) => x + 0);
const count = fc.integer({ min: 0, max: 50 });
const evalResult: fc.Arbitrary<EvalResult> = fc.record(
  {
    runId: fc.constant("20261109T120000Z"),
    ranAt: isoDate,
    evalSetVersion: nonBlank,
    models: fc.record({
      generation: nonBlank,
      judge: nonBlank,
      embedding: fc.record({
        model: nonBlank,
        dimensions: fc.integer({ min: 1, max: 3072 }),
        version: fc.constantFrom("v1", "v2"),
      }),
    }),
    metrics: fc.record(
      { recallAt5: rate, groundedRate: rate, citationValidRate: rate },
      { requiredKeys: [] },
    ),
    perQuestion: fc.array(
      fc.record(
        {
          id: nonBlank,
          retrievedHit: fc.boolean(),
          groundedClaims: count,
          totalClaims: count,
          validCitations: count,
          totalCitations: count,
          behavior: fc.constantFrom("answered" as const, "fallback" as const, "not_found" as const),
        },
        { requiredKeys: ["id"] },
      ),
      { maxLength: 5 },
    ),
    perf: fc.dictionary(
      fc.constantFrom("warmFirstDelta", "coldWaiting"),
      fc.record({
        p50Ms: fc.integer({ min: 0, max: 60_000 }),
        p90Ms: fc.integer({ min: 0, max: 60_000 }),
        samples: count,
      }),
    ),
  },
  { requiredKeys: ["runId", "ranAt", "evalSetVersion", "models", "metrics", "perQuestion"] },
);

// Feature: childcare-medical-welfare-navi, Property 51: シリアライズのラウンドトリップ
// Validates: Requirements 3.4, 6.1, 14.6
describe("encode / decode (Property 51)", () => {
  it("Chunk: decode(encode(x)) は x と等しい", () => {
    fc.assert(
      fc.property(chunk, (x) => {
        expect(decodeChunk(encodeChunk(x))).toEqual({ ok: true, value: x });
      }),
    );
  });

  it("EvalResult: decode(encode(x)) は x と等しい", () => {
    fc.assert(
      fc.property(evalResult, (x) => {
        expect(decodeEvalResult(encodeEvalResult(x))).toEqual({ ok: true, value: x });
      }),
    );
  });

  it("Chunk の decode は、ベクトル本体を読み捨て、不正な値を拒否する", () => {
    const x = fc.sample(chunk, { numRuns: 1, seed: 1 })[0]!;
    const stored = { ...encodeChunk(x), emb_v1: [0.6, 0.8] };
    expect(decodeChunk(stored)).toEqual({ ok: true, value: x });
    const bad = decodeChunk({ ...stored, municipalityCode: "13 01", searchable: "yes" });
    expect(bad.ok ? [] : bad.errors.map((e) => e.split(":")[0])).toEqual([
      "municipalityCode",
      "searchable",
    ]);
    expect(decodeChunk({ ...stored, embeddingMeta: { __proto__: null, "a.b": {} } }).ok).toBe(
      false,
    );
  });

  it("EvalResult の decode は、JSON でない文字列や範囲外の値を拒否する", () => {
    expect(decodeEvalResult("{").ok).toBe(false);
    const x: EvalResult = {
      runId: "r",
      ranAt: "2026-11-09T00:00:00.000Z",
      evalSetVersion: "v",
      models: {
        generation: "g",
        judge: "j",
        embedding: { model: "e", dimensions: 768, version: "v1" },
      },
      metrics: { recallAt5: 1.5 },
      perQuestion: [],
    };
    expect(decodeEvalResult(JSON.stringify(x)).ok).toBe(false);
  });
});
