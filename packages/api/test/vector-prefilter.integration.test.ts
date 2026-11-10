// ベクトル検索の事前フィルタを Firestore Emulator で確かめる（Requirement 4.7, 5.1。設計書 U-1）
// `npm run test:integration` で実行する。
//
// - 等価条件だけの事前フィルタ（planSearchQueries の形）と findNearest の組み合わせが動き、
//   フィルタを直接適用した場合と同じ結果になることを確かめる
// - `in`・`array-contains`・`array-contains-any`・`or` を事前フィルタに使えるかを試し、結果を記録する
//
// 注意: Emulator は複合インデックスを要求せず、実環境の検索エンジンとは別の実装である。
// ここでの結果は「Emulator での動作」の記録で、実環境での可否は UW-GC-9 で確かめる。
// そのため、等価条件以外が Emulator で使えても、設計（等価条件のみ・band_X の真偽値）は変えない。

import { planSearchQueries, SOURCE_AGE_BANDS } from "@hachioji-gov/shared";
import type { SourceAgeBand } from "@hachioji-gov/shared";
import { FieldValue, Filter, type Query } from "firebase-admin/firestore";
import { beforeAll, describe, expect, it } from "vitest";
import { FirestoreChatVectorStore } from "../src/index.js";
import { adminDb, resetEmulators } from "./support/emulator.js";

const FIELD = "emb_v1";
const CODES = ["00000", "13000", "13201"] as const;
const CATEGORIES = ["childcare", "medical"] as const;

type Doc = {
  id: string;
  municipalityCode: string;
  searchable: boolean;
  category: string;
  programId: string;
  ageBands: SourceAgeBand[];
  vector: number[];
};

/** 再現できる疑似乱数（線形合同法） */
function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2 ** 31;
    return s / 2 ** 31;
  };
}

function unit(v: number[]): number[] {
  const n = Math.hypot(...v);
  return v.map((x) => x / n);
}

// 3自治体 × 年齢区分の組 × カテゴリ × 検索可否 の混ざったチャンク
const DOCS: Doc[] = (() => {
  const r = rng(42);
  const docs: Doc[] = [];
  for (let i = 0; i < 60; i += 1) {
    const bands = SOURCE_AGE_BANDS.filter((b) => b !== "unknown" && r() < 0.3);
    docs.push({
      id: `c${String(i).padStart(2, "0")}`,
      municipalityCode: CODES[i % CODES.length] ?? "13201",
      searchable: r() < 0.8,
      category: CATEGORIES[Math.floor(r() * CATEGORIES.length)] ?? "childcare",
      programId: `p${i % 7}`,
      ageBands: bands.length > 0 ? bands : ["unknown"],
      vector: unit([r() + 0.01, r(), r(), r()]),
    });
  }
  return docs;
})();

const QUERY = unit([1, 0.5, 0.2, 0.1]);
const LIMIT = 5;

function dot(a: readonly number[], b: readonly number[]): number {
  return a.reduce((sum, x, i) => sum + x * (b.at(i) ?? 0), 0);
}

/** フィルタを直接適用して、類似度の高い順に上位 limit 件の id を返す（期待値） */
function bruteForce(match: (d: Doc) => boolean, limit = LIMIT): string[] {
  return DOCS.filter(match)
    .map((d) => ({ id: d.id, s: dot(d.vector, QUERY) }))
    .sort((a, b) => b.s - a.s || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((x) => x.id);
}

async function nearest(query: Query, limit = LIMIT): Promise<string[]> {
  const snap = await query
    .findNearest({
      vectorField: FIELD,
      queryVector: QUERY,
      limit,
      distanceMeasure: "DOT_PRODUCT",
    })
    .get();
  return snap.docs.map((d) => d.id);
}

type Probe = { status: "supported"; ids: string[] } | { status: "rejected"; message: string };

/** 事前フィルタを試し、使えたか（結果）・拒否されたか（エラー）を記録する */
async function probe(name: string, run: () => Promise<string[]>): Promise<Probe> {
  let result: Probe;
  try {
    result = { status: "supported", ids: await run() };
  } catch (error) {
    result = {
      status: "rejected",
      message: error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error),
    };
  }
  // PR の U-1 の確認記録に転記するため、結果を出力する
  console.log(`[U-1] ${name}: ${JSON.stringify(result)}`);
  return result;
}

beforeAll(async () => {
  await resetEmulators();
  const db = adminDb();
  const batch = db.batch();
  for (const d of DOCS) {
    const { id, vector, ageBands, ...rest } = d;
    const flags = Object.fromEntries(
      SOURCE_AGE_BANDS.map((b) => [`band_${b}`, ageBands.includes(b)]),
    );
    batch.set(db.collection("chunks").doc(id), {
      ...rest,
      ...flags,
      ageBands,
      [FIELD]: FieldValue.vector(vector),
    });
  }
  await batch.commit();
});

describe("等価条件だけの事前フィルタ（採用している設計）", () => {
  it("municipalityCode・searchable・band_X・category の等価条件で、直接フィルタと同じ上位件数になる", async () => {
    const db = adminDb();
    for (const code of CODES) {
      for (const band of SOURCE_AGE_BANDS) {
        for (const category of [null, ...CATEGORIES]) {
          let q: Query = db
            .collection("chunks")
            .where("municipalityCode", "==", code)
            .where("searchable", "==", true)
            .where(`band_${band}`, "==", true);
          if (category !== null) q = q.where("category", "==", category);
          const expected = bruteForce(
            (d) =>
              d.municipalityCode === code &&
              d.searchable &&
              d.ageBands.includes(band) &&
              (category === null || d.category === category),
          );
          expect(await nearest(q), `${code}/${band}/${category ?? "-"}`).toEqual(expected);
        }
      }
    }
  });

  it("制度限定（programId・searchable）でも、直接フィルタと同じになる", async () => {
    const db = adminDb();
    for (let p = 0; p < 7; p += 1) {
      const q = db
        .collection("chunks")
        .where("programId", "==", `p${p}`)
        .where("searchable", "==", true);
      expect(await nearest(q)).toEqual(bruteForce((d) => d.programId === `p${p}` && d.searchable));
    }
  });

  it("planSearchQueries → 並列の findNearest → mergeResults が、フィルタを直接適用した結果と一致する（Property 24）", async () => {
    const store = new FirestoreChatVectorStore(adminDb());
    const households: {
      codes: string[];
      bands: SourceAgeBand[] | null;
      category: string | null;
    }[] = [
      { codes: ["00000", "13000", "13201"], bands: ["age_0_2"], category: null },
      {
        codes: ["00000", "13000", "13201"],
        bands: ["pregnancy", "age_3_5"],
        category: "childcare",
      },
      { codes: ["13201"], bands: ["age_6_11", "age_12_14", "age_15_18"], category: null },
      { codes: ["00000", "13000", "13201"], bands: null, category: "medical" },
      {
        codes: ["00000", "13000", "13201"],
        bands: SOURCE_AGE_BANDS.filter((b) => b !== "unknown"),
        category: null,
      },
    ];
    for (const h of households) {
      const queries = planSearchQueries({
        municipalityCodes: h.codes,
        ageBands: h.bands,
        category: h.category,
      });
      const result = await store.search({
        queries,
        embeddingField: FIELD,
        embedding: QUERY,
        minSimilarity: 0,
        limit: LIMIT,
      });
      const bands = h.bands === null ? null : new Set<SourceAgeBand>([...h.bands, "unknown"]);
      const expected = bruteForce(
        (d) =>
          h.codes.includes(d.municipalityCode) &&
          d.searchable &&
          (bands === null || d.ageBands.some((b) => bands.has(b))) &&
          (h.category === null || d.category === h.category),
      );
      expect(
        result.map((r) => r.chunkId),
        JSON.stringify(h),
      ).toEqual(expected);
      // 個々のクエリが返す類似度と、直接計算した内積が一致する
      for (const r of result) {
        const doc = DOCS.find((d) => d.id === r.chunkId);
        expect(r.similarity).toBeCloseTo(dot(doc?.vector ?? [], QUERY), 5);
      }
    }
  });
});

describe("U-1: 等価条件以外の事前フィルタ（Emulator での併用可否の記録）", () => {
  it("in（municipalityCode の3値）", async () => {
    const db = adminDb();
    const result = await probe("in", () =>
      nearest(
        db
          .collection("chunks")
          .where("municipalityCode", "in", [...CODES])
          .where("searchable", "==", true)
          .where("band_age_0_2", "==", true),
      ),
    );
    // 記録（2026-11、cloud-firestore-emulator v1.22.0）: Emulator では使え、結果も直接フィルタと一致した。
    // 失敗した場合は Emulator の挙動が変わったので、U-1 の記録を見直す
    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.ids).toEqual(bruteForce((d) => d.searchable && d.ageBands.includes("age_0_2")));
    }
  });

  it("array-contains（ageBands の配列）", async () => {
    const db = adminDb();
    const result = await probe("array-contains", () =>
      nearest(
        db
          .collection("chunks")
          .where("municipalityCode", "==", "13201")
          .where("searchable", "==", true)
          .where("ageBands", "array-contains", "age_3_5"),
      ),
    );
    // 記録（2026-11、cloud-firestore-emulator v1.22.0）: Emulator では使え、結果も直接フィルタと一致した。
    // 失敗した場合は Emulator の挙動が変わったので、U-1 の記録を見直す
    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.ids).toEqual(
        bruteForce(
          (d) => d.municipalityCode === "13201" && d.searchable && d.ageBands.includes("age_3_5"),
        ),
      );
    }
  });

  it("array-contains-any（ageBands の複数区分）", async () => {
    const db = adminDb();
    const bands: SourceAgeBand[] = ["age_0_2", "age_3_5", "unknown"];
    const result = await probe("array-contains-any", () =>
      nearest(
        db
          .collection("chunks")
          .where("municipalityCode", "==", "13201")
          .where("searchable", "==", true)
          .where("ageBands", "array-contains-any", bands),
      ),
    );
    // 記録（2026-11、cloud-firestore-emulator v1.22.0）: Emulator では使え、結果も直接フィルタと一致した。
    // 失敗した場合は Emulator の挙動が変わったので、U-1 の記録を見直す
    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.ids).toEqual(
        bruteForce(
          (d) =>
            d.municipalityCode === "13201" &&
            d.searchable &&
            d.ageBands.some((b) => bands.includes(b)),
        ),
      );
    }
  });

  it("in と array-contains の併用", async () => {
    const db = adminDb();
    const result = await probe("in + array-contains", () =>
      nearest(
        db
          .collection("chunks")
          .where("municipalityCode", "in", ["13000", "13201"])
          .where("searchable", "==", true)
          .where("ageBands", "array-contains", "age_6_11"),
      ),
    );
    // 記録（2026-11、cloud-firestore-emulator v1.22.0）: Emulator では使え、結果も直接フィルタと一致した。
    // 失敗した場合は Emulator の挙動が変わったので、U-1 の記録を見直す
    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.ids).toEqual(
        bruteForce(
          (d) =>
            ["13000", "13201"].includes(d.municipalityCode) &&
            d.searchable &&
            d.ageBands.includes("age_6_11"),
        ),
      );
    }
  });

  it("or（band_X の等価条件の論理和）", async () => {
    const db = adminDb();
    const result = await probe("or", () =>
      nearest(
        db
          .collection("chunks")
          .where(
            Filter.and(
              Filter.where("municipalityCode", "==", "13201"),
              Filter.where("searchable", "==", true),
              Filter.or(
                Filter.where("band_age_0_2", "==", true),
                Filter.where("band_unknown", "==", true),
              ),
            ),
          ),
      ),
    );
    // 記録（2026-11、cloud-firestore-emulator v1.22.0）: Emulator では使え、結果も直接フィルタと一致した。
    // 失敗した場合は Emulator の挙動が変わったので、U-1 の記録を見直す
    expect(result.status).toBe("supported");
    if (result.status === "supported") {
      expect(result.ids).toEqual(
        bruteForce(
          (d) =>
            d.municipalityCode === "13201" &&
            d.searchable &&
            (d.ageBands.includes("age_0_2") || d.ageBands.includes("unknown")),
        ),
      );
    }
  });
});
