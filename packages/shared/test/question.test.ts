import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { limitSuggestions, validateQuestion } from "../src/index.js";

// Feature: childcare-medical-welfare-navi, Property 22: 質問文の長さの検証
// Validates: Requirements 5.9, 13.10
describe("validateQuestion (Property 22)", () => {
  // サロゲートペア（絵文字など）を含む文字列
  const text = fc.string({ unit: "grapheme", maxLength: 600 });

  it("受理するのはコードポイント数が1〜500のときに限り、拒否時は上限と現在の文字数を示す", () => {
    fc.assert(
      fc.property(text, (s) => {
        const length = [...s].length;
        const result = validateQuestion(s);
        if (result.ok) {
          expect(length).toBeGreaterThanOrEqual(1);
          expect(length).toBeLessThanOrEqual(500);
          expect(result.value).toBe(s);
        } else {
          expect(result.message).toContain("最大500文字");
          expect(result.message).toContain(`${length}文字`);
          expect(result.length).toBe(length);
        }
        if (length > 500) expect(result.ok).toBe(false);
        if (length >= 1 && length <= 500 && s.trim() !== "") expect(result.ok).toBe(true);
      }),
    );
  });

  it("境界: 500文字は受理、501文字と空は拒否。絵文字は1文字と数える", () => {
    expect(validateQuestion("あ".repeat(500)).ok).toBe(true);
    expect(validateQuestion("あ".repeat(501)).ok).toBe(false);
    expect(validateQuestion("👶".repeat(500)).ok).toBe(true);
    expect(validateQuestion("").ok).toBe(false);
    expect(validateQuestion("   ").ok).toBe(false);
  });
});

// Feature: childcare-medical-welfare-navi, Property 23: 次の質問候補の上限
// Validates: Requirements 5.7
describe("limitSuggestions (Property 23)", () => {
  it("先頭から最大3件で、順序を変えない", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 10 }), (list) => {
        const copy = [...list];
        const out = limitSuggestions(list);
        expect(out).toEqual(list.slice(0, 3));
        expect(list).toEqual(copy);
      }),
    );
  });
});
