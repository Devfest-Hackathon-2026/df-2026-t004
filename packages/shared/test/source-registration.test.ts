import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { validateSourceRegistration } from "../src/index.js";

const valid = {
  id: "city-jido-teate",
  url: "https://kosodate.city.hachioji.tokyo.jp/nenrei/1_2sai/sodan_support/1178.html",
  municipalityCode: "13201",
  level: "city",
};

// Feature: childcare-medical-welfare-navi, Property 40: 情報源登録の検証
// Validates: Requirements 13.4, 13.5
describe("validateSourceRegistration (Property 40)", () => {
  type Case = { value: unknown; kind: "ok" | "missing" | "invalid" };
  const tag = (arb: fc.Arbitrary<unknown>, kind: Case["kind"]): fc.Arbitrary<Case> =>
    arb.map((value) => ({ value, kind }));
  const blank = fc.constantFrom(undefined, null, "", "  ");
  const url = fc.oneof(
    tag(fc.webUrl({ validSchemes: ["https", "http"] }), "ok"),
    tag(
      fc.constantFrom(
        "kosodate.city.hachioji.tokyo.jp/a.html",
        "ftp://example.jp/a",
        "javascript:alert(1)",
        "https://user:pass@example.jp/",
        " https://example.jp/",
        42,
      ),
      "invalid",
    ),
    tag(blank, "missing"),
  );
  const code = fc.oneof(
    tag(fc.stringMatching(/^\d{5}$/), "ok"),
    tag(fc.constantFrom("1320", "132011", "abcde", "13 01", 13201), "invalid"),
    tag(blank, "missing"),
  );

  it("出典URLと自治体コードの両方が有効なときだけ成功し、失敗時は項目名を返す", () => {
    fc.assert(
      fc.property(url, code, (u, c) => {
        const result = validateSourceRegistration({
          ...valid,
          url: u.value,
          municipalityCode: c.value,
        });
        expect(result.ok).toBe(u.kind === "ok" && c.kind === "ok");
        if (!result.ok) {
          const urlError = result.errors.find((e) => e.field === "url");
          const codeError = result.errors.find((e) => e.field === "municipalityCode");
          expect(urlError?.kind ?? "ok").toBe(u.kind);
          expect(codeError?.kind ?? "ok").toBe(c.kind);
        }
      }),
    );
  });

  it("失敗しても入力を変えない", () => {
    const input = { ...valid, url: "not a url" };
    const copy = structuredClone(input);
    validateSourceRegistration(input);
    expect(input).toEqual(copy);
  });

  it("国と東京都は決まった自治体コードでないと無効", () => {
    expect(
      validateSourceRegistration({ ...valid, level: "national", municipalityCode: "13201" }),
    ).toEqual({ ok: false, errors: [{ field: "municipalityCode", kind: "invalid" }] });
    expect(
      validateSourceRegistration({ ...valid, level: "tokyo", municipalityCode: "13000" }).ok,
    ).toBe(true);
  });

  it("省略した項目を既定値で埋める", () => {
    const result = validateSourceRegistration({ ...valid, url: "https://example.jp/a.PDF" });
    expect(result).toEqual({
      ok: true,
      value: {
        ...valid,
        url: "https://example.jp/a.PDF",
        format: "pdf",
        category: null,
        ageBands: ["unknown"],
        title: null,
        relatedSourceId: null,
        intervalHours: 24,
      },
    });
  });

  it("config/sources.seed.json の全行が検証を通り、関連 ID が実在する", () => {
    const seedPath = new URL("../../../config/sources.seed.json", import.meta.url);
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- リポジトリ内の固定のファイル
    const seed = JSON.parse(readFileSync(seedPath, "utf8")) as unknown[];
    const results = seed.map((row) => validateSourceRegistration(row));
    expect(results.filter((r) => !r.ok)).toEqual([]);
    const values = results.flatMap((r) => (r.ok ? [r.value] : []));
    const ids = new Set(values.map((v) => v.id));
    expect(ids.size).toBe(values.length);
    for (const v of values) {
      if (v.relatedSourceId !== null) expect(ids.has(v.relatedSourceId)).toBe(true);
    }
  });
});
