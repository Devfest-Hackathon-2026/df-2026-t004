// 共通ミドルウェア（Requirement 1.9, 1.10, 9.5〜9.7, 9.10）
// 順序: ①レート制限（IP）→ ②ID トークン検証 → ③レート制限（ユーザー）→ ④認可 → ⑤構造化ログ → ⑥エラーハンドラ
// ⑤⑥は createApp が付ける。

import { authorizeAccess, type RateLimiter } from "@hachioji-gov/shared";
import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "./app.js";
import type { IdTokenVerifier } from "./auth.js";

const BEARER_PREFIX = "Bearer ";
// IP が取れないときのキー（まとめて1つとして数える）
export const UNKNOWN_IP = "unknown";

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) return undefined;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : undefined;
}

// Firebase Hosting のリライトの中継サーバーの範囲（Google の 66.249.64.0/19）。
// 実環境で 66.249.82.x を確認した（#129、未確認事項 U-8）
const HOSTING_PROXY_CIDR = { base: ipv4ToInt("66.249.64.0"), prefix: 19 } as const;

function ipv4ToInt(ip: string): number | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return undefined;
    const v = Number(p);
    if (v > 255) return undefined;
    n = n * 256 + v;
  }
  return n;
}

function isHostingProxy(ip: string): boolean {
  const n = ipv4ToInt(ip);
  const { base, prefix } = HOSTING_PROXY_CIDR;
  if (n === undefined || base === undefined) return false;
  const block = 2 ** (32 - prefix);
  return Math.floor(n / block) === Math.floor(base / block);
}

/**
 * クライアントの IP。Cloud Run の前段が付ける X-Forwarded-For の最後の値を使う
 * （利用者が送った値は前に並ぶため、先頭は信用しない）。
 * Firebase Hosting のリライトを経由すると、最後の値は Hosting の中継サーバーになり、
 * 利用者の IP はその1つ前に入る（U-8、#129 で確認）。そのため最後の値が中継サーバーの
 * 範囲のときだけ1つ前を使う。範囲外なら最後の値のまま（安全側）。
 * API は *.run.app で直接も呼べるため、先頭や Fastly-Client-IP は偽装できるので使わない。
 */
export function clientIp(c: Context): string {
  const hops = (c.req.header("X-Forwarded-For") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  let ip = hops.at(-1);
  if (ip !== undefined && isHostingProxy(ip) && hops.length >= 2) ip = hops.at(-2);
  return ip !== undefined && ip.length <= 64 ? ip : UNKNOWN_IP;
}

function tooManyRequests(c: Context, retryAfterSec: number): Response {
  c.header("Retry-After", String(retryAfterSec));
  return c.json({ error: "rate_limited", retryAfterSec }, 429);
}

export type Now = () => number;

/** ① IP ごとのレート制限。超過したら処理をせずに 429 */
export function rateLimitByIp(limiter: RateLimiter, now: Now): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const d = limiter.check(clientIp(c), now());
    if (!d.allowed) return tooManyRequests(c, d.retryAfterSec);
    await next();
  };
}

/** ② ID トークンを検証して uid を置く。無い・無効なら 401 */
export function authenticate(verifier: IdTokenVerifier): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const bearer = bearerToken(c.req.header("Authorization"));
    let uid: string | undefined;
    let authTime: number | undefined;
    if (bearer !== undefined) {
      try {
        const decoded = await verifier.verifyIdToken(bearer);
        uid = decoded.uid;
        authTime = decoded.auth_time;
      } catch {
        uid = undefined;
      }
    }
    if (uid === undefined || uid.length === 0) return c.json({ error: "unauthenticated" }, 401);
    c.set("uid", uid);
    if (authTime !== undefined) c.set("authTime", authTime);
    await next();
  };
}

/** 元に戻せない操作の前に求める、ログイン（再認証）からの経過時間の上限（秒） */
export const RECENT_SIGN_IN_SEC = 5 * 60;
// 端末と Firebase の時計のずれを許す幅（秒）
const CLOCK_SKEW_SEC = 60;

/**
 * 直前にログイン（再認証）したトークンだけを通す。authenticate の後に置く（#106）。
 * トークンが盗まれても、元に戻せないアカウント削除を実行されにくくするため。
 * auth_time が無い・古い・未来すぎるときは 401 reauthentication_required。
 */
export function requireRecentSignIn(
  now: Now,
  maxAgeSec = RECENT_SIGN_IN_SEC,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authTime = c.get("authTime");
    const age = now() / 1000 - (authTime ?? Number.NEGATIVE_INFINITY);
    if (!(age <= maxAgeSec && age >= -CLOCK_SKEW_SEC)) {
      return c.json({ error: "reauthentication_required" }, 401);
    }
    await next();
  };
}

/** アカウント削除の進行状態 */
export interface AccountStatus {
  isDeleting(uid: string): Promise<boolean>;
}

/**
 * アカウント削除の途中なら 409 で拒否する。authenticate の後に置く。
 * 削除の後にデータが作り直されないようにするため。DELETE /account だけは再試行のために通す。
 */
export function rejectDeletingAccount(status: AccountStatus): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const retry = c.req.method === "DELETE" && c.req.path === "/account";
    if (!retry && (await status.isDeleting(c.get("uid")))) {
      return c.json({ error: "account_deleting" }, 409);
    }
    await next();
  };
}

/** ③ ユーザーごとのレート制限。authenticate の後に置く */
export function rateLimitByUser(limiter: RateLimiter, now: Now): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const d = limiter.check(c.get("uid"), now());
    if (!d.allowed) return tooManyRequests(c, d.retryAfterSec);
    await next();
  };
}

/** ④ パスの uid がトークンの uid と一致するときだけ通す。authenticate の後に置く */
export function authorizeOwner(param = "uid"): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const decision = authorizeAccess(c.get("uid"), c.req.param(param) ?? "", true);
    if (!decision.allowed) {
      return c.json(
        { error: decision.status === 401 ? "unauthenticated" : "forbidden" },
        decision.status,
      );
    }
    await next();
  };
}

/** 画像などの multipart/form-data は受け付けない（Requirement 9.5） */
export const rejectMultipart: MiddlewareHandler<AppEnv> = async (c, next) => {
  const type = c.req.header("Content-Type")?.toLowerCase() ?? "";
  if (type.startsWith("multipart/")) return c.json({ error: "unsupported_media_type" }, 415);
  await next();
};
