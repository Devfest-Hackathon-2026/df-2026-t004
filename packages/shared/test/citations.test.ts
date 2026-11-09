import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  aggregateGrounding,
  buildFallbackView,
  buildGroundingInputs,
  FALLBACK_MESSAGE,
  MAX_REGENERATIONS,
  nextChatAction,
  parseCitations,
  splitClaims,
  validateCitations,
  type ClaimVerdict,
} from "../src/index.js";

// 引用番号を含まない文の断片
const plain = fc.stringMatching(/^[ぁ-んァ-ン一-龠、0-9a-z ]{0,20}$/);
const answer = fc
  .array(
    fc.oneof(
      plain,
      fc.integer({ min: 0, max: 30 }).map((n) => `[${n}]`),
      fc.constantFrom("。", "\n", "。[1]", "：", "## 見出し\n"),
    ),
    { maxLength: 30 },
  )
  .map((parts) => parts.join(""));

const numbersIn = (text: string) => [...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));

// Feature: childcare-medical-welfare-navi, Property 26: 引用番号の検証
// Validates: Requirements 5.2, 5.3
describe("validateCitations (Property 26)", () => {
  it("無効な番号は本文中の引用番号のうち 1〜N の範囲外のものと一致し、本文を変えない", () => {
    fc.assert(
      fc.property(answer, fc.integer({ min: 0, max: 10 }), (text, n) => {
        const before = text;
        const invalid = validateCitations(text, n);
        expect(text).toBe(before);
        const expected = new Set(numbersIn(text).filter((c) => c < 1 || c > n));
        expect(new Set(invalid)).toEqual(expected);
        expect(invalid.length).toBe(expected.size);
      }),
    );
  });

  it("parseCitations は初めて現れた順に重複なく返す", () => {
    expect(parseCitations("a[2]b[1]c[2]d[10]")).toEqual([2, 1, 10]);
    expect(validateCitations("児童手当は月1万円です[1][6]。", 5)).toEqual([6]);
  });
});

// Feature: childcare-medical-welfare-navi, Property 28: 根拠確認の純粋部分
// Validates: Requirements 5.11, 14.4
describe("splitClaims / buildGroundingInputs / aggregateGrounding (Property 28)", () => {
  it("主張の引用番号を合わせると本文中の [n] と一致する（引用は取りこぼさない）", () => {
    fc.assert(
      fc.property(answer, (text) => {
        const claims = splitClaims(text);
        expect(new Set(claims.flatMap((c) => c.citations))).toEqual(new Set(numbersIn(text)));
        for (const c of claims) expect(new Set(c.citations)).toEqual(new Set(numbersIn(c.text)));
      }),
    );
  });

  it("範囲内の引用がない主張は uncited、ある主張は引用したチャンクの本文と対になる", () => {
    fc.assert(
      fc.property(answer, fc.array(plain, { maxLength: 6 }), (text, excerpts) => {
        const chunks = excerpts.map((excerpt) => ({ excerpt }));
        const claims = splitClaims(text);
        const inputs = buildGroundingInputs(claims, chunks);
        expect(inputs).toHaveLength(claims.length);
        inputs.forEach((input, i) => {
          const claim = claims.at(i)!;
          const inRange = claim.citations.filter((c) => c >= 1 && c <= chunks.length);
          if (inRange.length === 0) {
            expect(input.kind).toBe("uncited");
          } else {
            expect(input).toEqual({
              kind: "cited",
              claim: claim.text,
              citations: inRange,
              excerpts: inRange.map((c) => excerpts.at(c - 1)),
            });
          }
        });
      }),
    );
  });

  it("すべて supported のときだけ合格し、groundedRate = supported / 全主張", () => {
    const verdict = fc.constantFrom<ClaimVerdict>("supported", "unsupported", "uncited");
    fc.assert(
      fc.property(fc.array(verdict, { maxLength: 20 }), (verdicts) => {
        const r = aggregateGrounding(verdicts);
        const supported = verdicts.filter((v) => v === "supported").length;
        expect(r.passed).toBe(verdicts.length > 0 && supported === verdicts.length);
        expect(r.groundedRate).toBeGreaterThanOrEqual(0);
        expect(r.groundedRate).toBeLessThanOrEqual(1);
        expect(r.groundedRate).toBe(verdicts.length === 0 ? 0 : supported / verdicts.length);
      }),
    );
  });

  it("見出し・挨拶・前置きは主張にしない。句点の後の引用はその文に付ける", () => {
    const text = [
      "ご質問ありがとうございます。児童手当について説明します。",
      "## 対象",
      "0歳から18歳までの子どもを養育する人が対象です。[1]",
      "必要なもの：",
      "- 申請書と本人確認書類 [2]",
      "窓口で申請できます。",
    ].join("\n");
    expect(splitClaims(text)).toEqual([
      { text: "0歳から18歳までの子どもを養育する人が対象です[1]", citations: [1] },
      { text: "- 申請書と本人確認書類 [2]", citations: [2] },
      { text: "窓口で申請できます", citations: [] },
    ]);
    expect(aggregateGrounding([]).passed).toBe(false);
  });
});

// Feature: childcare-medical-welfare-navi, Property 27: 再生成は合計1回までで、失敗時は fallback になる
// Validates: Requirements 5.3, 5.12, 5.13
describe("nextChatAction (Property 27)", () => {
  const check = fc.record({ citationsValid: fc.boolean(), groundingPassed: fc.boolean() });

  it("合格なら accept、不合格なら再生成0回で regenerate、1回で fallback", () => {
    fc.assert(
      fc.property(check, fc.integer({ min: 0, max: 3 }), (c, regenerations) => {
        const action = nextChatAction({ ...c, regenerations });
        if (c.citationsValid && c.groundingPassed) expect(action).toBe("accept");
        else expect(action).toBe(regenerations === 0 ? "regenerate" : "fallback");
      }),
    );
  });

  it("どんな検証結果の列でも regenerate は1回以下で、必ず accept か fallback で終わる", () => {
    fc.assert(
      fc.property(fc.array(check, { minLength: 3, maxLength: 3 }), (checks) => {
        let regenerations = 0;
        let regenerateCount = 0;
        let final: string | undefined;
        for (const c of checks) {
          const action = nextChatAction({ ...c, regenerations });
          if (action !== "regenerate") {
            final = action;
            break;
          }
          regenerateCount += 1;
          regenerations += 1;
        }
        expect(regenerateCount).toBeLessThanOrEqual(MAX_REGENERATIONS);
        expect(["accept", "fallback"]).toContain(final);
      }),
    );
  });

  it("fallback の表示モデルは定型文・出典一覧・問い合わせ窓口だけで、回答本文を持たない", () => {
    const source = fc.record({
      n: fc.integer({ min: 1, max: 5 }),
      title: plain,
      url: fc.webUrl(),
    });
    fc.assert(
      fc.property(fc.array(source, { maxLength: 5 }), plain, (sources, contact) => {
        const view = buildFallbackView(sources, contact);
        expect(Object.keys(view).sort()).toEqual(["contact", "message", "sources"]);
        expect(view.message).toBe(FALLBACK_MESSAGE);
        expect(view.sources).toEqual(sources);
        expect(view.contact).toBe(contact);
      }),
    );
  });
});
