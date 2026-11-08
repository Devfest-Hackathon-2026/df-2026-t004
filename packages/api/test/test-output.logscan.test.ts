// テスト実行中のログの個人情報スキャン（Requirement 15.3）
// `npm run test:integration` が保存した logs/test-output.log を検査する。
// 実行: npm run test:log-scan
import { existsSync, readFileSync } from "node:fs";
import { scanLogForLeaks } from "@hachioji-gov/shared";
import { describe, expect, it } from "vitest";
import { CANARIES } from "./support/canaries.js";

const logFile = new URL("../../../logs/test-output.log", import.meta.url);

describe("テスト実行中のログ", () => {
  it("logs/test-output.log がある（先に npm run test:integration を実行する）", () => {
    // 固定パスを読むだけなので安全
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    expect(existsSync(logFile)).toBe(true);
  });

  it("電話番号・メール・郵便番号・シークレット・質問文のカナリアを含まない", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const text = readFileSync(logFile, "utf-8");
    expect(text.length).toBeGreaterThan(0);
    // 検出結果は種類と行番号だけを出す（漏れた内容を CI のログに再び出さない）
    expect(scanLogForLeaks(text, { canaries: CANARIES })).toEqual([]);
  });

  it("カナリアを使うテストが実行されている（スキャンが空振りしていない）", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const text = readFileSync(logFile, "utf-8");
    // ダミーのルートへの書き込みでは、カナリアを含む入力をロガーに渡している
    expect(text).toContain('"message":"dummy.write"');
  });
});
