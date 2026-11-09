import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CONFIG_PLACEHOLDER, loadConfig, type AppConfig } from "../src/index.js";

const templatePath = new URL("../../../config/app.config.json", import.meta.url);

function readTemplate(): AppConfig {
  // 固定パス（雛形）を読むだけなので安全
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  return JSON.parse(readFileSync(templatePath, "utf-8")) as AppConfig;
}

// 必須の文字列キー（AI モデル名・リージョンなど）
const REQUIRED_STRING_KEYS = [
  "region",
  "ai.generationModel",
  "ai.judgeModel",
  "ai.intentModel",
  "ai.location",
  "embedding.model",
  "embedding.version",
  "embedding.fieldPrefix",
] as const;

type RequiredKey = (typeof REQUIRED_STRING_KEYS)[number];

/** ドット区切りのキーが指す親オブジェクトと、最後のキー名を返す */
function locate(config: AppConfig, key: RequiredKey): [object, string] {
  const parts = key.split(".");
  const last = parts.pop() as string;
  let parent: unknown = config;
  for (const p of parts) parent = Reflect.get(parent as object, p);
  return [parent as object, last];
}

// 有効な値: 前後の空白を除いても空でなく、プレースホルダでもない文字列
const validValue = fc
  .string({ minLength: 1, maxLength: 30 })
  .filter((s) => s.trim() !== "" && s.trim() !== CONFIG_PLACEHOLDER);

// 未設定の値: 欠落・空文字・空白のみ・プレースホルダ
type Missing = { kind: "absent" } | { kind: "value"; value: string };
const missingValue: fc.Arbitrary<Missing> = fc.oneof(
  fc.constant<Missing>({ kind: "absent" }),
  fc.constantFrom<Missing>(
    { kind: "value", value: "" },
    { kind: "value", value: "   " },
    { kind: "value", value: "\t\n" },
    { kind: "value", value: CONFIG_PLACEHOLDER },
    { kind: "value", value: ` ${CONFIG_PLACEHOLDER} ` },
  ),
);

/** すべての必須キーを有効な値で埋めた設定 */
const filledConfig = fc.tuple(...REQUIRED_STRING_KEYS.map(() => validValue)).map((values) => {
  const config = readTemplate();
  REQUIRED_STRING_KEYS.forEach((key, i) => {
    const [parent, last] = locate(config, key);
    Reflect.set(parent, last, values.at(i));
  });
  return config;
});

// Feature: childcare-medical-welfare-navi, Property 39: 設定の検証
// Validates: Requirements 13.6, 13.7
describe("loadConfig (Property 39)", () => {
  it("必須キーが揃っていれば成功し、値は変更されずに返る", () => {
    fc.assert(
      fc.property(filledConfig, (config) => {
        const snapshot = structuredClone(config);
        const result = loadConfig(config);
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.config).toEqual(snapshot);
        // 入力そのものも変更しない
        expect(config).toEqual(snapshot);
      }),
    );
  });

  it("欠落・空の必須キーがあれば失敗し、そのキー名をすべて報告する", () => {
    fc.assert(
      fc.property(
        filledConfig,
        fc.subarray([...REQUIRED_STRING_KEYS], { minLength: 1 }),
        fc.array(missingValue, {
          minLength: REQUIRED_STRING_KEYS.length,
          maxLength: REQUIRED_STRING_KEYS.length,
        }),
        (config, broken, how) => {
          broken.forEach((key, i) => {
            const [parent, last] = locate(config, key);
            const m = how.at(i) as Missing;
            if (m.kind === "absent") Reflect.deleteProperty(parent, last);
            else Reflect.set(parent, last, m.value);
          });
          const result = loadConfig(config);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect([...result.missingKeys].sort()).toEqual([...broken].sort());
            // 未設定以外の問題（型や範囲の誤り）は報告されない
            expect(result.errors.filter((e) => e.kind === "invalid")).toEqual([]);
          }
        },
      ),
    );
  });
});
