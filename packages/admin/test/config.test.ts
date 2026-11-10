import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readAdminConfig } from "../src/config.js";

describe("readAdminConfig", () => {
  it("リポジトリの設定から、運営操作に使う項目だけを読める（生成モデル名が未設定でもよい）", () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- リポジトリ内の固定パス
    const raw = readFileSync(new URL("../../../config/app.config.json", import.meta.url), "utf8");
    const result = readAdminConfig(JSON.parse(raw) as unknown);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.embedding.fieldPrefix).toBe("emb_");
      expect(result.config.defaultIntervalHours).toBeGreaterThan(0);
    }
  });

  it("必要な項目が無い・未設定の目印・型違いなら、その項目名を返す", () => {
    const result = readAdminConfig({
      embedding: { model: "<設定する>", dimensions: 0, version: "v1" },
      ai: { location: "asia-northeast1" },
      collector: { defaultIntervalHours: "24" },
    });
    expect(result).toEqual({
      ok: false,
      keys: [
        "embedding.model",
        "embedding.dimensions",
        "embedding.fieldPrefix",
        "collector.defaultIntervalHours",
      ],
    });
    expect(readAdminConfig(null)).toMatchObject({ ok: false });
  });
});
