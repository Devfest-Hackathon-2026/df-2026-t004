// ダッシュボード・制度・申請・医療費の API（Requirement 4.1〜4.11, 6.1〜6.6, 12.4）
// パスに uid を含めず、ID トークンの uid のデータだけを読み書きする。

import {
  aggregateExpenses,
  decodeExpenseRecord,
  decodeProgram,
  deriveAgeBands,
  encodeExpenseRecord,
  isSearchable,
  matchPrograms,
  municipalityCodesFor,
  PROGRAM_CATEGORIES,
  suggestProgramsFromExpenses,
  todayJst,
  toExpenseRecord,
  validateExpense,
  type Application,
  type ApplicationTask,
  type ExpenseInput,
  type ExpenseRecord,
  type MatchHousehold,
  type Program,
  type ProgramCategory,
} from "@hachioji-gov/shared";
import type { Firestore } from "firebase-admin/firestore";
import type { FirestoreHouseholdStore, HouseholdView } from "./household.js";
import type { Api } from "./server.js";

const DOC_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TASK_ID = /^[A-Za-z0-9_-]{1,40}$/;
export const TASKS_MAX = 50;
export const TASK_LABEL_MAX = 200;
// 1人が持てる医療費の記録の上限（5年分の通院を想定した余裕のある数）
export const EXPENSES_MAX = 2000;
const STATUSES: readonly Application["status"][] = ["not_started", "in_progress", "done"];

const isObject = (v: unknown): v is object => v !== null && typeof v === "object";

/** 画面に返す制度。運営者の識別子（verifiedBy）は返さない */
export function publicProgram(p: Program): Program {
  return Object.fromEntries(Object.entries(p).filter(([key]) => key !== "verifiedBy")) as Program;
}

/** 世帯の情報から、候補の判定に使う形にする（未登録なら国の制度だけ・すべて要確認） */
export function matchHouseholdOf(view: HouseholdView | null, today: string): MatchHousehold {
  if (view === null) {
    return { municipalityCode: null, ageBands: { bands: [], unset: true } };
  }
  return {
    municipalityCode: view.municipalityCode === "" ? null : view.municipalityCode,
    ageBands: deriveAgeBands(
      view.children,
      view.sensitive?.pregnancy ?? null,
      view.sensitiveConsent,
      today,
    ),
  };
}

/** 申請の本文（PUT /applications/:programId）を確かめる */
export function parseApplicationBody(
  raw: unknown,
): { status: Application["status"]; tasks: ApplicationTask[] } | null {
  if (!isObject(raw) || Array.isArray(raw)) return null;
  const status: unknown = Reflect.get(raw, "status");
  const tasks: unknown = Reflect.get(raw, "tasks");
  if (!STATUSES.some((s) => s === status)) return null;
  if (!Array.isArray(tasks) || tasks.length > TASKS_MAX) return null;
  const parsed: ApplicationTask[] = [];
  const ids = new Set<string>();
  for (const t of tasks as unknown[]) {
    if (!isObject(t)) return null;
    const id: unknown = Reflect.get(t, "id");
    const label: unknown = Reflect.get(t, "label");
    const done: unknown = Reflect.get(t, "done");
    if (typeof id !== "string" || !TASK_ID.test(id) || ids.has(id)) return null;
    if (typeof label !== "string" || label.trim() === "" || [...label].length > TASK_LABEL_MAX) {
      return null;
    }
    if (typeof done !== "boolean") return null;
    ids.add(id);
    parsed.push({ id, label, done });
  }
  return { status: status as Application["status"], tasks: parsed };
}

/** 医療費の本文の形を確かめる（値の範囲は validateExpense で見る） */
export function parseExpenseBody(raw: unknown): ExpenseInput | null {
  if (!isObject(raw) || Array.isArray(raw)) return null;
  const date: unknown = Reflect.get(raw, "date");
  const facility: unknown = Reflect.get(raw, "facility");
  const amountYen: unknown = Reflect.get(raw, "amountYen");
  const subjectId: unknown = Reflect.get(raw, "subjectId");
  if (typeof date !== "string" || date.length > 20) return null;
  if (typeof facility !== "string" || facility.length > 1000) return null;
  if (typeof amountYen !== "number" && (typeof amountYen !== "string" || amountYen.length > 20)) {
    return null;
  }
  if (typeof subjectId !== "string" || subjectId.length > 40) return null;
  return { date, facility, amountYen, subjectId };
}

function applicationOf(programId: string, data: unknown): Application | null {
  if (!isObject(data)) return null;
  const status: unknown = Reflect.get(data, "status");
  const deadline: unknown = Reflect.get(data, "deadline");
  const parsed = parseApplicationBody({ status, tasks: Reflect.get(data, "tasks") });
  if (parsed === null) return null;
  return {
    programId,
    status: parsed.status,
    deadline: typeof deadline === "string" ? deadline : null,
    tasks: parsed.tasks,
  };
}

/** programs の読み取り */
export class FirestoreProgramStore {
  constructor(private readonly db: Firestore) {}

  /** 自治体コードに合う制度（形の崩れたものは除く） */
  async listFor(codes: readonly string[]): Promise<Program[]> {
    if (codes.length === 0) return [];
    const snap = await this.db
      .collection("programs")
      .where("municipalityCode", "in", [...codes])
      .get();
    return snap.docs.flatMap((d) => {
      const decoded = decodeProgram(d.id, d.data());
      return decoded.ok ? [decoded.value] : [];
    });
  }

  async get(id: string): Promise<Program | null> {
    if (!DOC_ID.test(id)) return null;
    const snap = await this.db.collection("programs").doc(id).get();
    if (!snap.exists) return null;
    const decoded = decodeProgram(snap.id, snap.data());
    return decoded.ok ? decoded.value : null;
  }
}

/** users/{uid}/applications と users/{uid}/expenses の読み書き */
export class FirestoreUserRecords {
  constructor(private readonly db: Firestore) {}

  private user(uid: string) {
    if (uid === "" || uid.includes("/")) throw new RangeError("invalid uid");
    return this.db.collection("users").doc(uid);
  }

  async listApplications(uid: string): Promise<Application[]> {
    const snap = await this.user(uid).collection("applications").limit(500).get();
    return snap.docs.flatMap((d) => {
      const a = applicationOf(d.id, d.data());
      return a === null ? [] : [a];
    });
  }

  async getApplication(uid: string, programId: string): Promise<Application | null> {
    if (!DOC_ID.test(programId)) return null;
    const snap = await this.user(uid).collection("applications").doc(programId).get();
    return snap.exists ? applicationOf(snap.id, snap.data()) : null;
  }

  async saveApplication(uid: string, app: Application, now: string): Promise<void> {
    await this.user(uid)
      .collection("applications")
      .doc(app.programId)
      .set({ status: app.status, deadline: app.deadline, tasks: app.tasks, updatedAt: now });
  }

  /** 新しい順（受診日、同じ日なら登録の新しい順） */
  async listExpenses(uid: string): Promise<ExpenseRecord[]> {
    const snap = await this.user(uid).collection("expenses").limit(EXPENSES_MAX).get();
    const records = snap.docs.flatMap((d) => {
      const decoded = decodeExpenseRecord(d.id, d.data());
      return decoded.ok ? [decoded.value] : [];
    });
    return records.sort((a, b) =>
      a.date === b.date ? b.createdAt.localeCompare(a.createdAt) : b.date.localeCompare(a.date),
    );
  }

  async countExpenses(uid: string): Promise<number> {
    const snap = await this.user(uid).collection("expenses").count().get();
    return snap.data().count;
  }

  async getExpense(uid: string, id: string): Promise<ExpenseRecord | null> {
    if (!DOC_ID.test(id)) return null;
    const snap = await this.user(uid).collection("expenses").doc(id).get();
    if (!snap.exists) return null;
    const decoded = decodeExpenseRecord(snap.id, snap.data());
    return decoded.ok ? decoded.value : null;
  }

  newExpenseId(uid: string): string {
    return this.user(uid).collection("expenses").doc().id;
  }

  async saveExpense(uid: string, record: ExpenseRecord): Promise<void> {
    await this.user(uid).collection("expenses").doc(record.id).set(encodeExpenseRecord(record));
  }

  /** 消したら true。無ければ false */
  async deleteExpense(uid: string, id: string): Promise<boolean> {
    if (!DOC_ID.test(id)) return false;
    const ref = this.user(uid).collection("expenses").doc(id);
    if (!(await ref.get()).exists) return false;
    await ref.delete();
    return true;
  }
}

export type DashboardDeps = {
  household: FirestoreHouseholdStore;
  programs: FirestoreProgramStore;
  records: FirestoreUserRecords;
  now: () => Date;
};

async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

/** 失敗してもほかのセクションを返せるよう、セクションごとに結果を包む（Requirement 4.11） */
async function section<T>(run: () => Promise<T>): Promise<{ ok: true; data: T } | { ok: false }> {
  try {
    return { ok: true, data: await run() };
  } catch {
    return { ok: false };
  }
}

export function mountDashboard(api: Api, deps: DashboardDeps): void {
  const { app, guards } = api;
  for (const path of ["/dashboard", "/programs/*", "/applications/*", "/expenses", "/expenses/*"]) {
    app.use(path, ...guards.signedIn);
  }

  // 世帯と、その世帯に合う確認済みの制度
  const householdAndPrograms = async (uid: string, today: string) => {
    const view = await deps.household.read(uid);
    const household = matchHouseholdOf(view, today);
    const programs = await deps.programs.listFor(municipalityCodesFor(household.municipalityCode));
    return { view, household, programs };
  };

  app.get("/dashboard", async (c) => {
    const raw = c.req.query("category");
    const category =
      raw === undefined || raw === ""
        ? null
        : (PROGRAM_CATEGORIES.find((k) => k === raw) ?? undefined);
    if (category === undefined) return c.json({ error: "invalid_request" }, 400);
    const uid = c.get("uid");
    const today = todayJst(deps.now());
    const [programs, applications] = await Promise.all([
      section(async () => {
        const h = await householdAndPrograms(uid, today);
        return matchPrograms(
          h.household,
          h.programs,
          today,
          category as ProgramCategory | null,
        ).map((m) => ({ ...m, program: publicProgram(m.program) }));
      }),
      section(() => deps.records.listApplications(uid)),
    ]);
    return c.json({ programs, applications });
  });

  app.get("/programs/:id", async (c) => {
    const program = await deps.programs.get(c.req.param("id"));
    // 確認済みで、要再確認でも除外でもない制度だけを見せる
    if (program === null || !isSearchable(program)) return c.json({ error: "not_found" }, 404);
    c.header("Cache-Control", "private, max-age=0, must-revalidate");
    c.header("X-Cached-At", deps.now().toISOString());
    return c.json(publicProgram(program));
  });

  app.get("/applications/:programId", async (c) => {
    const a = await deps.records.getApplication(c.get("uid"), c.req.param("programId"));
    return a === null ? c.json({ error: "not_found" }, 404) : c.json(a);
  });

  app.put("/applications/:programId", async (c) => {
    const body = parseApplicationBody(await jsonBody(c));
    if (body === null) return c.json({ error: "invalid_request" }, 400);
    const program = await deps.programs.get(c.req.param("programId"));
    if (program === null) return c.json({ error: "not_found" }, 404);
    // 新しく作るのは確認済みの制度だけ（確認前の制度と締切を画面に出さない）。
    // すでにある申請は、あとで要再確認になった制度でも更新できるようにする
    const uid = c.get("uid");
    const existing = await deps.records.getApplication(uid, program.id);
    if (existing === null && !isSearchable(program)) return c.json({ error: "not_found" }, 404);
    // 確認済みでない制度の締切はまだ確かめていない値なので、保存してある締切を使う
    const deadline = isSearchable(program) ? program.deadline : (existing?.deadline ?? null);
    const a: Application = { programId: program.id, deadline, ...body };
    await deps.records.saveApplication(uid, a, deps.now().toISOString());
    return c.json(a);
  });

  // 医療費の記録を作る・直す。対象者は登録済みの子どもか保護者だけ
  const saveExpense = async (uid: string, raw: unknown, existing: ExpenseRecord | null) => {
    const input = parseExpenseBody(raw);
    if (input === null) return { status: 400 as const, body: { error: "invalid_request" } };
    const now = deps.now();
    const today = todayJst(now);
    const view = await deps.household.read(uid);
    const subjectIds = view?.children.map((child) => child.id) ?? [];
    const checked = validateExpense(input, today, subjectIds);
    if (!checked.ok) return { status: 400 as const, body: { errors: checked.errors } };
    const record = toExpenseRecord(
      input,
      {
        id: existing?.id ?? deps.records.newExpenseId(uid),
        now: now.toISOString(),
        ...(existing === null ? {} : { createdAt: existing.createdAt }),
      },
      today,
      subjectIds,
    );
    if (record === null) return { status: 400 as const, body: { errors: checked.errors } };
    await deps.records.saveExpense(uid, record);
    return { status: existing === null ? (201 as const) : (200 as const), body: record };
  };

  app.post("/expenses", async (c) => {
    const uid = c.get("uid");
    if ((await deps.records.countExpenses(uid)) >= EXPENSES_MAX) {
      return c.json({ error: "too_many_records" }, 409);
    }
    const r = await saveExpense(uid, await jsonBody(c), null);
    return c.json(r.body, r.status);
  });

  app.get("/expenses/summary", async (c) => {
    const uid = c.get("uid");
    const today = todayJst(deps.now());
    const [records, h, applications] = await Promise.all([
      deps.records.listExpenses(uid),
      householdAndPrograms(uid, today),
      deps.records.listApplications(uid),
    ]);
    // 申請ごとに、そろえ終わった書類（タスクの完了）を渡す
    const preparedDocs = Object.fromEntries(
      applications.map((a) => [a.programId, a.tasks.filter((t) => t.done).map((t) => t.label)]),
    );
    return c.json({
      records,
      summary: aggregateExpenses(records),
      suggestions: suggestProgramsFromExpenses(records, h.programs, {
        today,
        household: h.household,
        preparedDocs,
      }),
    });
  });

  app.put("/expenses/:id", async (c) => {
    const uid = c.get("uid");
    const existing = await deps.records.getExpense(uid, c.req.param("id"));
    if (existing === null) return c.json({ error: "not_found" }, 404);
    const r = await saveExpense(uid, await jsonBody(c), existing);
    return c.json(r.body, r.status);
  });

  app.delete("/expenses/:id", async (c) => {
    const deleted = await deps.records.deleteExpense(c.get("uid"), c.req.param("id"));
    return deleted ? c.body(null, 204) : c.json({ error: "not_found" }, 404);
  });
}
