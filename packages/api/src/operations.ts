// 運営スイッチと日次上限のストア（Requirement 13.8, 13.9, 13.11, 13.12）

import {
  dateKeyJst,
  evaluateQuota,
  needsSwitchRefresh,
  resolveSwitch,
  type OpsSwitch,
  type QuotaDecision,
  type QuotaLimits,
  type SwitchCache,
} from "@hachioji-gov/shared";
import { Timestamp, type Firestore } from "firebase-admin/firestore";

export interface OpsConfigStore {
  /** config/operations を読む。読めないときは例外 */
  read(): Promise<OpsSwitch>;
}

export interface UsageStore {
  /** その日の回数を上限と比べ、受け付けるときだけ全体とユーザー別を同時に1増やす */
  reserve(uid: string, dateKey: string, limits: QuotaLimits): Promise<QuotaDecision>;
}

export type SwitchReader = { get(): Promise<OpsSwitch> };

/**
 * 運営スイッチを cacheTtlSec のキャッシュ付きで読む。
 * 読み直しに失敗したら、maxStaleSec 以内のキャッシュを使い、それより古ければ停止として扱う。
 */
export function createSwitchReader(
  store: OpsConfigStore,
  options: { cacheTtlSec: number; maxStaleSec: number },
  now: () => number = Date.now,
): SwitchReader {
  let cache: SwitchCache | null = null;
  return {
    async get() {
      const nowMs = now();
      let refetched: OpsSwitch | null = null;
      if (needsSwitchRefresh(cache, nowMs, options.cacheTtlSec)) {
        try {
          refetched = await store.read();
        } catch {
          refetched = null;
        }
      } else if (cache !== null) {
        return cache.value;
      }
      const resolved = resolveSwitch({
        cache,
        nowMs,
        maxStaleSec: options.maxStaleSec,
        refetched,
      });
      cache = resolved.cache;
      return resolved.value;
    },
  };
}

/** AI の質問を1回受け付けてよいか。停止中・上限超過なら理由を返す */
export async function admitQuestion(
  uid: string,
  deps: { switches: SwitchReader; usage: UsageStore; limits: QuotaLimits; now: Date },
): Promise<{ ok: true } | { ok: false; reason: "ops_stopped" | "quota_user" | "quota_global" }> {
  if (!(await deps.switches.get()).aiEnabled) return { ok: false, reason: "ops_stopped" };
  const decision = await deps.usage.reserve(uid, dateKeyJst(deps.now), deps.limits);
  return decision.ok ? { ok: true } : decision;
}

export class FirestoreOpsConfigStore implements OpsConfigStore {
  constructor(private readonly db: Firestore) {}

  async read(): Promise<OpsSwitch> {
    const snap = await this.db.collection("config").doc("operations").get();
    const aiEnabled: unknown = snap.get("aiEnabled");
    const collectionEnabled: unknown = snap.get("collectionEnabled");
    if (typeof aiEnabled !== "boolean" || typeof collectionEnabled !== "boolean") {
      throw new TypeError("config/operations is missing or invalid");
    }
    return { aiEnabled, collectionEnabled };
  }
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
// 日付が変わってから自動削除するまでの日数（TTL ポリシーが expireAt を見て消す）
export const USAGE_RETENTION_DAYS = 2;

/** 回数のドキュメントを消してよい時刻。その日（日本時間）の終わりから USAGE_RETENTION_DAYS 日後 */
export function usageExpireAt(dateKey: string): Timestamp {
  if (!DATE_KEY.test(dateKey)) throw new RangeError("invalid dateKey");
  // 日本時間の翌日0時（UTC では当日15時）
  const endOfDay = Date.parse(`${dateKey}T15:00:00.000Z`);
  return Timestamp.fromMillis(endOfDay + USAGE_RETENTION_DAYS * DAY_MS);
}

function countOf(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export class FirestoreUsageStore implements UsageStore {
  constructor(private readonly db: Firestore) {}

  async reserve(uid: string, dateKey: string, limits: QuotaLimits): Promise<QuotaDecision> {
    if (!DATE_KEY.test(dateKey)) throw new RangeError("invalid dateKey");
    if (uid === "" || uid.includes("/")) throw new RangeError("invalid uid");
    const globalRef = this.db.collection("usage").doc(dateKey);
    const userRef = this.db.collection("usageUsers").doc(`${dateKey}_${uid}`);
    const expireAt = usageExpireAt(dateKey);
    return this.db.runTransaction(async (tx) => {
      const [globalSnap, userSnap] = await tx.getAll(globalRef, userRef);
      const decision = evaluateQuota(
        { user: countOf(userSnap?.get("count")), global: countOf(globalSnap?.get("count")) },
        limits,
      );
      if (decision.ok) {
        tx.set(globalRef, { count: decision.next.global, expireAt });
        tx.set(userRef, { uid, count: decision.next.user, expireAt });
      }
      return decision;
    });
  }
}

/** テスト用のインメモリ実装 */
export class MemoryUsageStore implements UsageStore {
  readonly counts = new Map<string, number>();

  async reserve(uid: string, dateKey: string, limits: QuotaLimits): Promise<QuotaDecision> {
    const globalKey = `usage/${dateKey}`;
    const userKey = `usageUsers/${dateKey}_${uid}`;
    const decision = evaluateQuota(
      { user: this.counts.get(userKey) ?? 0, global: this.counts.get(globalKey) ?? 0 },
      limits,
    );
    if (decision.ok) {
      this.counts.set(globalKey, decision.next.global);
      this.counts.set(userKey, decision.next.user);
    }
    return decision;
  }
}
