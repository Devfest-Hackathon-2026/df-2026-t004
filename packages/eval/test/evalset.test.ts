// 保存してある評価セットの検査（Requirement 14.1, 14.2）
import { readFileSync } from "node:fs";
import { validateEvalSet } from "@hachioji-gov/shared";
import { describe, expect, it } from "vitest";

const read = (path: string): unknown =>
  // 固定パスを読むだけなので安全
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

describe("eval/evalset.v1.json", () => {
  const raw = read("../../../eval/evalset.v1.json");
  const checked = validateEvalSet(raw);

  it("スキーマと件数（20問以上、答えのない質問3問以上）を満たす", () => {
    expect(checked).toMatchObject({ ok: true });
  });

  it("期待する出典は、すべて登録した情報源の URL", () => {
    const sources = read("../../../config/sources.seed.json") as { url: string }[];
    const registered = new Set(sources.map((s) => s.url));
    if (!checked.ok) throw new Error("invalid");
    for (const q of checked.value.questions) {
      if (q.expected.kind !== "answerable") continue;
      for (const url of q.expected.sourceUrls) expect(registered.has(url)).toBe(true);
    }
  });

  it("世帯の情報は年齢区分と市区町村コードだけ", () => {
    if (!checked.ok) throw new Error("invalid");
    for (const q of checked.value.questions) {
      if (q.household !== undefined) {
        expect(Object.keys(q.household).sort()).toEqual(["ageBands", "municipalityCode"]);
      }
    }
  });
});
