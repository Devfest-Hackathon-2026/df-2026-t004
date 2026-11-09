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

/**
 * クライアントの IP。Cloud Run の前段が付ける X-Forwarded-For の最後の値を使う
 * （利用者が送った値は前に並ぶため、先頭は信用しない）。
 * Firebase Hosting のリライトを経由するときの位置は未確認事項 U-8。実環境で確かめる。
 */
export function clientIp(c: Context): string {
  const forwarded = c.req.header("X-Forwarded-For");
  const last = forwarded
    ?.split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "")
    .at(-1);
  return last !== undefined && last.length <= 64 ? last : UNKNOWN_IP;
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
    if (bearer !== undefined) {
      try {
        uid = (await verifier.verifyIdToken(bearer)).uid;
      } catch {
        uid = undefined;
      }
    }
    if (uid === undefined || uid.length === 0) return c.json({ error: "unauthenticated" }, 401);
    c.set("uid", uid);
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
