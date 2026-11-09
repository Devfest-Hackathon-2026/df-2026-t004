// 世帯情報・同意・郵便番号・アカウント削除の API（Requirement 2, 8.3〜8.5, 9.1〜9.4, 9.11, 15.2）
// `npm run test:integration` で Firebase Emulator 上で実行する。
import { createLogger, SAMPLE_POSTAL_TABLE, scanLogForLeaks } from "@hachioji-gov/shared";
import { getAuth } from "firebase-admin/auth";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AccountDeleter,
  createApi,
  FirestoreHouseholdStore,
  mountHousehold,
  type AccountAuth,
} from "../src/index.js";
import { CANARIES, CANARY_NOTE } from "./support/canaries.js";
import {
  adminApp,
  adminDb,
  createTestUser,
  emulatorVerifier,
  resetEmulators,
  type TestUser,
} from "./support/emulator.js";

const NOW = new Date("2026-11-09T03:00:00.000Z");

// 撤回の削除を失敗させられる store
class FlakyStore extends FirestoreHouseholdStore {
  failDelete = false;
  protected override async deleteSensitiveProfile(uid: string): Promise<void> {
    if (this.failDelete) throw new Error("injected failure");
    await super.deleteSensitiveProfile(uid);
  }
}

const realAuth: AccountAuth = {
  deleteUser: async (uid) => {
    try {
      await getAuth(adminApp()).deleteUser(uid);
      return "ok";
    } catch (error) {
      if (Reflect.get(error as object, "code") === "auth/user-not-found") return "user-not-found";
      throw error;
    }
  },
};

function setup(auth: AccountAuth = realAuth) {
  const lines: string[] = [];
  const api = createApi({
    config: {
      rateLimit: { perUserPerMinute: 1000, perIpPerMinute: 1000, windowSec: 60, maxEntries: 100 },
    },
    verifier: emulatorVerifier(),
    logger: createLogger({ sink: (line) => lines.push(line) }),
  });
  const store = new FlakyStore(adminDb(), () => NOW);
  const authBox = { current: auth };
  mountHousehold(api, {
    store,
    deleter: new AccountDeleter(
      adminDb(),
      { deleteUser: (uid) => authBox.current.deleteUser(uid) },
      { timeoutMs: 25_000, now: () => NOW },
    ),
    postal: SAMPLE_POSTAL_TABLE,
    now: () => NOW,
  });
  const call = (method: string, path: string, user?: TestUser, body?: unknown) =>
    api.app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(user === undefined ? {} : { Authorization: `Bearer ${user.idToken}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { call, store, lines, authBox };
}

const WITH_CONSENT = {
  postalCode: "192-0083",
  children: [{ ageYears: 0, ageMonths: 5 }, { ageYears: 4 }],
  dueDate: "2027-03-01",
  situationChips: ["disability"],
  freeText: CANARY_NOTE,
  sensitiveConsent: true,
  onboardingDeferred: [],
};

const doc = async (path: string) => (await adminDb().doc(path).get()).data();

let owner: TestUser;
let other: TestUser;

beforeEach(async () => {
  await resetEmulators();
  owner = await createTestUser("owner-uid");
  other = await createTestUser("other-uid");
});

describe("認証", () => {
  it.each([
    ["GET", "/household"],
    ["PUT", "/household"],
    ["POST", "/consents/terms"],
    ["POST", "/consents/sensitive"],
    ["DELETE", "/consents/sensitive"],
    ["GET", "/postal/1920083"],
    ["DELETE", "/account"],
  ])("%s %s は未認証なら 401", async (method, path) => {
    const t = setup();
    const res = await t.call(method, path, undefined, method === "GET" ? undefined : {});
    expect(res.status).toBe(401);
  });
});

describe("世帯情報", () => {
  it("同意ありで保存すると、要配慮情報は sensitive/profile にだけ入り、本人には読める", async () => {
    const t = setup();
    const put = await t.call("PUT", "/household", owner, WITH_CONSENT);
    expect(put.status).toBe(200);
    const view = (await put.json()) as Record<string, unknown>;
    expect(view).toMatchObject({
      postalCode: "1920083",
      municipalityCode: "13201",
      city: "八王子市",
      sensitiveConsent: true,
      sensitive: {
        situationChips: ["disability"],
        childNote: CANARY_NOTE,
        pregnancy: { dueDate: "2027-03-01" },
      },
    });
    expect(view["children"]).toEqual([
      { id: "c1", ageYears: 0, ageMonths: 5, recordedAt: "2026-11-09" },
      { id: "c2", ageYears: 4, recordedAt: "2026-11-09" },
    ]);
    // users/{uid} には要配慮情報を入れない
    const user = JSON.stringify(await doc(`users/${owner.uid}`));
    for (const s of [CANARY_NOTE, "disability", "2027-03-01"]) expect(user).not.toContain(s);
    expect(await doc(`users/${owner.uid}/sensitive/profile`)).toMatchObject({
      situationChips: ["disability"],
    });
    const get = await t.call("GET", "/household", owner);
    expect(await get.json()).toEqual(view);
  });

  it("同意なしで保存すると、要配慮情報はどこにも保存しない", async () => {
    const t = setup();
    const res = await t.call("PUT", "/household", owner, {
      ...WITH_CONSENT,
      sensitiveConsent: false,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sensitiveConsent: false, sensitive: null });
    expect(await doc(`users/${owner.uid}/sensitive/profile`)).toBeUndefined();
    expect(JSON.stringify(await doc(`users/${owner.uid}`))).not.toContain(CANARY_NOTE);
  });

  it("同意ありの後に同意なしで保存し直すと、要配慮情報を消す", async () => {
    const t = setup();
    await t.call("PUT", "/household", owner, WITH_CONSENT);
    await t.call("PUT", "/household", owner, { ...WITH_CONSENT, sensitiveConsent: false });
    expect(await doc(`users/${owner.uid}/sensitive/profile`)).toBeUndefined();
    expect((await doc(`users/${owner.uid}`))?.["consents"]).toEqual({});
  });

  it("入力が不正なら欄ごとのエラーで 400、形が違えば invalid_request", async () => {
    const t = setup();
    const bad = await t.call("PUT", "/household", owner, {
      ...WITH_CONSENT,
      postalCode: "9999999",
      children: [{ ageYears: 30 }],
    });
    expect(bad.status).toBe(400);
    const fields = ((await bad.json()) as { errors: { field: string }[] }).errors.map(
      (e) => e.field,
    );
    expect(fields).toContain("postalCode");
    const shape = await t.call("PUT", "/household", owner, { postalCode: 1 });
    expect(await shape.json()).toEqual({ error: "invalid_request" });
    expect(await doc(`users/${owner.uid}`)).toBeUndefined();
  });

  it("未登録なら 404。他の人の保存は本人のデータを変えない", async () => {
    const t = setup();
    expect((await t.call("GET", "/household", owner)).status).toBe(404);
    await t.call("PUT", "/household", owner, WITH_CONSENT);
    const before = await doc(`users/${owner.uid}`);
    await t.call("PUT", "/household", other, { ...WITH_CONSENT, postalCode: "1000001" });
    await t.call("DELETE", "/consents/sensitive", other);
    expect(await doc(`users/${owner.uid}`)).toEqual(before);
    expect(await doc(`users/${owner.uid}/sensitive/profile`)).toBeDefined();
  });

  it("世帯情報の内容はログに出ない", async () => {
    const t = setup();
    await t.call("PUT", "/household", owner, WITH_CONSENT);
    await t.call("GET", "/household", owner);
    expect(t.lines.length).toBeGreaterThan(0);
    expect(scanLogForLeaks(t.lines.join("\n"), { canaries: CANARIES })).toEqual([]);
  });
});

describe("同意", () => {
  it("利用規約の同意を版と時刻つきで記録する", async () => {
    const t = setup();
    const res = await t.call("POST", "/consents/terms", owner, { version: "2026-11-01" });
    expect(res.status).toBe(204);
    expect((await doc(`users/${owner.uid}`))?.["consents"]).toEqual({
      terms: { version: "2026-11-01", acceptedAt: NOW.toISOString() },
    });
    expect((await t.call("POST", "/consents/terms", owner, { version: "" })).status).toBe(400);
    expect((await t.call("POST", "/consents/other", owner, { version: "v1" })).status).toBe(404);
  });

  it("撤回すると要配慮情報をすぐ消し、読み出せなくなる", async () => {
    const t = setup();
    await t.call("PUT", "/household", owner, WITH_CONSENT);
    const res = await t.call("DELETE", "/consents/sensitive", owner);
    expect(res.status).toBe(204);
    expect(await doc(`users/${owner.uid}/sensitive/profile`)).toBeUndefined();
    const view = (await (await t.call("GET", "/household", owner)).json()) as Record<
      string,
      unknown
    >;
    expect(view).toMatchObject({ sensitiveConsent: false, sensitive: null });
    expect((await doc(`users/${owner.uid}`))?.["sensitiveLocked"]).toBeUndefined();
  });

  it("撤回の削除に失敗したらロックして読み出しを拒否し、再試行で外れる", async () => {
    const t = setup();
    await t.call("PUT", "/household", owner, WITH_CONSENT);
    t.store.failDelete = true;
    const failed = await t.call("DELETE", "/consents/sensitive", owner);
    expect(failed.status).toBe(503);
    // 削除できずに残っていても、読み出さない
    expect(await doc(`users/${owner.uid}/sensitive/profile`)).toBeDefined();
    const view = (await (await t.call("GET", "/household", owner)).json()) as Record<
      string,
      unknown
    >;
    expect(view).toMatchObject({ sensitiveConsent: false, sensitive: null });
    // ロック中は同意し直せない（古い内容が読めてしまうため）
    expect(
      (await t.call("POST", "/consents/sensitive", owner, { version: "2026-11" })).status,
    ).toBe(409);

    t.store.failDelete = false;
    expect((await t.call("DELETE", "/consents/sensitive", owner)).status).toBe(204);
    expect(await doc(`users/${owner.uid}/sensitive/profile`)).toBeUndefined();
    expect((await doc(`users/${owner.uid}`))?.["sensitiveLocked"]).toBeUndefined();
  });
});

describe("郵便番号", () => {
  it("八王子市・市外・見つからない・形式違いを返す", async () => {
    const t = setup();
    const kind = async (code: string) =>
      (
        (await (await t.call("GET", `/postal/${encodeURIComponent(code)}`, owner)).json()) as {
          kind: string;
        }
      ).kind;
    expect(await kind("192-0083")).toBe("hachioji");
    expect(await kind("1000001")).toBe("outside");
    expect(await kind("9999999")).toBe("notFound");
    expect(await kind("abc")).toBe("invalidFormat");
  });
});

describe("アカウント削除", () => {
  async function seed(uid: string) {
    const db = adminDb();
    await Promise.all([
      db.doc(`users/${uid}`).set({ household: { postalCode: "1920083" } }),
      db.doc(`users/${uid}/sensitive/profile`).set({ situationChips: [] }),
      db.doc(`users/${uid}/chats/c1`).set({ answer: "回答" }),
      db.doc(`usageUsers/2026-11-09_${uid}`).set({ uid, count: 1 }),
      db.doc("usage/2026-11-09").set({ count: 2 }),
    ]);
  }

  it("本人のデータと Auth ユーザーだけを消し、他の人のデータは残す", async () => {
    const t = setup();
    await seed(owner.uid);
    await seed(other.uid);
    const res = await t.call("DELETE", "/account", owner);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ state: "done" });
    for (const p of [
      `users/${owner.uid}`,
      `users/${owner.uid}/sensitive/profile`,
      `users/${owner.uid}/chats/c1`,
      `usageUsers/2026-11-09_${owner.uid}`,
    ]) {
      expect(await doc(p)).toBeUndefined();
    }
    for (const p of [
      `users/${other.uid}`,
      `users/${other.uid}/chats/c1`,
      `usageUsers/2026-11-09_${other.uid}`,
      "usage/2026-11-09",
    ]) {
      expect(await doc(p)).toBeDefined();
    }
    await expect(getAuth(adminApp()).getUser(owner.uid)).rejects.toThrow();
    await expect(getAuth(adminApp()).getUser(other.uid)).resolves.toBeDefined();
    expect(await doc(`deletionJobs/${owner.uid}`)).toMatchObject({ state: "done", attempts: 1 });
  });

  it("Auth の削除に失敗したら failed を返し、再試行で完了する（冪等）", async () => {
    const t = setup({
      deleteUser: async () => {
        throw new Error("injected failure");
      },
    });
    await seed(owner.uid);
    const failed = await t.call("DELETE", "/account", owner);
    expect(failed.status).toBe(503);
    expect(await doc(`deletionJobs/${owner.uid}`)).toMatchObject({ state: "failed" });
    await expect(getAuth(adminApp()).getUser(owner.uid)).resolves.toBeDefined();

    t.authBox.current = realAuth;
    expect((await t.call("DELETE", "/account", owner)).status).toBe(200);
    // Auth ユーザーが既に無くても成功として扱う
    const again = new AccountDeleter(adminDb(), realAuth, { timeoutMs: 25_000, now: () => NOW });
    expect(await again.run(owner.uid)).toEqual({ state: "done" });
    expect(await doc(`deletionJobs/${owner.uid}`)).toMatchObject({ state: "done", attempts: 3 });
  });
});
