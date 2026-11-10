import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  chunkSource,
  planSearchQueries,
  SOURCE_AGE_BANDS,
  SOURCE_CATEGORIES,
} from "@hachioji-gov/shared";
import {
  buildIndexesFile,
  embeddingField,
  embeddingSettingsFrom,
  equalityFieldSets,
  formatIndexesFile,
  INDEXES_PATH,
  readEmbeddingSettings,
  TTL_COLLECTIONS,
  VECTOR_INDEXES_PER_VERSION,
  vectorIndexes,
} from "./gen-indexes.js";

const SETTINGS = { fieldPrefix: "emb_", version: "v1", dimensions: 768 };

/** インデックスのうち、ベクトル以外（等価条件）のフィールド名の集合を、比較しやすい文字列にする */
function keyOf(fields: Iterable<string>): string {
  return [...fields].sort().join(",");
}

describe("vectorIndexes", () => {
  const indexes = vectorIndexes(SETTINGS);

  it("1つの埋め込み版あたり17本で、構成はすべて異なる", () => {
    expect(indexes).toHaveLength(VECTOR_INDEXES_PER_VERSION);
    const keys = new Set(indexes.map((i) => keyOf(i.fields.map((f) => f.fieldPath))));
    expect(keys.size).toBe(VECTOR_INDEXES_PER_VERSION);
  });

  it("すべて chunks のコレクションで、等価条件 → ベクトル（末尾・1つ）の順になる", () => {
    for (const index of indexes) {
      expect(index.collectionGroup).toBe("chunks");
      expect(index.queryScope).toBe("COLLECTION");
      const last = index.fields.at(-1);
      expect(last).toEqual({
        fieldPath: "emb_v1",
        vectorConfig: { dimension: 768, flat: {} },
      });
      for (const f of index.fields.slice(0, -1)) {
        expect(f).toEqual({ fieldPath: f.fieldPath, order: "ASCENDING" });
      }
    }
  });

  it("設計書の内訳（区分あり7・同カテゴリ7・区分なし1・同カテゴリ1・制度限定1）と一致する", () => {
    const sets = equalityFieldSets();
    const has = (name: string) => sets.filter((s) => s.includes(name)).length;
    expect(sets.filter((s) => s.some((f) => f.startsWith("band_")))).toHaveLength(14);
    expect(has("category")).toBe(8);
    expect(has("programId")).toBe(1);
    expect(sets.filter((s) => s.length === 2 && s.includes("municipalityCode"))).toHaveLength(1);
    for (const band of SOURCE_AGE_BANDS) {
      expect(has(`band_${band}`)).toBe(2);
    }
  });

  it("設定の接頭辞・版・次元がそのまま反映される", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-z][a-z0-9_]{0,10}$/),
        fc.stringMatching(/^[A-Za-z0-9_]{1,10}$/),
        fc.integer({ min: 1, max: 2048 }),
        (fieldPrefix, version, dimensions) => {
          const out = vectorIndexes({ fieldPrefix, version, dimensions });
          expect(out).toHaveLength(VECTOR_INDEXES_PER_VERSION);
          for (const index of out) {
            expect(index.fields.at(-1)).toEqual({
              fieldPath: `${fieldPrefix}${version}`,
              vectorConfig: { dimension: dimensions, flat: {} },
            });
          }
        },
      ),
    );
  });

  it.each([0, -1, 1.5, 2049])("次元 %s は拒否する", (dimensions) => {
    expect(() => vectorIndexes({ ...SETTINGS, dimensions })).toThrow(RangeError);
  });

  it("API が受け付けないフィールド名（- を含む版など）は拒否する", () => {
    expect(() => embeddingField({ ...SETTINGS, version: "v-2" })).toThrow(RangeError);
    expect(() => embeddingField({ ...SETTINGS, fieldPrefix: "1emb_" })).toThrow(RangeError);
    expect(embeddingField(SETTINGS)).toBe("emb_v1");
  });
});

describe("検索クエリ・collector の書き込みとの突き合わせ", () => {
  const indexKeys = new Set(equalityFieldSets().map((s) => keyOf(s)));

  it("planSearchQueries が作るどの等価条件のクエリにも、対応するインデックスがある", () => {
    const code = fc.constantFrom("00000", "13000", "13201");
    const household = fc.record({
      municipalityCodes: fc.uniqueArray(code, { minLength: 1, maxLength: 3 }),
      ageBands: fc.option(fc.uniqueArray(fc.constantFrom(...SOURCE_AGE_BANDS)), {
        nil: null,
      }),
      category: fc.option(fc.constantFrom(...SOURCE_CATEGORIES), { nil: null }),
    });
    const program = fc.record({ programId: fc.stringMatching(/^[a-z0-9-]{1,20}$/) });
    fc.assert(
      fc.property(fc.oneof(household, program), (input) => {
        for (const q of planSearchQueries(input)) {
          expect(indexKeys.has(keyOf(Object.keys(q)))).toBe(true);
        }
      }),
    );
  });

  it("collector が書き込むチャンクは、インデックスの等価条件のフィールドをすべて持つ", () => {
    const [chunk] = chunkSource([{ text: "児童手当の案内です。" }], {
      programId: "p1",
      sourceId: "s1",
      sourceUrl: "https://example.jp/a.html",
      fetchedAt: "2026-04-01T00:00:00.000Z",
      contentHash: "h",
      municipalityCode: "13201",
      level: "city",
      category: "childcare",
      ageBands: ["age_0_2"],
    });
    expect(chunk).toBeDefined();
    const written = new Set(Object.keys(chunk ?? {}));
    for (const set of equalityFieldSets()) {
      for (const field of set) expect(written.has(field), field).toBe(true);
    }
  });
});

describe("buildIndexesFile", () => {
  it("usage / usageUsers / deletionJobs の expireAt に TTL を付け、単一フィールドのインデックスを外す", () => {
    const file = buildIndexesFile(SETTINGS);
    expect(file.fieldOverrides).toEqual(
      TTL_COLLECTIONS.map((collectionGroup) => ({
        collectionGroup,
        fieldPath: "expireAt",
        ttl: true,
        indexes: [],
      })),
    );
  });

  it("firebase-tools（firebase deploy）のインデックス定義の検証に通る", () => {
    // firebase deploy --only firestore:indexes が使う検証と同じもの（デプロイはしない）
    const require = createRequire(import.meta.url);
    const { FirestoreApi } = require("firebase-tools/lib/firestore/api.js") as {
      FirestoreApi: new () => { validateSpec(spec: unknown): void };
    };
    expect(() => new FirestoreApi().validateSpec(buildIndexesFile(SETTINGS))).not.toThrow();
    // 検証が実際に効いていること（vectorConfig に flat が無い定義は拒否される）
    const broken = buildIndexesFile(SETTINGS);
    broken.indexes[0]?.fields.push({ fieldPath: "x", vectorConfig: {} } as never);
    expect(() => new FirestoreApi().validateSpec(broken)).toThrow();
    // firebase-tools の読み込みに時間がかかるため、タイムアウトを長くする
  }, 60_000);

  it("コミット済みの firestore.indexes.json は、設定から再生成したものと一致する", async () => {
    const expected = await formatIndexesFile(buildIndexesFile(await readEmbeddingSettings()));
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- リポジトリ内の固定パス
    const committed = (await readFile(INDEXES_PATH, "utf-8")).replace(/\r\n/g, "\n");
    expect(committed).toBe(expected);
  });
});

describe("embeddingSettingsFrom", () => {
  it("app.config.json の embedding から接頭辞・版・次元を取り出す", () => {
    expect(
      embeddingSettingsFrom({
        embedding: { model: "m", dimensions: 768, version: "v1", fieldPrefix: "emb_" },
      }),
    ).toEqual(SETTINGS);
  });

  it.each([
    [{}, "embedding"],
    [{ embedding: { model: "m", version: "v1", fieldPrefix: "emb_" } }, "embedding.dimensions"],
    [{ embedding: { model: "m", dimensions: 768, version: "", fieldPrefix: "emb_" } }, "version"],
    [{ embedding: { model: "m", dimensions: -1, version: "v1", fieldPrefix: "e" } }, "dimensions"],
  ])("不正な設定は、キー名つきで拒否する (%j)", (raw, key) => {
    expect(() => embeddingSettingsFrom(raw)).toThrow(key);
  });
});
