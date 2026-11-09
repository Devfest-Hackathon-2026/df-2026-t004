// 日次上限のトランザクション（Requirement 13.8, 13.9, 13.12）
// `npm run test:integration` で Firebase Emulator 上で実行する。
import { Timestamp } from "firebase-admin/firestore";
import { beforeEach, describe, expect, it } from "vitest";
import { FirestoreOpsConfigStore, FirestoreUsageStore } from "../src/index.js";
import { adminDb, resetEmulators } from "./support/emulator.js";

beforeEach(resetEmulators);

describe("FirestoreUsageStore", () => {
  it("同時に送られても、ユーザー別と全体の上限を超えて受け付けない", async () => {
    const store = new FirestoreUsageStore(adminDb());
    const limits = { perUserPerDay: 3, globalPerDay: 5 };
    const uids = ["u1", "u1", "u1", "u1", "u2", "u2", "u3", "u3", "u3"];
    const results = await Promise.all(uids.map((u) => store.reserve(u, "2026-11-09", limits)));
    const accepted = results.filter((r) => r.ok).length;
    expect(accepted).toBe(5);
    const perUser = new Map<string, number>();
    uids.forEach((u, i) => {
      if (results.at(i)?.ok === true) perUser.set(u, (perUser.get(u) ?? 0) + 1);
    });
    for (const n of perUser.values()) expect(n).toBeLessThanOrEqual(3);

    // 保存された回数は受け付けた数と一致する
    const db = adminDb();
    const global = await db.collection("usage").doc("2026-11-09").get();
    expect(global.get("count")).toBe(5);
    for (const [u, n] of perUser) {
      const doc = await db.collection("usageUsers").doc(`2026-11-09_${u}`).get();
      expect(doc.get("count")).toBe(n);
      expect(doc.get("expireAt")).toBeInstanceOf(Timestamp);
    }
    expect(global.get("expireAt")).toBeInstanceOf(Timestamp);
    // Emulator は同じドキュメントへの同時のトランザクションを順に待たせるため時間がかかる
  }, 60_000);

  it("拒否したときは回数を増やさない", async () => {
    const store = new FirestoreUsageStore(adminDb());
    const limits = { perUserPerDay: 1, globalPerDay: 10 };
    expect(await store.reserve("u1", "2026-11-09", limits)).toMatchObject({ ok: true });
    expect(await store.reserve("u1", "2026-11-09", limits)).toEqual({
      ok: false,
      reason: "quota_user",
    });
    const global = await adminDb().collection("usage").doc("2026-11-09").get();
    expect(global.get("count")).toBe(1);
  });

  it("uid にスラッシュを含むときは例外（別のドキュメントを指さない）", async () => {
    const store = new FirestoreUsageStore(adminDb());
    await expect(
      store.reserve("a/b", "2026-11-09", { perUserPerDay: 1, globalPerDay: 1 }),
    ).rejects.toThrow(RangeError);
  });
});

describe("FirestoreOpsConfigStore", () => {
  it("config/operations を読む。無ければ例外", async () => {
    const ops = new FirestoreOpsConfigStore(adminDb());
    await expect(ops.read()).rejects.toThrow();
    await adminDb()
      .collection("config")
      .doc("operations")
      .set({ aiEnabled: false, collectionEnabled: true, updatedAt: "x", updatedBy: "y" });
    expect(await ops.read()).toEqual({ aiEnabled: false, collectionEnabled: true });
  });
});
