// Firestore Emulator で、置換の途中の失敗と再実行を確かめる（Requirement 3.3, 3.6, 3.15, 13.13）
// `npm run test:integration` の中で実行する。

import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore, type WriteBatch } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it } from "vitest";
import type { SourceDoc } from "@hachioji-gov/shared";
import {
  FakeEmbedder,
  FakeExtractor,
  FirestoreCollectorStore,
  FirestoreOpsConfigStore,
  FixedClock,
  MemoryFetcher,
  MemoryOps,
  runCollection,
  type CollectorSettings,
  type FetchResult,
} from "../src/index.js";

const PROJECT_ID = "demo-hachioji-gov";
const HTML_URL = "https://www.city.hachioji.tokyo.jp/kosodate/a.html";
const DAY_MS = 25 * 60 * 60 * 1000;
const SETTINGS: CollectorSettings = {
  maxPagesPerRun: 100,
  maxPdfPerSource: 10,
  maxRetries: 0,
  timeoutSec: 30,
  embedding: { model: "gemini-embedding-001", dimensions: 8, version: "v1" },
};

function emulatorHost(): string {
  const host = process.env["FIRESTORE_EMULATOR_HOST"];
  // 実環境に接続しないよう、Emulator の設定が無ければ失敗させる
  if (host === undefined || host === "") {
    throw new Error('FIRESTORE_EMULATOR_HOST is not set. Run via "npm run test:integration".');
  }
  return host;
}

function db(): Firestore {
  emulatorHost();
  return getFirestore(getApps()[0] ?? initializeApp({ projectId: PROJECT_ID }));
}

async function reset(): Promise<void> {
  await fetch(
    `http://${emulatorHost()}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: "DELETE" },
  );
}

const SOURCE: Omit<SourceDoc, "id"> = {
  url: HTML_URL,
  municipalityCode: "13201",
  level: "city",
  format: "html",
  category: "childcare",
  ageBands: ["age_0_2"],
  title: "児童手当",
  relatedSourceId: null,
  intervalHours: 24,
  status: "active",
  missCount: 0,
};

// 見出しごとに1チャンクになるページ
function page(version: string, sections: number): FetchResult {
  const body = Array.from(
    { length: sections },
    (_, i) => `<h2>項目${i}</h2><p>${version}の内容${i}です。</p>`,
  ).join("");
  return {
    kind: "ok",
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: new TextEncoder().encode(`<main>${body}</main>`),
  };
}

type Commit = (batch: WriteBatch) => Promise<unknown>;

function harness(commit?: Commit) {
  const firestore = db();
  const store = new FirestoreCollectorStore(firestore, {
    fieldPrefix: "emb_",
    batchSize: 2,
    ...(commit === undefined ? {} : { commit }),
  });
  return { firestore, store };
}

async function chunkDocs(firestore: Firestore) {
  const snap = await firestore.collection("chunks").get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Record<string, unknown>);
}

// 1回目の取得（v1・3チャンク）をして、運営者が確認して検索対象にした状態を作る
async function seedVerified(clock: FixedClock): Promise<string> {
  const firestore = db();
  await firestore.collection("sources").doc("s1").set(SOURCE);
  const { store } = harness();
  const fetcher = new MemoryFetcher(new Map([[HTML_URL, page("v1", 3)]]));
  await runCollection(
    {
      store,
      fetcher,
      embedder: new FakeEmbedder(),
      extractor: new FakeExtractor({ name: "児童手当" }),
      clock,
      ops: new MemoryOps([{ aiEnabled: true, collectionEnabled: true }]),
    },
    SETTINGS,
  );
  const program = await firestore.collection("programs").doc("s1").get();
  const hash = program.get("contentHash") as string;
  await program.ref.update({
    verified: true,
    verifiedAt: "2026-11-09",
    verifiedBy: "operator-uid",
    verifiedContentHash: hash,
  });
  await store.setSearchable("s1", true);
  return hash;
}

async function runV2(commit: Commit | undefined, clock: FixedClock) {
  const { store } = harness(commit);
  return runCollection(
    {
      store,
      fetcher: new MemoryFetcher(new Map([[HTML_URL, page("v2", 5)]])),
      embedder: new FakeEmbedder(),
      extractor: new FakeExtractor({ name: "児童手当" }),
      clock,
      ops: new MemoryOps([{ aiEnabled: true, collectionEnabled: true }]),
    },
    SETTINGS,
  );
}

describe("FirestoreCollectorStore（Emulator）", () => {
  beforeEach(reset);

  it("チャンクを設計のスキーマで書く（emb_v1 のベクトル、embeddingMeta、絞り込み用の項目）", async () => {
    const clock = new FixedClock(new Date("2026-11-09T00:00:00.000Z"));
    const hash = await seedVerified(clock);
    const docs = await chunkDocs(db());
    expect(docs).toHaveLength(3);
    const snap = await db().collection("chunks").doc(String(docs[0]?.["id"])).get();
    expect(snap.get("emb_v1").toArray()).toHaveLength(8);
    expect(snap.get("embeddingMeta")).toEqual({
      v1: { model: "gemini-embedding-001", dimensions: 8, createdAt: "2026-11-09T00:00:00.000Z" },
    });
    expect(snap.data()).toMatchObject({
      programId: "s1",
      sourceId: "s1",
      contentHash: hash,
      municipalityCode: "13201",
      level: "city",
      category: "childcare",
      band_age_0_2: true,
      band_unknown: false,
      searchable: true,
    });
    expect(snap.get("embedding")).toBeUndefined();
    expect(snap.get("id")).toBeUndefined();
  });

  it("置換のどこで失敗しても、検索対象に旧版と新版が混ざらない。再実行で完了し、結果は同じになる", async () => {
    // 成功時のバッチの確定回数を数える
    const clock = new FixedClock(new Date("2026-11-09T00:00:00.000Z"));
    await seedVerified(clock);
    let total = 0;
    clock.time = new Date(clock.time.getTime() + DAY_MS);
    await runV2(async (batch) => {
      total += 1;
      return batch.commit();
    }, clock);
    const expected = (await chunkDocs(db())).map((d) => d["id"]).sort();
    expect(expected).toHaveLength(5);
    expect(total).toBeGreaterThan(2);

    for (let failAt = 1; failAt <= total; failAt++) {
      await reset();
      const c = new FixedClock(new Date("2026-11-09T00:00:00.000Z"));
      const oldHash = await seedVerified(c);
      c.time = new Date(c.time.getTime() + DAY_MS);
      let n = 0;
      const summary = await runV2(async (batch) => {
        n += 1;
        if (n === failAt) throw new Error("injected commit failure");
        return batch.commit();
      }, c);
      expect(summary.errors).toBe(1);

      // 検索対象に残りうるのは旧版だけ（新版は混ざらない）。要再確認になっていれば何も残らない
      const searchable = await db().collection("chunks").where("searchable", "==", true).get();
      for (const d of searchable.docs) expect(d.get("contentHash")).toBe(oldHash);
      const program = await db().collection("programs").doc("s1").get();
      if (program.get("needsReview") === true) expect(searchable.size).toBe(0);

      // 再実行で完了し、成功時と同じチャンクの集合になる
      c.time = new Date(c.time.getTime() + DAY_MS);
      expect(await runV2(undefined, c)).toMatchObject({ replaced: 1, errors: 0 });
      const after = await chunkDocs(db());
      expect(after.map((d) => d["id"]).sort()).toEqual(expected);
      expect(after.every((d) => d["searchable"] === false)).toBe(true);
    }
  });

  it("同じ内容で何度実行しても結果は変わらない（冪等）", async () => {
    const clock = new FixedClock(new Date("2026-11-09T00:00:00.000Z"));
    await seedVerified(clock);
    clock.time = new Date(clock.time.getTime() + DAY_MS);
    await runV2(undefined, clock);
    const first = await chunkDocs(db());
    // ハッシュを消して、同じ内容をもう一度置き換えさせる
    await db().collection("sources").doc("s1").update({ lastHash: "x" });
    clock.time = new Date(clock.time.getTime() + DAY_MS);
    await runV2(undefined, clock);
    const second = await chunkDocs(db());
    // 取得日時は実行ごとに変わるので除いて比べる
    const strip = (docs: Record<string, unknown>[]) =>
      docs
        .map((d) => ({
          id: String(d["id"]),
          excerpt: d["excerpt"],
          contentHash: d["contentHash"],
          searchable: d["searchable"],
          vector: (d["emb_v1"] as { toArray(): number[] }).toArray(),
        }))
        .sort((a, b) => a.id.localeCompare(b.id));
    expect(strip(second)).toEqual(strip(first));
  });

  it("除外すると、制度とそのすべてのチャンクを検索対象から外す", async () => {
    const clock = new FixedClock(new Date("2026-11-09T00:00:00.000Z"));
    await seedVerified(clock);
    await harness().store.markExcluded("s1");
    const searchable = await db().collection("chunks").where("searchable", "==", true).get();
    expect(searchable.size).toBe(0);
    expect((await db().collection("programs").doc("s1").get()).get("status")).toBe("excluded");
    expect((await db().collection("sources").doc("s1").get()).get("status")).toBe("excluded");
  });

  it("運営スイッチを読む。文書が無ければ例外（停止として扱う）", async () => {
    const ops = new FirestoreOpsConfigStore(db());
    await expect(ops.read()).rejects.toThrow();
    await db()
      .collection("config")
      .doc("operations")
      .set({ aiEnabled: true, collectionEnabled: false });
    expect(await ops.read()).toEqual({ aiEnabled: true, collectionEnabled: false });
  });
});
