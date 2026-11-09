import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  citationCounts,
  citationValidRate,
  groundedRate,
  percentile,
  recallAtK,
  validateEvalSet,
  type EvalExpected,
  type EvalQuestion,
} from "../src/index.js";

const URLS = ["https://example.jp/a", "https://example.jp/b", "https://example.jp/c"];
const url = fc.constantFrom(...URLS, "https://example.jp/d");

const expected: fc.Arbitrary<EvalExpected> = fc.oneof(
  fc.record({
    kind: fc.constant("answerable" as const),
    sourceUrls: fc.subarray(URLS, { minLength: 1 }),
    requiredFacts: fc.constant<string[]>(["事実"]),
  }),
  fc.constant({ kind: "no_answer" as const, expectedBehavior: "fallback_with_contact" as const }),
);

// Feature: childcare-medical-welfare-navi, Property 43: 評価指標
// Validates: Requirements 14.3, 14.5
describe("recallAtK / citationValidRate / groundedRate (Property 43)", () => {
  it("再現率は答えのある質問のうち期待する出典が上位5件に入った割合で、0以上1以下", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ expected, retrievedUrls: fc.array(url, { maxLength: 8 }) }), {
          maxLength: 30,
        }),
        (outcomes) => {
          const answerable = outcomes.flatMap((o) =>
            o.expected.kind === "answerable"
              ? [{ urls: o.expected.sourceUrls, top: o.retrievedUrls.slice(0, 5) }]
              : [],
          );
          const r = recallAtK(outcomes);
          if (answerable.length === 0) {
            expect(r).toBeNull();
            return;
          }
          const hits = answerable.filter((a) => a.urls.some((u) => a.top.includes(u))).length;
          expect(r).toBe(hits / answerable.length);
          expect(r).toBeGreaterThanOrEqual(0);
          expect(r).toBeLessThanOrEqual(1);
        },
      ),
    );
  });

  it("答えのない質問は再現率の分母に入らない", () => {
    const hit = { expected: { kind: "answerable", sourceUrls: [URLS[0]!], requiredFacts: ["x"] } };
    const noAnswer = {
      expected: { kind: "no_answer", expectedBehavior: "fallback_with_contact" },
      retrievedUrls: [],
    } as const;
    expect(recallAtK([{ ...hit, retrievedUrls: [URLS[0]!] } as never, noAnswer])).toBe(1);
  });

  it("引用の有効率は、取得したチャンクに対応する引用の割合", () => {
    const answer = fc
      .array(fc.integer({ min: 0, max: 9 }), { maxLength: 8 })
      .map((ns) => ns.map((n) => `文[${n}]。`).join(""));
    fc.assert(
      fc.property(
        fc.array(fc.tuple(answer, fc.integer({ min: 0, max: 6 })), { maxLength: 10 }),
        (items) => {
          const counts = items.map(([a, n]) => citationCounts(a, n));
          const all = items.flatMap(([a, n]) => {
            const unique = [...new Set([...a.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])))];
            return unique.map((c) => c >= 1 && c <= n);
          });
          const rate = citationValidRate(counts);
          if (all.length === 0) expect(rate).toBeNull();
          else expect(rate).toBe(all.filter(Boolean).length / all.length);
        },
      ),
    );
  });

  it("根拠範囲内率は、範囲内の主張の数を全主張数で割った値", () => {
    const item = fc.integer({ min: 0, max: 10 }).chain((total) =>
      fc.record({
        totalClaims: fc.constant(total),
        groundedClaims: fc.integer({ min: 0, max: total }),
      }),
    );
    fc.assert(
      fc.property(fc.array(item, { maxLength: 10 }), (items) => {
        const total = items.reduce((s, i) => s + i.totalClaims, 0);
        const r = groundedRate(items);
        if (total === 0) expect(r).toBeNull();
        else {
          expect(r).toBe(items.reduce((s, i) => s + i.groundedClaims, 0) / total);
          expect(r).toBeLessThanOrEqual(1);
        }
      }),
    );
  });
});

// Feature: childcare-medical-welfare-navi, Property 44: パーセンタイルの性質
// Validates: Requirements 12.8
describe("percentile (Property 44)", () => {
  it("p50 ≤ p90 で、どちらも最小値以上・最大値以下の、集合の要素", () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 60_000, noNaN: true }), { minLength: 1, maxLength: 50 }),
        (values) => {
          const p50 = percentile(values, 50);
          const p90 = percentile(values, 90);
          expect(p50).toBeLessThanOrEqual(p90);
          for (const p of [p50, p90]) {
            expect(p).toBeGreaterThanOrEqual(Math.min(...values));
            expect(p).toBeLessThanOrEqual(Math.max(...values));
            expect(values).toContain(p);
          }
        },
      ),
    );
  });

  it("最近傍順位法: 10件の p90 は9番目、p50 は5番目", () => {
    const values = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
    expect(percentile(values, 90)).toBe(9);
    expect(percentile(values, 50)).toBe(5);
    expect(percentile([42], 90)).toBe(42);
    expect(() => percentile([], 50)).toThrow(RangeError);
  });
});

// Feature: childcare-medical-welfare-navi, Property 45: 評価セットの検証
// Validates: Requirements 14.1, 14.2
describe("validateEvalSet (Property 45)", () => {
  const question = (i: number, kind: "answerable" | "no_answer"): EvalQuestion => ({
    id: `q${String(i).padStart(3, "0")}`,
    question: `質問${i}`,
    category: "childcare",
    expected:
      kind === "answerable"
        ? { kind, sourceUrls: [URLS[0]!], requiredFacts: ["月額1万円"] }
        : { kind, expectedBehavior: "fallback_with_contact" },
  });
  const build = (answerable: number, noAnswer: number) => ({
    version: "2026-11-evalset-v1",
    questions: [
      ...Array.from({ length: answerable }, (_, i) => question(i, "answerable")),
      ...Array.from({ length: noAnswer }, (_, i) => question(answerable + i, "no_answer")),
    ],
  });

  it("20問以上かつ答えのない質問が3問以上のときに限り成功する", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 6 }), (a, n) => {
        const r = validateEvalSet(build(a, n));
        expect(r.ok).toBe(a + n >= 20 && n >= 3);
      }),
    );
  });

  it("出典URL・必要な事実・カテゴリが欠けた質問が1つでもあれば失敗する", () => {
    const breakers: ((q: EvalQuestion) => unknown)[] = [
      (q) => ({ ...q, category: undefined }),
      (q) => ({ ...q, category: "travel" }),
      (q) => ({ ...q, expected: { ...q.expected, sourceUrls: [] } }),
      (q) => ({ ...q, expected: { ...q.expected, sourceUrls: ["not a url"] } }),
      (q) => ({ ...q, expected: { ...q.expected, requiredFacts: [] } }),
      (q) => ({ ...q, expected: { ...q.expected, requiredFacts: ["  "] } }),
      (q) => ({ ...q, question: "あ".repeat(501) }),
      (q) => ({ ...q, household: { ageBands: ["age_0_2"], municipalityCode: "八王子" } }),
    ];
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 16 }),
        fc.integer({ min: 0, max: breakers.length - 1 }),
        (index, b) => {
          const set = build(17, 3);
          const broken = set.questions.map((q, i) => (i === index ? breakers.at(b)!(q) : q));
          const r = validateEvalSet({ ...set, questions: broken });
          expect(r.ok).toBe(false);
        },
      ),
    );
    expect(validateEvalSet(build(17, 3)).ok).toBe(true);
  });

  it("id の重複は失敗。失敗時は理由を返す", () => {
    const set = build(17, 3);
    const dup = { ...set, questions: [...set.questions.slice(1), set.questions[1]] };
    const r = validateEvalSet(dup);
    expect(r).toEqual({ ok: false, errors: ["questions: 質問の id が重複しています"] });
    const few = validateEvalSet(build(10, 1));
    expect(few.ok ? [] : few.errors).toEqual([
      "questions: 質問が11問です（20問以上必要）",
      "questions: 答えのない質問が1問です（3問以上必要）",
    ]);
  });
});
