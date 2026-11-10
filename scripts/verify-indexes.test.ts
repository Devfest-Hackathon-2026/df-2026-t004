import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { vectorIndexes, type CompositeIndex } from "./gen-indexes.js";
import { parseArgs, parseCompositeIndexList, verifyIndexes } from "./verify-indexes.js";

const SETTINGS = { fieldPrefix: "emb_", version: "v1", dimensions: 768 };
const PREFIX = "projects/demo/databases/(default)/collectionGroups";

/** gen-indexes の定義を、gcloud の出力（composite list --format=json）の形にする */
function toGcloud(
  indexes: readonly CompositeIndex[],
  opts: { state?: string; dimensionAsString?: boolean; withName?: boolean } = {},
): Record<string, unknown>[] {
  return indexes.map((index, i) => ({
    name: `${PREFIX}/${index.collectionGroup}/indexes/CICAgI${i}`,
    queryScope: index.queryScope,
    state: opts.state ?? "READY",
    fields: [
      ...index.fields.map((f) =>
        "order" in f
          ? { fieldPath: f.fieldPath, order: f.order }
          : {
              fieldPath: f.fieldPath,
              vectorConfig: {
                dimension: opts.dimensionAsString
                  ? String(f.vectorConfig.dimension)
                  : f.vectorConfig.dimension,
                flat: {},
              },
            },
      ),
      ...(opts.withName ? [{ fieldPath: "__name__", order: "ASCENDING" }] : []),
    ],
  }));
}

function verify(list: unknown[], settings = SETTINGS) {
  return verifyIndexes(parseCompositeIndexList(JSON.stringify(list)), settings);
}

describe("parseCompositeIndexList", () => {
  it("gcloud の出力から、コレクション・状態・フィールド・次元を読む", () => {
    const [first] = parseCompositeIndexList(
      JSON.stringify(toGcloud(vectorIndexes(SETTINGS), { dimensionAsString: true })),
    );
    expect(first).toEqual({
      name: `${PREFIX}/chunks/indexes/CICAgI0`,
      collectionGroup: "chunks",
      queryScope: "COLLECTION",
      state: "READY",
      fields: [
        { fieldPath: "municipalityCode", order: "ASCENDING" },
        { fieldPath: "searchable", order: "ASCENDING" },
        { fieldPath: "band_pregnancy", order: "ASCENDING" },
        { fieldPath: "emb_v1", dimension: 768 },
      ],
    });
  });

  it("配列の設定（arrayConfig）も読める", () => {
    const [index] = parseCompositeIndexList(
      JSON.stringify([
        {
          name: `${PREFIX}/programs/indexes/X`,
          queryScope: "COLLECTION",
          state: "CREATING",
          fields: [{ fieldPath: "tags", arrayConfig: "CONTAINS" }],
        },
      ]),
    );
    expect(index?.fields).toEqual([{ fieldPath: "tags", arrayConfig: "CONTAINS" }]);
    expect(index?.state).toBe("CREATING");
  });

  it("空の一覧は空の配列になる", () => {
    expect(parseCompositeIndexList("[]")).toEqual([]);
  });

  it.each([
    ["JSON でない", "Listed 0 items."],
    ["配列でない", "{}"],
    ["name が無い", JSON.stringify([{ fields: [] }])],
    ["name の形が違う", JSON.stringify([{ name: "x", fields: [] }])],
    ["fields が配列でない", JSON.stringify([{ name: `${PREFIX}/chunks/indexes/X` }])],
    [
      "次元が数でない",
      JSON.stringify([
        {
          name: `${PREFIX}/chunks/indexes/X`,
          fields: [{ fieldPath: "emb_v1", vectorConfig: { dimension: "abc", flat: {} } }],
        },
      ]),
    ],
  ])("%s出力は例外にする（黙って素通りさせない）", (_label, text) => {
    expect(() => parseCompositeIndexList(text)).toThrow();
  });

  it("どんな文字列でも、例外か配列のどちらかになる", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (text) => {
        try {
          expect(Array.isArray(parseCompositeIndexList(text))).toBe(true);
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
      }),
    );
  });
});

describe("verifyIndexes", () => {
  const expected = vectorIndexes(SETTINGS);

  it("17本がすべて READY で次元が一致すれば合格（__name__ や並び順の違い、無関係なインデックスは問わない）", () => {
    const list = [
      ...toGcloud([...expected].reverse(), { withName: true, dimensionAsString: true }),
      {
        name: `${PREFIX}/programs/indexes/P`,
        queryScope: "COLLECTION",
        state: "CREATING",
        fields: [{ fieldPath: "municipalityCode", order: "ASCENDING" }],
      },
    ];
    expect(verify(list)).toEqual({ ok: true, problems: [], matched: 17 });
  });

  it("等価条件のフィールドの並び順が違っても、同じ構成として扱う", () => {
    const shuffled = expected.map((index) => ({
      ...index,
      fields: [...index.fields.slice(0, -1).reverse(), ...index.fields.slice(-1)],
    }));
    expect(verify(toGcloud(shuffled)).ok).toBe(true);
  });

  it("どれか1本が欠けると、不足として不合格", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: expected.length - 1 }), (drop) => {
        const result = verify(toGcloud(expected.filter((_, i) => i !== drop)));
        expect(result.ok).toBe(false);
        expect(result.matched).toBe(16);
        expect(result.problems.filter((p) => p.startsWith("不足"))).toHaveLength(1);
      }),
    );
  });

  it("READY でない（CREATING・NEEDS_REPAIR）ものがあれば不合格", () => {
    for (const state of ["CREATING", "NEEDS_REPAIR"]) {
      const list = toGcloud(expected);
      list[3] = { ...list[3], state };
      const result = verify(list);
      expect(result.ok).toBe(false);
      expect(result.problems).toEqual([expect.stringContaining(`READY でない`)]);
    }
  });

  it("次元が設定と違えば不合格", () => {
    const other = vectorIndexes({ ...SETTINGS, dimensions: 1536 });
    const result = verify(toGcloud(other));
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(17);
    expect(result.problems[0]).toContain("1536");
  });

  it("その版のベクトルを含む、想定外の構成のインデックスがあれば不合格", () => {
    const list = [
      ...toGcloud(expected),
      {
        name: `${PREFIX}/chunks/indexes/EXTRA`,
        queryScope: "COLLECTION",
        state: "READY",
        fields: [
          { fieldPath: "level", order: "ASCENDING" },
          { fieldPath: "emb_v1", vectorConfig: { dimension: 768, flat: {} } },
        ],
      },
    ];
    const result = verify(list);
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual([expect.stringContaining("想定外")]);
  });

  it("移行中の別の版（emb_v2）のインデックスは、v1 の検査に影響しない", () => {
    const v2 = vectorIndexes({ ...SETTINGS, version: "v2", dimensions: 1536 });
    const list = toGcloud([...expected, ...v2]);
    expect(verify(list).ok).toBe(true);
    // v2 を検査すれば、v2 の次元で検査する
    expect(verify(list, { ...SETTINGS, version: "v2", dimensions: 1536 }).ok).toBe(true);
    expect(verify(list, { ...SETTINGS, version: "v2" }).ok).toBe(false);
  });

  it("インデックスが1本も無ければ不合格", () => {
    const result = verify([]);
    expect(result.ok).toBe(false);
    expect(result.matched).toBe(0);
    expect(result.problems.filter((p) => p.startsWith("不足"))).toHaveLength(17);
  });
});

describe("parseArgs", () => {
  it("--input と --version を読む", () => {
    expect(parseArgs(["--input", "a.json", "--version", "v2"])).toEqual({
      input: "a.json",
      version: "v2",
    });
    expect(parseArgs([])).toEqual({});
  });

  it.each([["--force"], ["--input"]])("不明・値の無い引数は拒否する (%s)", (arg) => {
    expect(() => parseArgs([arg])).toThrow();
  });
});
