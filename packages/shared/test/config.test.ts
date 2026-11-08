import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../src/index.js";

const templatePath = new URL("../../../config/app.config.json", import.meta.url);

function readTemplate(): AppConfig {
  // 固定パス（雛形）を読むだけなので安全
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return JSON.parse(readFileSync(templatePath, "utf-8")) as AppConfig;
}

function filledTemplate(): AppConfig {
  const raw = readTemplate();
  raw.ai.generationModel = "model-a";
  raw.ai.judgeModel = "model-b";
  raw.ai.intentModel = "model-c";
  return raw;
}

describe("loadConfig", () => {
  it("雛形のままだとモデル名3つが未設定として報告される", () => {
    const result = loadConfig(readTemplate());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect([...result.missingKeys].sort()).toEqual([
        "ai.generationModel",
        "ai.intentModel",
        "ai.judgeModel",
      ]);
    }
  });

  it("必須キーを埋めると成功し、値は変更されずに返る", () => {
    const raw = filledTemplate();
    const result = loadConfig(raw);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config).toEqual(raw);
    }
  });

  it("region を空にすると region が報告される", () => {
    const raw = filledTemplate();
    raw.region = "";
    const result = loadConfig(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingKeys).toEqual(["region"]);
    }
  });

  it("キーの欠落もキー名つきで報告される", () => {
    const raw: Partial<AppConfig> = filledTemplate();
    delete raw.region;
    const result = loadConfig(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingKeys).toContain("region");
    }
  });

  it("数値が範囲外なら invalid としてキー名つきで報告される", () => {
    const raw = filledTemplate();
    raw.limits.perUserPerDay = 0;
    const result = loadConfig(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missingKeys).toEqual([]);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ key: "limits.perUserPerDay", kind: "invalid" }),
      );
    }
  });
});
