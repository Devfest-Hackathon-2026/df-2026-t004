// 日次上限と運営スイッチ（Requirement 13.8, 13.9, 13.11, 13.12）

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 日本時間（UTC+9）の暦日の YYYY-MM-DD。日次の回数はこのキーで数える */
export function dateKeyJst(now: Date): string {
  const time = now.getTime();
  if (Number.isNaN(time)) throw new RangeError("日時が不正です");
  return new Date(time + JST_OFFSET_MS).toISOString().slice(0, 10);
}

export type QuotaCounts = { user: number; global: number };
export type QuotaLimits = { perUserPerDay: number; globalPerDay: number };

export type QuotaDecision =
  // 受け付ける。next は受付後の回数（両方ちょうど1増える）
  { ok: true; next: QuotaCounts } | { ok: false; reason: "quota_user" | "quota_global" };

/**
 * その日の回数から、質問を受け付けるか決める。1回の質問送信を1回と数える。
 * 再生成・検証・意図判定はこの関数を呼ばない（回数に加えない）。
 * どちらも上限に達しているときは、ユーザー別の理由を返す。
 */
export function evaluateQuota(counts: QuotaCounts, limits: QuotaLimits): QuotaDecision {
  if (counts.user >= limits.perUserPerDay) return { ok: false, reason: "quota_user" };
  if (counts.global >= limits.globalPerDay) return { ok: false, reason: "quota_global" };
  return { ok: true, next: { user: counts.user + 1, global: counts.global + 1 } };
}

// config/operations の値
export type OpsSwitch = { aiEnabled: boolean; collectionEnabled: boolean };

// 読み取れないときに使う「停止」
export const OPS_STOPPED: OpsSwitch = Object.freeze({ aiEnabled: false, collectionEnabled: false });

export type SwitchCache = { value: OpsSwitch; fetchedAtMs: number };

/** キャッシュを読み直す時期か（cacheTtlSec より古い、またはキャッシュが無い） */
export function needsSwitchRefresh(
  cache: SwitchCache | null,
  nowMs: number,
  cacheTtlSec: number,
): boolean {
  return cache === null || nowMs - cache.fetchedAtMs > cacheTtlSec * 1000;
}

/**
 * 運営スイッチの値を決める。
 * - 読み直しに成功した（refetched がある）ときは、その値
 * - 読み直していない・失敗したときは、キャッシュが maxStaleSec 以内ならキャッシュの値
 * - それより古い（またはキャッシュが無い）ときは停止として扱う。費用の暴走を防ぐ安全側の判断
 * 返す cache は、次に保存するキャッシュ。
 */
export function resolveSwitch(input: {
  cache: SwitchCache | null;
  nowMs: number;
  maxStaleSec: number;
  refetched: OpsSwitch | null;
}): { value: OpsSwitch; cache: SwitchCache | null } {
  const { cache, nowMs, maxStaleSec, refetched } = input;
  if (refetched !== null) {
    const value = {
      aiEnabled: refetched.aiEnabled,
      collectionEnabled: refetched.collectionEnabled,
    };
    return { value, cache: { value, fetchedAtMs: nowMs } };
  }
  if (cache !== null && nowMs - cache.fetchedAtMs <= maxStaleSec * 1000) {
    return { value: cache.value, cache };
  }
  return { value: OPS_STOPPED, cache };
}
