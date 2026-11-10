// 世帯情報・同意・郵便番号・アカウント削除の API（Requirement 2, 8.3〜8.5, 9.1〜9.4, 9.11）
// パスに uid を含めず、ID トークンの uid のデータだけを読み書きする。

import {
  classifyPostalCode,
  deletionResult,
  isDeletionTarget,
  readSensitive,
  splitByConsent,
  todayJst,
  validateHouseholdInput,
  type AuthDeletionOutcome,
  type ChildInput,
  type DeletionStepOutcome,
  type HouseholdInput,
  type PostalTable,
  type SensitiveData,
  type StoredChild,
  LEGAL_VERSION,
  SENSITIVE_CONSENT_VERSION,
} from "@hachioji-gov/shared";
import { FieldValue, Timestamp, type Firestore } from "firebase-admin/firestore";
import type { AccountStatus } from "./middleware.js";
import type { Api } from "./server.js";

// アカウント削除の Firestore 部分の上限（30秒以内に終えるため）
export const DELETION_TIMEOUT_MS = 25_000;
// deletionJobs を TTL で消すまでの日数
export const DELETION_JOB_RETENTION_DAYS = 7;

// 記録してよい同意の版（サーバーの現在の版と一致するときだけ記録する）
const CONSENT_VERSIONS = new Map([
  ["terms", LEGAL_VERSION],
  ["sensitive", SENSITIVE_CONSENT_VERSION],
]);
const CHIP = /^[a-z][a-z0-9_]{0,39}$/;
const DEFERRED = /^[A-Za-z][A-Za-z0-9_.]{0,39}$/;

/** GET/PUT /household の応答 */
export type HouseholdView = {
  postalCode: string;
  municipalityCode: string;
  prefecture: string;
  city: string;
  town: string;
  children: StoredChild[];
  onboardingDeferred: string[];
  sensitiveConsent: boolean;
  /** 同意があり、ロックされていないときだけ返す */
  sensitive: SensitiveData | null;
};

export type SaveHouseholdBody = HouseholdInput & {
  sensitiveConsent: boolean;
  onboardingDeferred: string[];
};

/** Firebase Auth のユーザー削除。ユーザーが無ければ "user-not-found" を返す */
export interface AccountAuth {
  deleteUser(uid: string): Promise<"ok" | "user-not-found">;
}

export class WithdrawalFailed extends Error {
  override name = "WithdrawalFailed";
}

const isObject = (v: unknown): v is object => v !== null && typeof v === "object";
const str = (o: unknown, key: string): string =>
  isObject(o) && typeof Reflect.get(o, key) === "string" ? (Reflect.get(o, key) as string) : "";

function stringList(v: unknown, max: number, pattern: RegExp): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max) return null;
  return v.every((x) => typeof x === "string" && pattern.test(x)) ? (v as string[]) : null;
}

/** PUT /household の本文の形を確かめる（値の範囲は validateHouseholdInput で見る） */
export function parseHouseholdBody(raw: unknown): SaveHouseholdBody | null {
  if (!isObject(raw) || Array.isArray(raw)) return null;
  const get = (k: string): unknown => Reflect.get(raw, k);
  const postalCode = get("postalCode");
  const children = get("children");
  const dueDate = get("dueDate");
  const freeText = get("freeText");
  const consent = get("sensitiveConsent");
  if (typeof postalCode !== "string" || postalCode.length > 16) return null;
  if (!Array.isArray(children) || children.length > 100) return null;
  const parsedChildren: ChildInput[] = [];
  for (const c of children as unknown[]) {
    if (!isObject(c)) return null;
    const ageYears: unknown = Reflect.get(c, "ageYears");
    const ageMonths: unknown = Reflect.get(c, "ageMonths");
    if (typeof ageYears !== "number") return null;
    if (ageMonths !== undefined && typeof ageMonths !== "number") return null;
    parsedChildren.push(ageMonths === undefined ? { ageYears } : { ageYears, ageMonths });
  }
  if (dueDate !== undefined && (typeof dueDate !== "string" || dueDate.length > 10)) return null;
  // 自由記述の上限（200文字）は validateHouseholdInput が見る。ここでは極端な長さだけを弾く
  if (freeText !== undefined && (typeof freeText !== "string" || freeText.length > 2000)) {
    return null;
  }
  if (typeof consent !== "boolean") return null;
  const chips = stringList(get("situationChips"), 20, CHIP);
  const deferred = stringList(get("onboardingDeferred"), 10, DEFERRED);
  if (chips === null || deferred === null) return null;
  return {
    postalCode,
    children: parsedChildren,
    situationChips: chips,
    sensitiveConsent: consent,
    onboardingDeferred: deferred,
    ...(dueDate === undefined ? {} : { dueDate }),
    ...(freeText === undefined ? {} : { freeText }),
  };
}

function storedChildren(v: unknown): StoredChild[] {
  if (!Array.isArray(v)) return [];
  return (v as unknown[]).flatMap((c): StoredChild[] => {
    if (!isObject(c)) return [];
    const ageYears: unknown = Reflect.get(c, "ageYears");
    const ageMonths: unknown = Reflect.get(c, "ageMonths");
    if (typeof ageYears !== "number") return [];
    const child: StoredChild = {
      id: str(c, "id"),
      ageYears,
      recordedAt: str(c, "recordedAt"),
      ...(typeof ageMonths === "number" ? { ageMonths } : {}),
    };
    return [child];
  });
}

function sensitiveOf(data: unknown): SensitiveData | null {
  if (!isObject(data)) return null;
  const chips: unknown = Reflect.get(data, "situationChips");
  const note: unknown = Reflect.get(data, "childNote");
  const pregnancy: unknown = Reflect.get(data, "pregnancy");
  const dueDate = str(pregnancy, "dueDate");
  return {
    situationChips: Array.isArray(chips)
      ? (chips as unknown[]).filter((c) => typeof c === "string")
      : [],
    ...(typeof note === "string" ? { childNote: note } : {}),
    ...(dueDate === "" ? {} : { pregnancy: { dueDate } }),
  };
}

/** users/{uid} と sensitive/profile の読み書き */
export class FirestoreHouseholdStore {
  constructor(
    protected readonly db: Firestore,
    protected readonly now: () => Date = () => new Date(),
  ) {}

  protected userRef(uid: string) {
    if (uid === "" || uid.includes("/")) throw new RangeError("invalid uid");
    return this.db.collection("users").doc(uid);
  }

  protected sensitiveRef(uid: string) {
    return this.userRef(uid).collection("sensitive").doc("profile");
  }

  /** 要配慮情報のドキュメントを消す（テストで失敗を差し込めるよう分けている） */
  protected async deleteSensitiveProfile(uid: string): Promise<void> {
    await this.sensitiveRef(uid).delete();
  }

  async read(uid: string): Promise<HouseholdView | null> {
    const [user, profile] = await Promise.all([
      this.userRef(uid).get(),
      this.sensitiveRef(uid).get(),
    ]);
    const household: unknown = user.get("household");
    if (!user.exists || !isObject(household)) return null;
    const consent = isObject(user.get("consents.sensitive"));
    const locked = user.get("sensitiveLocked") === true;
    const deferred: unknown = Reflect.get(household, "onboardingDeferred");
    return {
      postalCode: str(household, "postalCode"),
      municipalityCode: str(household, "municipalityCode"),
      prefecture: str(household, "prefecture"),
      city: str(household, "city"),
      town: str(household, "town"),
      children: storedChildren(Reflect.get(household, "children")),
      onboardingDeferred: Array.isArray(deferred)
        ? (deferred as unknown[]).filter((d) => typeof d === "string")
        : [],
      sensitiveConsent: consent && !locked,
      sensitive: readSensitive({
        consent,
        sensitive: profile.exists ? sensitiveOf(profile.data()) : null,
        sensitiveLocked: locked,
      }),
    };
  }

  /**
   * 世帯情報を保存する。同意がなければ要配慮情報を保存せず、既にあれば撤回と同じく消す。
   * 返り値は保存後の表示用の値。郵便番号は検証済みであること。
   */
  async save(
    uid: string,
    body: SaveHouseholdBody,
    place: {
      postalCode: string;
      municipalityCode: string;
      prefecture: string;
      city: string;
      town: string;
    },
  ): Promise<HouseholdView> {
    const now = this.now();
    const today = todayJst(now);
    const split = splitByConsent(body, body.sensitiveConsent);
    const children: StoredChild[] = split.household.children.map((c, i) => ({
      ...c,
      id: `c${i + 1}`,
      recordedAt: today,
    }));
    const household = {
      ...place,
      children,
      onboardingDeferred: [...new Set(body.onboardingDeferred)],
    };
    const user = this.userRef(uid);
    const snap = await user.get();
    const base = snap.exists ? {} : { createdAt: now.toISOString() };

    if (split.sensitive === null) {
      await user.set({ ...base, household }, { merge: true });
      if (isObject(snap.get("consents.sensitive")) || snap.get("sensitiveLocked") === true) {
        await this.withdraw(uid);
      } else {
        // 同意がないのに残っていれば消す（念のため）
        await this.deleteSensitiveProfile(uid);
      }
    } else {
      const consent = isObject(snap.get("consents.sensitive"))
        ? {}
        : {
            consents: {
              sensitive: { version: SENSITIVE_CONSENT_VERSION, grantedAt: now.toISOString() },
            },
          };
      // 要配慮情報は丸ごと置き換える（撤回に失敗して残っていた古い内容も消える）
      const batch = this.db.batch();
      batch.set(this.sensitiveRef(uid), { ...split.sensitive, updatedAt: now.toISOString() });
      batch.set(
        user,
        { ...base, ...consent, household, sensitiveLocked: FieldValue.delete() },
        { merge: true },
      );
      await batch.commit();
    }
    const view = await this.read(uid);
    if (view === null) throw new Error("household not saved");
    return view;
  }

  async recordConsent(uid: string, kind: "terms" | "sensitive", version: string): Promise<void> {
    const now = this.now().toISOString();
    const user = this.userRef(uid);
    const snap = await user.get();
    const record = kind === "terms" ? { version, acceptedAt: now } : { version, grantedAt: now };
    await user.set(
      { ...(snap.exists ? {} : { createdAt: now }), consents: { [kind]: record } },
      { merge: true },
    );
  }

  async isSensitiveLocked(uid: string): Promise<boolean> {
    return (await this.userRef(uid).get()).get("sensitiveLocked") === true;
  }

  /**
   * 同意の撤回。先に同意を消してロックを立て（すぐ読めなくする）、要配慮情報を消してからロックを外す。
   * 途中で失敗すればロックが残り、読み出しは拒否されたまま再試行できる。
   */
  async withdraw(uid: string): Promise<void> {
    const user = this.userRef(uid);
    try {
      await user.set(
        { consents: { sensitive: FieldValue.delete() }, sensitiveLocked: true },
        { merge: true },
      );
      await this.deleteSensitiveProfile(uid);
      await user.update({ sensitiveLocked: FieldValue.delete() });
    } catch (error) {
      throw new WithdrawalFailed("withdrawal failed", { cause: error });
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * アカウント削除の途中かどうか。users/{uid}.deleting と deletionJobs/{uid} の状態を見る。
 * users/{uid} は削除の途中で消えるため、ジョブが running か failed の間も削除中として扱う
 * （Auth の削除に失敗したあとに、データが作り直されないようにする）。
 */
export class FirestoreAccountStatus implements AccountStatus {
  constructor(private readonly db: Firestore) {}

  async isDeleting(uid: string): Promise<boolean> {
    if (uid === "" || uid.includes("/")) return false;
    const [user, job] = await this.db.getAll(
      this.db.collection("users").doc(uid),
      this.db.collection("deletionJobs").doc(uid),
    );
    const state: unknown = job?.get("state");
    return user?.get("deleting") === true || state === "running" || state === "failed";
  }
}

/** アカウント削除（冪等。何度実行しても同じ最終状態になる） */
export class AccountDeleter {
  constructor(
    private readonly db: Firestore,
    private readonly auth: AccountAuth,
    private readonly options: { timeoutMs: number; now: () => Date } = {
      timeoutMs: DELETION_TIMEOUT_MS,
      now: () => new Date(),
    },
  ) {}

  private async deleteFirestore(uid: string): Promise<void> {
    const usage = await this.db.collection("usageUsers").where("uid", "==", uid).get();
    // 削除してよいパスか、共有の関数で確かめてから消す
    const targets = usage.docs.filter((d) => isDeletionTarget(uid, d.ref.path));
    await Promise.all(targets.map((d) => d.ref.delete()));
    await this.db.recursiveDelete(this.db.collection("users").doc(uid));
  }

  async run(uid: string): Promise<{ state: "done" | "failed" }> {
    if (uid === "" || uid.includes("/")) throw new RangeError("invalid uid");
    const now = this.options.now();
    const job = this.db.collection("deletionJobs").doc(uid);
    await job.set(
      {
        state: "running",
        attempts: FieldValue.increment(1),
        updatedAt: now.toISOString(),
        expireAt: Timestamp.fromMillis(
          now.getTime() + DELETION_JOB_RETENTION_DAYS * 24 * 60 * 60 * 1000,
        ),
      },
      { merge: true },
    );
    await this.db.collection("users").doc(uid).set({ deleting: true }, { merge: true });

    let firestore: DeletionStepOutcome;
    try {
      const r = await withTimeout(this.deleteFirestore(uid), this.options.timeoutMs);
      firestore = r === "timeout" ? "timeout" : "ok";
    } catch {
      firestore = "failed";
    }
    let auth: AuthDeletionOutcome | "skipped" = "skipped";
    if (firestore === "ok") {
      try {
        auth = await this.auth.deleteUser(uid);
      } catch {
        auth = "failed";
      }
    }
    const result = deletionResult(firestore, auth);
    await job.set(
      { state: result.state, updatedAt: this.options.now().toISOString() },
      { merge: true },
    );
    return { state: result.state };
  }
}

export type HouseholdDeps = {
  store: FirestoreHouseholdStore;
  deleter: AccountDeleter;
  postal: PostalTable;
  now: () => Date;
};

async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
}

export function mountHousehold(api: Api, deps: HouseholdDeps): void {
  const { app, guards } = api;
  for (const path of ["/household", "/consents/*", "/postal/*", "/account"]) {
    app.use(path, ...guards.signedIn);
  }

  app.get("/household", async (c) => {
    const view = await deps.store.read(c.get("uid"));
    return view === null ? c.json({ error: "not_found" }, 404) : c.json(view);
  });

  app.put("/household", async (c) => {
    const body = parseHouseholdBody(await jsonBody(c));
    if (body === null) return c.json({ error: "invalid_request" }, 400);
    const today = todayJst(deps.now());
    const checked = validateHouseholdInput(body, today, deps.postal);
    if (!checked.ok) return c.json({ errors: checked.errors }, 400);
    const postal = classifyPostalCode(body.postalCode, deps.postal);
    if (postal.kind !== "hachioji" && postal.kind !== "outside") {
      return c.json(
        { errors: [{ field: "postalCode", message: "郵便番号を確認してください" }] },
        400,
      );
    }
    try {
      const view = await deps.store.save(c.get("uid"), body, {
        postalCode: postal.postalCode,
        ...postal.entry,
      });
      return c.json(view);
    } catch (error) {
      if (error instanceof WithdrawalFailed) return c.json({ error: "withdrawal_failed" }, 503);
      throw error;
    }
  });

  app.post("/consents/:kind", async (c) => {
    const kind = c.req.param("kind");
    if (kind !== "terms" && kind !== "sensitive") return c.json({ error: "not_found" }, 404);
    const version = str(await jsonBody(c), "version");
    // 古い文面への同意を記録しないよう、現在の版だけを受け付ける
    if (version !== CONSENT_VERSIONS.get(kind)) {
      return c.json({ error: "version_mismatch" }, 400);
    }
    const uid = c.get("uid");
    // 撤回の削除が終わっていないうちに同意し直すと、古い要配慮情報が読めてしまう
    if (kind === "sensitive" && (await deps.store.isSensitiveLocked(uid))) {
      return c.json({ error: "sensitive_locked" }, 409);
    }
    await deps.store.recordConsent(uid, kind, version);
    return c.body(null, 204);
  });

  app.delete("/consents/sensitive", async (c) => {
    try {
      await deps.store.withdraw(c.get("uid"));
      return c.body(null, 204);
    } catch (error) {
      if (error instanceof WithdrawalFailed) return c.json({ error: "withdrawal_failed" }, 503);
      throw error;
    }
  });

  app.get("/postal/:code", (c) => {
    const code = c.req.param("code");
    return c.json(
      code.length > 16 ? { kind: "invalidFormat" } : classifyPostalCode(code, deps.postal),
    );
  });

  // 元に戻せないので、直前に再認証したトークンだけを受け付ける（#106）
  app.delete("/account", guards.recentSignIn, async (c) => {
    const result = await deps.deleter.run(c.get("uid"));
    // 失敗したときはサインインを保ち、同じリクエストで再試行してもらう
    return result.state === "done"
      ? c.json({ state: "done" })
      : c.json({ error: "deletion_failed", state: "failed" }, 503);
  });
}
