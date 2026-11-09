// Vertex AI の応答の読み取り（Requirement 5.8, 10.3）
import { describe, expect, it } from "vitest";
import { intentFromResponse } from "../src/index.js";

describe("intentFromResponse", () => {
  it("general と読めたときだけ general", () => {
    expect(intentFromResponse('{"intent":"general"}')).toBe("general");
    expect(intentFromResponse('{"intent":"medical_judgment"}')).toBe("medical_judgment");
  });

  it.each([
    ["JSON として読めない", "general"],
    ["空", ""],
    ["応答なし", undefined],
    ["intent が無い", "{}"],
    ["intent が想定外の値", '{"intent":"other"}'],
    ["intent が文字列でない", '{"intent":1}'],
    ["配列", '["general"]'],
  ])("%s なら医療の判断として扱う（安全側）", (_label, text) => {
    expect(intentFromResponse(text)).toBe("medical_judgment");
  });
});
