// ダッシュボード・制度・申請・医療費の API（Requirement 4, 6, 12.4, 15.2）
// `npm run test:integration` で Firebase Emulator 上で実行する。
import {
  createLogger,
  encodeProgram,
  SAMPLE_POSTAL_TABLE,
  scanLogForLeaks,
  type Program,
} from "@hachioji-gov/shared";
import { beforeEach, describe, expect, it } from "vitest";
import {
  AccountDeleter,
  createApi,
  FirestoreAccountStatus,
  FirestoreHouseholdStore,
  FirestoreProgramStore,
  FirestoreUserRecords,
  mountDashboard,
  mountHousehold,
} from "../src/index.js";
import { CANARIES, CANARY_NOTE } from "./support/canaries.js";
import {
  adminDb,
  createTestUser,
  emulatorVerifier,
  resetEmulators,
  type TestUser,
} from "./support/emulator.js";

const NOW = new Date("2026-11-09T03:00:00.000Z");
const HASH = "0".repeat(64);

function program(id: string, over: Partial<Program> = {}): Program {
  return {
    id,
    sourceId: id,
    name: `制度 ${id}`,
    level: "city",
    municipalityCode: "13201",
    category: "childcare",
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
    ...over,
  };
}

const PROGRAMS: Program[] = [
  program("city-baby"),
  program("city-school", { ageBands: ["age_6_11"] }),
  program("city-unknown", { ageBands: ["unknown"] }),
  program("city-closed", { deadline: "2026-10-01" }),
  program("city-unverified", { verified: false }),
  program("city-review", { needsReview: true }),
  program("city-excluded", { status: "excluded" }),
  program("national-baby", { level: "national", municipalityCode: "00000" }),
  program("other-city", { municipalityCode: "13101" }),
  program("city-medical", { category: "medical", requiredDocs: ["領収書", "申請書"] }),
];

function setup() {
  const lines: string[] = [];
  const db = adminDb();
  const api = createApi({
    config: {
      rateLimit: { perUserPerMinute: 1000, perIpPerMinute: 1000, windowSec: 60, maxEntries: 100 },
    },
    verifier: emulatorVerifier(),
    accountStatus: new FirestoreAccountStatus(db),
    logger: createLogger({ sink: (line) => lines.push(line) }),
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
  const call = (method: string, path: string, user?: TestUser, body?: unknown) =>
    api.app.request(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(user === undefined ? {} : { Authorization: `Bearer ${user.idToken}` }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { call, lines };
}

const HOUSEHOLD = {
  postalCode: "1920083",
  children: [{ ageYears: 1 }],
  sensitiveConsent: false,
  onboardingDeferred: [],
};

const doc = async (path: string) => (await adminDb().doc(path).get()).data();
const json = async (res: Response) => (await res.json()) as Record<string, unknown>;

let owner: TestUser;
let other: TestUser;

beforeEach(async () => {
  await resetEmulators();
  owner = await createTestUser("owner-uid");
  other = await createTestUser("other-uid");
  const db = adminDb();
  await Promise.all(PROGRAMS.map((p) => db.doc(`programs/${p.id}`).set(encodeProgram(p))));
  // 形の崩れた制度は読み捨てる
  await db.doc("programs/broken").set({ name: "壊れた制度", municipalityCode: "13201" });
});

describe("認証", () => {
  it.each([
    ["GET", "/dashboard"],
    ["GET", "/programs/city-baby"],
    ["GET", "/applications/city-baby"],
    ["PUT", "/applications/city-baby"],
    ["POST", "/expenses"],
    ["PUT", "/expenses/e1"],
    ["DELETE", "/expenses/e1"],
    ["GET", "/expenses/summary"],
  ])("%s %s は未認証なら 401", async (method, path) => {
    const res = await setup().call(method, path, undefined, method === "GET" ? undefined : {});
    expect(res.status).toBe(401);
  });
});

describe("GET /dashboard", () => {
  it("世帯の自治体と年齢区分に合う、確認済みの制度だけを返す", async () => {
    const t = setup();
    await t.call("PUT", "/household", owner, HOUSEHOLD);
    const body = await json(await t.call("GET", "/dashboard", owner));
    const programs = body["programs"] as {
      ok: boolean;
      data: { program: Program; needsCheck: boolean; maybeClosed: boolean }[];
    };
    expect(programs.ok).toBe(true);
    const byId = new Map(programs.data.map((m) => [m.program.id, m]));
    expect([...byId.keys()].sort()).toEqual(
      ["city-baby", "city-closed", "city-medical", "city-unknown", "national-baby"].sort(),
    );
    expect(byId.get("city-baby")?.needsCheck).toBe(false);
    expect(byId.get("city-unknown")?.needsCheck).toBe(true);
    expect(byId.get("city-closed")?.maybeClosed).toBe(true);
    // 運営者の識別子は返さない
    expect(JSON.stringify(body)).not.toContain("operator-uid");
    expect(body["applications"]).toEqual({ ok: true, data: [] });
  });

  it("カテゴリで絞る。不正なカテゴリは 400", async () => {
    const t = setup();
    await t.call("PUT", "/household", owner, HOUSEHOLD);
    const body = await json(await t.call("GET", "/dashboard?category=medical", owner));
    const data = (body["programs"] as { data: { program: Program }[] }).data;
    expect(data.map((m) => m.program.id)).toEqual(["city-medical"]);
    expect((await t.call("GET", "/dashboard?category=other", owner)).status).toBe(400);
  });

  it("世帯が未登録なら、国の制度だけをすべて要確認で返す", async () => {
    const t = setup();
    const body = await json(await t.call("GET", "/dashboard", owner));
    const data = (body["programs"] as { data: { program: Program; needsCheck: boolean }[] }).data;
    expect(data.map((m) => [m.program.id, m.needsCheck])).toEqual([["national-baby", true]]);
  });
});

describe("GET /programs/:id", () => {
  it("確認済みの制度だけを、キャッシュ用のヘッダーつきで返す", async () => {
    const t = setup();
    const res = await t.call("GET", "/programs/city-baby", owner);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Cached-At")).toBe(NOW.toISOString());
    expect(res.headers.get("Cache-Control")).toContain("private");
    const body = await json(res);
    expect(body["name"]).toBe("制度 city-baby");
    expect(body).not.toHaveProperty("verifiedBy");
    for (const id of ["city-unverified", "city-review", "city-excluded", "broken", "missing"]) {
      expect((await t.call("GET", `/programs/${id}`, owner)).status).toBe(404);
    }
  });
});

describe("申請", () => {
  const update = {
    status: "in_progress",
    tasks: [
      { id: "t1", label: "申請書", done: true },
      { id: "t2", label: "保険証", done: false },
    ],
  };

  it("申請状況を保存し、制度の締切を付けて返す", async () => {
    const t = setup();
    expect((await t.call("GET", "/applications/city-baby", owner)).status).toBe(404);
    const res = await t.call("PUT", "/applications/city-baby", owner, update);
    expect(res.status).toBe(200);
    const saved = { programId: "city-baby", deadline: "2026-12-31", ...update };
    expect(await res.json()).toEqual(saved);
    expect(await (await t.call("GET", "/applications/city-baby", owner)).json()).toEqual(saved);
    const dash = await json(await t.call("GET", "/dashboard", owner));
    expect(dash["applications"]).toEqual({ ok: true, data: [saved] });
  });

  it("形が違えば 400、制度が無ければ 404", async () => {
    const t = setup();
    for (const bad of [
      { status: "unknown", tasks: [] },
      { status: "done", tasks: [{ id: "t1", label: "", done: true }] },
      { status: "done", tasks: [{ id: "../x", label: "a", done: true }] },
      { status: "done", tasks: "x" },
    ]) {
      expect((await t.call("PUT", "/applications/city-baby", owner, bad)).status).toBe(400);
    }
    expect((await t.call("PUT", "/applications/missing", owner, update)).status).toBe(404);
    expect(await doc(`users/${owner.uid}/applications/missing`)).toBeUndefined();
  });

  it("確認前・要再確認・除外の制度には新しく申請を作れない", async () => {
    const t = setup();
    for (const id of ["city-unverified", "city-review", "city-excluded"]) {
      const res = await t.call("PUT", `/applications/${id}`, owner, update);
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).not.toContain("2026-12-31");
      expect(await doc(`users/${owner.uid}/applications/${id}`)).toBeUndefined();
    }
  });

  it("すでにある申請は、あとで要再確認になった制度でも更新できる", async () => {
    const t = setup();
    await t.call("PUT", "/applications/city-baby", owner, update);
    await adminDb().doc("programs/city-baby").update({ needsReview: true, deadline: "2027-01-31" });
    const res = await t.call("PUT", "/applications/city-baby", owner, {
      status: "done",
      tasks: [],
    });
    expect(res.status).toBe(200);
    // 確認前の締切ではなく、保存してあった締切のまま
    expect(await res.json()).toMatchObject({ status: "done", deadline: "2026-12-31" });
    expect(await doc(`users/${owner.uid}/applications/city-baby`)).toMatchObject({
      status: "done",
      deadline: "2026-12-31",
    });
  });

  it("他の人の操作は本人の申請を変えない", async () => {
    const t = setup();
    await t.call("PUT", "/applications/city-baby", owner, update);
    const before = await doc(`users/${owner.uid}/applications/city-baby`);
    await t.call("PUT", "/applications/city-baby", other, { status: "done", tasks: [] });
    expect(await doc(`users/${owner.uid}/applications/city-baby`)).toEqual(before);
    expect((await t.call("GET", "/applications/city-baby", other)).status).toBe(200);
  });
});

describe("医療費", () => {
  const input = {
    date: "2026/11/01",
    facility: CANARY_NOTE,
    amountYen: "１,２００",
    subjectId: "c1",
  };

  it("追加・修正・削除ができ、集計と制度の提示を返す", async () => {
    const t = setup();
    await t.call("PUT", "/household", owner, HOUSEHOLD);
    const created = await t.call("POST", "/expenses", owner, input);
    expect(created.status).toBe(201);
    const record = (await created.json()) as { id: string; createdAt: string };
    expect(record).toMatchObject({
      date: "2026-11-01",
      facility: CANARY_NOTE,
      amountYen: 1200,
      subjectId: "c1",
    });

    const updated = await t.call("PUT", `/expenses/${record.id}`, owner, {
      ...input,
      amountYen: 3000,
      subjectId: "guardian",
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      id: record.id,
      amountYen: 3000,
      createdAt: record.createdAt,
    });

    await t.call("PUT", "/applications/city-medical", owner, {
      status: "in_progress",
      tasks: [{ id: "t1", label: "領収書", done: true }],
    });
    const summary = await json(await t.call("GET", "/expenses/summary", owner));
    expect((summary["records"] as unknown[]).length).toBe(1);
    expect(summary["summary"]).toMatchObject({ totalYen: 3000, count: 1 });
    expect(summary["suggestions"]).toMatchObject([
      { programId: "city-medical", periodTotalYen: 3000, missingDocs: ["申請書"] },
    ]);

    expect((await t.call("DELETE", `/expenses/${record.id}`, owner)).status).toBe(204);
    expect((await t.call("DELETE", `/expenses/${record.id}`, owner)).status).toBe(404);
    expect(await doc(`users/${owner.uid}/expenses/${record.id}`)).toBeUndefined();
  });

  it("入力が不正なら欄ごとのエラーで 400 を返し、保存しない", async () => {
    const t = setup();
    await t.call("PUT", "/household", owner, HOUSEHOLD);
    const res = await t.call("POST", "/expenses", owner, {
      date: "2026/12/01",
      facility: " ",
      amountYen: 0,
      subjectId: "c9",
    });
    expect(res.status).toBe(400);
    const fields = ((await res.json()) as { errors: { field: string }[] }).errors.map(
      (e) => e.field,
    );
    expect(fields.sort()).toEqual(["amountYen", "date", "facility", "subjectId"]);
    expect((await t.call("POST", "/expenses", owner, { date: 1 })).status).toBe(400);
    expect((await adminDb().collection(`users/${owner.uid}/expenses`).get()).size).toBe(0);
  });

  it("他の人は本人の記録を直せず、消せない", async () => {
    const t = setup();
    await t.call("PUT", "/household", owner, HOUSEHOLD);
    await t.call("PUT", "/household", other, HOUSEHOLD);
    const record = (await (await t.call("POST", "/expenses", owner, input)).json()) as {
      id: string;
    };
    const path = `users/${owner.uid}/expenses/${record.id}`;
    const before = await doc(path);
    expect((await t.call("PUT", `/expenses/${record.id}`, other, input)).status).toBe(404);
    expect((await t.call("DELETE", `/expenses/${record.id}`, other)).status).toBe(404);
    expect(await doc(path)).toEqual(before);
    const theirs = await json(await t.call("GET", "/expenses/summary", other));
    expect(theirs["records"]).toEqual([]);
  });

  it("医療費の内容はログに出ない", async () => {
    const t = setup();
    await t.call("PUT", "/household", owner, HOUSEHOLD);
    await t.call("POST", "/expenses", owner, input);
    await t.call("GET", "/expenses/summary", owner);
    expect(t.lines.length).toBeGreaterThan(0);
    expect(scanLogForLeaks(t.lines.join("\n"), { canaries: CANARIES })).toEqual([]);
  });

  it("アカウントの削除中は 409", async () => {
    const t = setup();
    await adminDb().doc(`deletionJobs/${owner.uid}`).set({ state: "running" });
    expect((await t.call("POST", "/expenses", owner, input)).status).toBe(409);
    expect((await t.call("GET", "/dashboard", owner)).status).toBe(409);
  });
});
