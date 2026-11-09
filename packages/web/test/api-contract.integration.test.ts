// 画面の API クライアント（createHttp*Api）と、本物の API（packages/api）の形が合っていることを確かめる。
// `npm run test:integration` で Firebase Emulator 上で実行する。
// 画面は /api/** を呼び、Hosting のリライトで API に届く。ここでは /api を取り除いて API に渡す。
import { encodeProgram, SAMPLE_POSTAL_TABLE, type Program } from "@hachioji-gov/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AccountDeleter,
  createApi,
  FirestoreAccountStatus,
  FirestoreHouseholdStore,
  FirestoreProgramStore,
  FirestoreUserRecords,
  mountDashboard,
  mountHousehold,
} from "../../api/src/index.js";
import {
  adminDb,
  createTestUser,
  emulatorVerifier,
  resetEmulators,
  type TestUser,
} from "../../api/test/support/emulator.js";
import { createHttpAccountApi } from "../src/services/accountApi";
import { createHttpDashboardApi } from "../src/services/dashboardApi";
import { createHttpHouseholdApi } from "../src/services/householdApi";
import { toMatchHousehold } from "../src/state/household";

const NOW = new Date("2026-11-09T03:00:00.000Z");
const TODAY = "2026-11-09";
const HASH = "0".repeat(64);

const PROGRAM: Program = {
  id: "city-baby",
  sourceId: "city-baby",
  name: "乳幼児の医療費助成",
  level: "city",
  municipalityCode: "13201",
  category: "medical",
  ageBands: ["age_0_2"],
  summary: "概要",
  eligibility: null,
  procedure: null,
  requiredDocs: ["申請書", "保険証"],
  deadline: "2026-12-31",
  contact: { name: "子ども家庭部" },
  sourceName: "八王子市",
  sourceUrl: "https://www.city.hachioji.tokyo.jp/",
  fetchedAt: "2026-11-01T00:00:00.000Z",
  verified: true,
  verifiedAt: "2026-11-02",
  verifiedBy: "operator-uid",
  verifiedContentHash: HASH,
  contentHash: HASH,
  needsReview: false,
  status: "active",
  updatedAt: "2026-11-02T00:00:00.000Z",
};

let user: TestUser;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  await resetEmulators();
  user = await createTestUser("web-contract-uid");
  await adminDb().doc(`programs/${PROGRAM.id}`).set(encodeProgram(PROGRAM));

  const db = adminDb();
  const api = createApi({
    config: {
      rateLimit: { perUserPerMinute: 1000, perIpPerMinute: 1000, windowSec: 60, maxEntries: 100 },
    },
    verifier: emulatorVerifier(),
    accountStatus: new FirestoreAccountStatus(db),
  });
  const household = new FirestoreHouseholdStore(db, () => NOW);
  mountHousehold(api, {
    store: household,
    deleter: new AccountDeleter(db, { deleteUser: async () => "ok" }),
    postal: SAMPLE_POSTAL_TABLE,
    now: () => NOW,
  });
  mountDashboard(api, {
    household,
    programs: new FirestoreProgramStore(db),
    records: new FirestoreUserRecords(db),
    now: () => NOW,
  });
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("/api/")) return realFetch(input, init);
    return api.app.request(url.slice("/api".length), init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const token = () => Promise.resolve(user.idToken);

describe("世帯の API", () => {
  it("未登録は null、保存すると同じ形で読み戻せる", async () => {
    const households = createHttpHouseholdApi(token);
    expect(await households.getHousehold()).toBeNull();
    expect(await households.lookupPostal("192-0083")).toMatchObject({ kind: "hachioji" });

    const saved = await households.saveHousehold(
      {
        postalCode: "1920083",
        children: [{ ageYears: 0, ageMonths: 6 }],
        situationChips: ["disability"],
        sensitiveConsent: true,
        onboardingDeferred: ["dueDate"],
      },
      TODAY,
    );
    expect(saved.ok).toBe(true);
    const read = await households.getHousehold();
    expect(read).toMatchObject({
      municipalityCode: "13201",
      children: [{ ageYears: 0, ageMonths: 6 }],
      onboardingDeferred: ["dueDate"],
      sensitiveConsent: true,
      sensitive: { situationChips: ["disability"] },
    });
    await expect(households.recordTermsConsent("2026-11-draft1")).resolves.toBeUndefined();
  });

  it("入力の誤りは入力欄ごとのエラーとして返る", async () => {
    const r = await createHttpHouseholdApi(token).saveHousehold(
      {
        postalCode: "12",
        children: [{ ageYears: 1 }],
        sensitiveConsent: false,
        onboardingDeferred: [],
      },
      TODAY,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => e.field === "postalCode")).toBe(true);
  });
});

describe("ダッシュボードと申請の API", () => {
  it("候補・制度詳細・申請の進行を読み書きできる", async () => {
    const households = createHttpHouseholdApi(token);
    const dashboard = createHttpDashboardApi(token);
    const saved = await households.saveHousehold(
      {
        postalCode: "1920083",
        children: [{ ageYears: 1 }],
        sensitiveConsent: false,
        onboardingDeferred: [],
      },
      TODAY,
    );
    if (!saved.ok) throw new Error("household not saved");

    const d = await dashboard.getDashboard(toMatchHousehold(saved.household, TODAY), TODAY, null);
    expect(d.programs.ok).toBe(true);
    if (d.programs.ok) expect(d.programs.data.map((m) => m.program.id)).toEqual(["city-baby"]);
    expect(d.applications).toEqual({ ok: true, data: [] });

    const detail = await dashboard.getProgram("city-baby");
    expect(detail.status).toBe("ok");
    if (detail.status === "ok") {
      expect(detail.data.name).toBe(PROGRAM.name);
      expect(detail.cachedAt).toBe(NOW.toISOString());
    }
    expect((await dashboard.getProgram("missing")).status).toBe("not-found");

    expect(await dashboard.getApplication("city-baby")).toBeNull();
    const a = await dashboard.updateApplication("city-baby", {
      status: "in_progress",
      tasks: [{ id: "t1", label: "申請書", done: true }],
    });
    expect(a).toMatchObject({ programId: "city-baby", deadline: "2026-12-31" });
    expect(await dashboard.getApplication("city-baby")).toEqual(a);
  });
});

describe("医療費・同意撤回・アカウント削除の API", () => {
  it("記録・集計・修正・削除ができ、誤りは入力欄ごとに返る", async () => {
    const households = createHttpHouseholdApi(token);
    const account = createHttpAccountApi(token);
    const saved = await households.saveHousehold(
      {
        postalCode: "1920083",
        children: [{ ageYears: 1 }],
        sensitiveConsent: false,
        onboardingDeferred: [],
      },
      TODAY,
    );
    if (!saved.ok) throw new Error("household not saved");
    const subjectIds = saved.household.children.map((c) => c.id);
    const childId = subjectIds[0] ?? "c1";

    const created = await account.saveExpense(
      { date: "2026-11-01", facility: "八王子こども医院", amountYen: 1200, subjectId: childId },
      TODAY,
      subjectIds,
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const bad = await account.saveExpense(
      { date: "2026-11-01", facility: "", amountYen: -1, subjectId: childId },
      TODAY,
      subjectIds,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.length).toBeGreaterThan(0);

    const overview = await account.getExpenses(toMatchHousehold(saved.household, TODAY), TODAY);
    expect(overview.records.map((r) => r.id)).toEqual([created.record.id]);
    expect(overview.summary.totalYen).toBe(1200);

    const edited = await account.saveExpense(
      { date: "2026-11-02", facility: "八王子こども医院", amountYen: 800, subjectId: childId },
      TODAY,
      subjectIds,
      created.record.id,
    );
    expect(edited).toMatchObject({ ok: true, record: { id: created.record.id, amountYen: 800 } });
    await account.deleteExpense(created.record.id);
    expect(
      (await account.getExpenses(toMatchHousehold(saved.household, TODAY), TODAY)).records,
    ).toEqual([]);
  });

  it("同意を撤回すると要配慮情報が読めなくなり、アカウントを削除できる", async () => {
    const households = createHttpHouseholdApi(token);
    const account = createHttpAccountApi(token);
    await households.saveHousehold(
      {
        postalCode: "1920083",
        children: [{ ageYears: 1 }],
        situationChips: ["disability"],
        sensitiveConsent: true,
        onboardingDeferred: [],
      },
      TODAY,
    );
    await account.withdrawSensitiveConsent();
    expect(await households.getHousehold()).toMatchObject({
      sensitiveConsent: false,
      sensitive: null,
    });
    await account.deleteAccount();
    expect((await adminDb().doc("users/web-contract-uid").get()).exists).toBe(false);
  });
});
