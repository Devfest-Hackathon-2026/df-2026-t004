// 全国の郵便番号の表（Requirement 2.2）
import { classifyPostalCode } from "@hachioji-gov/shared";
import { describe, expect, it } from "vitest";
import { loadPostalTable, parsePostalTsv } from "../src/index.js";

describe("郵便番号の表", () => {
  it("同梱の表で、八王子市・市外・存在しない番号を見分ける", async () => {
    const table = await loadPostalTable();
    expect(table.size).toBeGreaterThan(100_000);
    expect(classifyPostalCode("192-0083", table)).toMatchObject({
      kind: "hachioji",
      entry: { municipalityCode: "13201", city: "八王子市", town: "旭町" },
    });
    expect(classifyPostalCode("1920355", table)).toMatchObject({ kind: "hachioji" });
    expect(classifyPostalCode("193-0835", table)).toMatchObject({
      kind: "hachioji",
      entry: { town: "千人町" },
    });
    expect(classifyPostalCode("1000001", table)).toMatchObject({
      kind: "outside",
      entry: { municipalityCode: "13101", city: "千代田区" },
    });
    expect(classifyPostalCode("0000000", table).kind).toBe("notFound");
  });

  it("地方公共団体コードの無い行は読まない", () => {
    expect(parsePostalTsv("1920083\t13201\t東京都\t八王子市\t旭町\n").size).toBe(1);
    expect(() => parsePostalTsv("1920083\t\t東京都\t八王子市\t旭町\n")).toThrow();
  });
});
