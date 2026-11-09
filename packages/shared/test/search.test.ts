import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  l2Normalize,
  matchesFilters,
  MAX_SEARCH_QUERIES,
  mergeResults,
  planSearchQueries,
  SOURCE_AGE_BANDS,
  type SourceAgeBand,
} from "../src/index.js";

const CODES = ["00000", "13000", "13201", "13202"] as const;
const CATEGORIES = ["childcare", "medical", "pregnancy", "education", "welfare"] as const;

type Doc = Record<string, string | boolean> & {
  id: string;
  municipalityCode: string;
  searchable: boolean;
  category: string;
  programId: string;
};

const docs = fc
  .array(
    fc.record({
      municipalityCode: fc.constantFrom(...CODES),
      searchable: fc.boolean(),
      category: fc.constantFrom(...CATEGORIES),
      programId: fc.constantFrom("p1", "p2", "p3"),
      bands: fc.subarray([...SOURCE_AGE_BANDS], { minLength: 1 }),
    }),
    { maxLength: 60 },
  )
  .map((list) =>
    list.map(({ bands, ...rest }, i): Doc => {
      const doc: Doc = { ...rest, id: `c${i}` };
      for (const band of SOURCE_AGE_BANDS) Reflect.set(doc, `band_${band}`, bands.includes(band));
      return doc;
    }),
  );

const ids = (list: readonly Doc[]) => list.map((d) => d.id).sort();

// Feature: childcare-medical-welfare-navi, Property 24: 検索クエリ計画と直接フィルタの等価性
// Validates: Requirements 4.7, 5.1
describe("planSearchQueries (Property 24)", () => {
  const householdBands = fc.option(fc.subarray(SOURCE_AGE_BANDS.filter((b) => b !== "unknown")), {
    nil: null,
  });

  it("クエリ群の結果の和集合が直接フィルタの結果と等しく、等価条件のみで21本以下", () => {
    fc.assert(
      fc.property(
        docs,
        fc.subarray(["00000", "13000", "13201"]),
        householdBands,
        fc.option(fc.constantFrom(...CATEGORIES), { nil: null }),
        (all, codes, bands, category) => {
          const queries = planSearchQueries({
            municipalityCodes: codes,
            ageBands: bands,
            category,
          });
          expect(queries.length).toBeLessThanOrEqual(MAX_SEARCH_QUERIES);
          for (const q of queries) {
            for (const v of Object.values(q)) expect(["string", "boolean"]).toContain(typeof v);
          }
          const union = all.filter((d) => queries.some((q) => matchesFilters(d, q)));
          const wanted = new Set<SourceAgeBand>([...(bands ?? []), "unknown"]);
          const direct = all.filter(
            (d) =>
              codes.includes(d.municipalityCode) &&
              d.searchable &&
              (bands === null || [...wanted].some((b) => Reflect.get(d, `band_${b}`) === true)) &&
              (category === null || d.category === category),
          );
          expect(ids(union)).toEqual(ids(direct));
        },
      ),
    );
  });

  it("制度に限定するときは programId と searchable の1本だけ", () => {
    fc.assert(
      fc.property(docs, fc.constantFrom("p1", "p2", "p3"), (all, programId) => {
        const queries = planSearchQueries({ programId });
        expect(queries).toEqual([{ programId, searchable: true }]);
        const union = all.filter((d) => matchesFilters(d, queries.at(0) ?? {}));
        expect(ids(union)).toEqual(
          ids(all.filter((d) => d.programId === programId && d.searchable)),
        );
      }),
    );
  });

  it("最大は 3自治体 × 7区分 = 21本。超える入力は例外", () => {
    const allBands = SOURCE_AGE_BANDS.filter((b) => b !== "unknown");
    expect(
      planSearchQueries({ municipalityCodes: ["00000", "13000", "13201"], ageBands: allBands }),
    ).toHaveLength(21);
    expect(() => planSearchQueries({ municipalityCodes: [...CODES], ageBands: allBands })).toThrow(
      RangeError,
    );
  });
});

// Feature: childcare-medical-welfare-navi, Property 25: 並列クエリ結果の統合
// Validates: Requirements 5.1
describe("mergeResults (Property 25)", () => {
  const item = fc.record({
    chunkId: fc.constantFrom(...Array.from({ length: 12 }, (_, i) => `c${i}`)),
    similarity: fc.double({ min: -1, max: 1, noNaN: true }),
  });

  it("重複がなく、類似度の降順で、最大5件、すべて入力に含まれ、上位を取りこぼさない", () => {
    fc.assert(
      fc.property(fc.array(fc.array(item, { maxLength: 5 }), { maxLength: 21 }), (lists) => {
        const merged = mergeResults(lists);
        const flat = lists.flat();
        expect(merged.length).toBe(Math.min(5, new Set(flat.map((x) => x.chunkId)).size));
        expect(new Set(merged.map((x) => x.chunkId)).size).toBe(merged.length);
        for (let i = 1; i < merged.length; i++) {
          expect(merged.at(i - 1)!.similarity).toBeGreaterThanOrEqual(merged.at(i)!.similarity);
        }
        for (const m of merged) expect(flat).toContain(m);
        // 残らなかったチャンクの最高類似度は、残った最下位以下
        const last = merged.at(-1);
        const kept = new Set(merged.map((x) => x.chunkId));
        for (const x of flat) {
          if (last !== undefined && !kept.has(x.chunkId)) {
            expect(x.similarity).toBeLessThanOrEqual(last.similarity);
          }
        }
      }),
    );
  });
});

// Feature: childcare-medical-welfare-navi, Property 41: 埋め込みの正規化
// Validates: Requirements 3.4, 5.1
describe("l2Normalize (Property 41)", () => {
  const vec = fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), {
    minLength: 1,
    maxLength: 64,
  });

  it("零でないベクトルはノルムが1になり、向きが変わらない", () => {
    fc.assert(
      fc.property(vec, (v) => {
        fc.pre(v.some((x) => Math.abs(x) > 1e-12));
        const out = l2Normalize(v);
        const norm = Math.sqrt(out.reduce((s, x) => s + x * x, 0));
        expect(Math.abs(norm - 1)).toBeLessThan(1e-6);
        // 元のベクトルとの余弦が1（同じ向き）
        const vNorm = l2Normalize(v.map((x) => x * 3));
        out.forEach((x, i) => expect(Math.abs(x - (vNorm.at(i) ?? NaN))).toBeLessThan(1e-9));
        const scale = Math.max(...v.map(Math.abs));
        const vs = v.map((x) => x / scale);
        const cos = out.reduce((s, x, i) => s + x * (vs.at(i) ?? 0), 0) / Math.hypot(...vs);
        expect(Math.abs(cos - 1)).toBeLessThan(1e-6);
      }),
    );
  });

  it("零ベクトルと有限でない値は例外", () => {
    expect(() => l2Normalize([0, 0, 0])).toThrow(RangeError);
    expect(() => l2Normalize([])).toThrow(RangeError);
    expect(() => l2Normalize([1, Number.NaN])).toThrow(RangeError);
    expect(() => l2Normalize([1, Number.POSITIVE_INFINITY])).toThrow(RangeError);
  });
});
