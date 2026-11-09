import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyReembed,
  canCutover,
  needsReembed,
  planReembed,
  type EmbeddingMeta,
} from "../src/index.js";

const MODELS = ["gemini-embedding-001", "text-embedding-005"] as const;
const DIMS = [256, 768, 1536] as const;
const VERSIONS = ["v1", "v2", "v3"] as const;

const meta = fc.record({
  model: fc.constantFrom(...MODELS),
  dimensions: fc.constantFrom(...DIMS),
  createdAt: fc.constant("2026-11-09T00:00:00.000Z"),
});

const chunks = fc
  .array(
    fc.record({
      excerpt: fc.string({ maxLength: 20 }),
      searchable: fc.boolean(),
      embeddingMeta: fc.dictionary(fc.constantFrom(...VERSIONS), meta, { maxKeys: 3 }),
    }),
    { maxLength: 20 },
  )
  .map((list) => list.map((c, i) => ({ ...c, id: `c${i}` })));

const target = fc.record({
  model: fc.constantFrom(...MODELS),
  dimensions: fc.constantFrom(...DIMS),
  version: fc.constantFrom(...VERSIONS),
});

const differs = (m: EmbeddingMeta | undefined, t: { model: string; dimensions: number }) =>
  m === undefined || m.model !== t.model || m.dimensions !== t.dimensions;

// Feature: childcare-medical-welfare-navi, Property 42: 埋め込み再生成の不変条件
// Validates: Requirements 13.13, 13.14
describe("planReembed / canCutover (Property 42)", () => {
  it("選ぶのは目標の版が無いか、モデル・次元が異なるチャンクだけ", () => {
    fc.assert(
      fc.property(chunks, target, (list, t) => {
        const planned = new Set(planReembed(list, t).map((c) => c.id));
        for (const c of list) {
          const m = Object.entries(c.embeddingMeta).find(([v]) => v === t.version)?.[1];
          expect(planned.has(c.id)).toBe(differs(m, t));
        }
      }),
    );
  });

  it("適用後に再実行すると空になり、excerpt と searchable は変わらず、切り替えられる", () => {
    fc.assert(
      fc.property(chunks, target, (list, t) => {
        const planned = new Set(planReembed(list, t).map((c) => c.id));
        const after = list.map((c) =>
          planned.has(c.id) ? applyReembed(c, t, "2026-11-10T00:00:00.000Z") : c,
        );
        expect(planReembed(after, t)).toEqual([]);
        expect(after.map((c) => [c.id, c.excerpt, c.searchable])).toEqual(
          list.map((c) => [c.id, c.excerpt, c.searchable]),
        );
        // 他の版の記録は残す（切り戻しのため）
        after.forEach((c, i) => {
          for (const [v, m] of Object.entries(list.at(i)?.embeddingMeta ?? {})) {
            if (v !== t.version) expect(Object.entries(c.embeddingMeta)).toContainEqual([v, m]);
          }
        });
        expect(canCutover(after, t)).toBe(true);
      }),
    );
  });

  it("canCutover は検索対象のチャンクすべてが目標の版を持つときに限り真", () => {
    fc.assert(
      fc.property(chunks, target, (list, t) => {
        const expected = list.filter((c) => c.searchable).every((c) => !needsReembed(c, t));
        expect(canCutover(list, t)).toBe(expected);
      }),
    );
  });

  it("__proto__ という版名でも、プロトタイプを読んだり書き換えたりしない", () => {
    const t = { model: "m", dimensions: 3, version: "__proto__" };
    const chunk = { searchable: true, embeddingMeta: {} };
    expect(needsReembed(chunk, t)).toBe(true);
    const after = applyReembed(chunk, t, "2026-11-10T00:00:00.000Z");
    expect(needsReembed(after, t)).toBe(false);
    expect(Object.getPrototypeOf(after.embeddingMeta)).toBe(Object.prototype);
  });
});
