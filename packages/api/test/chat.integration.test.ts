// チャットの Firestore 実装（Requirement 4.7, 5.1, 5.14）
// `npm run test:integration` で Firebase Emulator 上で実行する。
import { FieldValue } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it } from "vitest";
import {
  FirestoreChatStore,
  FirestoreChatVectorStore,
  FirestoreHouseholdReader,
} from "../src/index.js";
import { adminDb, resetEmulators } from "./support/emulator.js";

beforeEach(resetEmulators);

function chunk(id: string, vector: number[], extra: Record<string, unknown> = {}) {
  return adminDb()
    .collection("chunks")
    .doc(id)
    .set({
      programId: "city-jido-teate",
      municipalityCode: "13201",
      searchable: true,
      excerpt: `抜粋 ${id}`,
      sourceUrl: "https://kosodate.city.hachioji.tokyo.jp/x.html",
      fetchedAt: "2026-11-09T00:00:00.000Z",
      emb_v1: FieldValue.vector(vector),
      ...extra,
    });
}

describe("FirestoreChatVectorStore", () => {
  it("条件に合う検索可能なチャンクを、類似度のしきい値以上だけ近い順に返す", async () => {
    await Promise.all([
      chunk("a", [1, 0, 0], { heading: "見出しA", pdfPage: 2 }),
      chunk("b", [0.8, 0.6, 0]),
      chunk("c", [0, 1, 0]),
      chunk("d", [1, 0, 0], { searchable: false }),
      chunk("e", [1, 0, 0], { municipalityCode: "13202" }),
    ]);
    const store = new FirestoreChatVectorStore(adminDb());
    const result = await store.search({
      queries: [{ municipalityCode: "13201", searchable: true }],
      embeddingField: "emb_v1",
      embedding: [1, 0, 0],
      minSimilarity: 0.5,
      limit: 8,
    });
    expect(result.map((r) => r.chunkId)).toEqual(["a", "b"]);
    expect(result[0]).toMatchObject({
      similarity: 1,
      programId: "city-jido-teate",
      heading: "見出しA",
      pdfPage: 2,
    });
    expect(result[1]?.similarity).toBeCloseTo(0.8);
  });

  it("フィールド名として不正な値は拒否する", async () => {
    const store = new FirestoreChatVectorStore(adminDb());
    await expect(
      store.search({
        queries: [],
        embeddingField: "emb_v1.x",
        embedding: [1],
        minSimilarity: 0,
        limit: 1,
      }),
    ).rejects.toThrow(RangeError);
  });
});

describe("FirestoreChatStore", () => {
  it("履歴を保存し、新しい順に読み出す", async () => {
    const store = new FirestoreChatStore(adminDb(), "v1");
    const base = {
      answer: "回答[1]",
      sources: [{ n: 1, title: "児童手当", url: "https://example.com/" }],
    };
    await store.saveChat("u1", {
      ...base,
      question: "1つ目",
      createdAt: "2026-11-09T01:00:00.000Z",
    });
    await store.saveChat("u1", {
      ...base,
      question: "2つ目",
      createdAt: "2026-11-09T02:00:00.000Z",
    });
    await store.saveChat("u2", {
      ...base,
      question: "他人",
      createdAt: "2026-11-09T03:00:00.000Z",
    });
    const list = await store.listChats("u1", 20);
    expect(list.map((c) => c.question)).toEqual(["2つ目", "1つ目"]);
    expect(list[0]?.id).toEqual(expect.any(String));
  });

  it.each([
    ["削除ジョブが running", { job: "running" }],
    ["削除ジョブが failed", { job: "failed" }],
    ["削除ジョブが done", { job: "done" }],
    ["users/{uid}.deleting", { deleting: true }],
  ])("%s なら保存せず null を返す", async (_label, mark) => {
    const db = adminDb();
    if ("job" in mark) await db.doc("deletionJobs/u1").set({ state: mark.job });
    if ("deleting" in mark) await db.doc("users/u1").set({ deleting: true });
    const store = new FirestoreChatStore(db, "v1");
    const id = await store.saveChat("u1", {
      question: "質問",
      answer: "回答[1]",
      sources: [],
      createdAt: "2026-11-09T01:00:00.000Z",
    });
    expect(id).toBeNull();
    expect((await db.collection("users/u1/chats").get()).size).toBe(0);
    // 他の人は保存できる
    expect(
      await store.saveChat("u2", {
        question: "質問",
        answer: "回答[1]",
        sources: [],
        createdAt: "2026-11-09T01:00:00.000Z",
      }),
    ).toEqual(expect.any(String));
  });

  it("検索の版は config/embedding から読み、無ければ既定の版", async () => {
    const db = adminDb();
    const store = new FirestoreChatStore(db, "v1");
    expect(await store.searchVersion()).toBe("v1");
    await db.doc("config/embedding").set({ searchVersion: "v2" });
    expect(await store.searchVersion()).toBe("v2");
  });

  it("制度名をまとめて引き、無い制度は省く", async () => {
    const db = adminDb();
    await db.doc("programs/p1").set({ name: "児童手当" });
    const names = await new FirestoreChatStore(db, "v1").programNames(["p1", "missing"]);
    expect([...names]).toEqual([["p1", "児童手当"]]);
  });
});

describe("FirestoreHouseholdReader", () => {
  it("自治体と子どもの推定年齢の区分、同意のある出産予定日から妊娠中を読む", async () => {
    const db = adminDb();
    await db.doc("users/u1").set({
      household: {
        municipalityCode: "13201",
        children: [
          { id: "c1", ageYears: 1, recordedAt: "2026-11-01" },
          { id: "c2", ageYears: 7, recordedAt: "2026-11-01" },
        ],
      },
      consents: { sensitive: { version: "2026-11", grantedAt: "2026-11-01T00:00:00.000Z" } },
    });
    await db.doc("users/u1/sensitive/profile").set({
      situationChips: [],
      pregnancy: { dueDate: "2027-03-01" },
    });
    const reader = new FirestoreHouseholdReader(db, () => new Date("2026-11-09T03:00:00.000Z"));
    const got = await reader.read("u1");
    expect(got?.municipalityCode).toBe("13201");
    expect(got?.ageBands).toEqual(["pregnancy", "age_0_2", "age_6_11"]);

    // 要配慮情報がロックされていれば使わない
    await db.doc("users/u1").set({ sensitiveLocked: true }, { merge: true });
    expect((await reader.read("u1"))?.ageBands).toEqual(["age_0_2", "age_6_11"]);
    expect(await reader.read("nobody")).toBeNull();
  });
});
