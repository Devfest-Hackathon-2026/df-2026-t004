import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { equalityFieldSets, VECTOR_INDEXES_PER_VERSION } from "./gen-indexes.js";
import { firstLine, parseArgs, probeQueries, unitVector } from "./probe-vector-search.js";

describe("probeQueries", () => {
  it("gen-indexes の17本の等価条件の組と1対1で対応する", () => {
    const queries = probeQueries();
    expect(queries).toHaveLength(VECTOR_INDEXES_PER_VERSION);
    const sets = equalityFieldSets().map((s) => [...s].sort().join(","));
    expect(queries.map((q) => Object.keys(q.filters).sort().join(","))).toEqual(sets);
  });

  it("searchable と年齢区分は true、それ以外は文字列で絞る", () => {
    for (const q of probeQueries()) {
      for (const [key, value] of Object.entries(q.filters)) {
        if (key === "searchable" || key.startsWith("band_")) expect(value).toBe(true);
        else expect(typeof value).toBe("string");
      }
    }
  });
});

describe("unitVector", () => {
  it("指定の次元で、長さ1のベクトルを返す", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 2048 }), (n) => {
        const v = unitVector(n);
        expect(v).toHaveLength(n);
        expect(Math.hypot(...v)).toBe(1);
      }),
    );
  });

  it("正の整数でない次元は例外にする", () => {
    for (const n of [0, -1, 1.5, Number.NaN]) expect(() => unitVector(n)).toThrow(RangeError);
  });
});

describe("firstLine と parseArgs", () => {
  it("エラーの1行目だけを返す", () => {
    expect(firstLine(new Error("9 FAILED_PRECONDITION: missing index\nhttps://example"))).toBe(
      "9 FAILED_PRECONDITION: missing index",
    );
    expect(firstLine("plain")).toBe("plain");
  });

  it("--version だけを受け付ける", () => {
    expect(parseArgs([])).toEqual({});
    expect(parseArgs(["--version", "v2"])).toEqual({ version: "v2" });
    expect(() => parseArgs(["--input", "x"])).toThrow();
  });
});
