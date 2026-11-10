// Vertex AI の応答の読み取り（Requirement 5.8, 10.3）
import { ThinkingLevel } from "@google/genai";
import { describe, expect, it } from "vitest";
import {
  answerConfig,
  intentConfig,
  intentFromResponse,
  JUDGE_BASE_OUTPUT_TOKENS,
  judgeConfig,
} from "../src/index.js";

// Gemini 3 系は既定で思考し、思考トークンも maxOutputTokens に数えられる（#55 で全件の抽出が空になった原因）
describe("リクエスト設定の思考", () => {
  it("意図判定は思考を最小にし、上限に余裕を持たせる", () => {
    const c = intentConfig();
    expect(c.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.MINIMAL });
    expect(c.maxOutputTokens).toBeGreaterThan(64);
    expect(c.temperature).toBe(0);
  });

  it("回答生成は思考を LOW にし、上限は設定ファイルの値を使う", () => {
    const c = answerConfig(2048);
    expect(c.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.LOW });
    expect(c.maxOutputTokens).toBe(2048);
  });

  it("根拠判定は思考を LOW にし、主張の数に応じて上限を広げる", () => {
    const one = judgeConfig(1);
    const ten = judgeConfig(10);
    expect(one.thinkingConfig).toEqual({ thinkingLevel: ThinkingLevel.LOW });
    expect(one.maxOutputTokens).toBeGreaterThanOrEqual(JUDGE_BASE_OUTPUT_TOKENS);
    expect(ten.maxOutputTokens).toBeGreaterThan(one.maxOutputTokens);
  });
});

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
