// 認証と所有者検査のミドルウェア（Requirement 9.6, 9.7, 15.2）
import { authorizeAccess } from "@hachioji-gov/shared";
import type { MiddlewareHandler } from "hono";

/** ID トークンの検証（本番は Firebase Admin SDK、テストは差し替え） */
export interface IdTokenVerifier {
  /** auth_time は最後にログイン（再認証）した時刻（UNIX 秒）。Admin SDK の戻り値に入っている */
  verifyIdToken(idToken: string): Promise<{ uid: string; auth_time?: number }>;
}

export type AuthVariables = {
  /** 検証済みのトークンの uid */
  uid: string;
  /** 検証済みのトークンの auth_time（UNIX 秒）。無いトークンもある */
  authTime?: number;
};

const BEARER_PREFIX = "Bearer ";

function bearerToken(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith(BEARER_PREFIX)) return undefined;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : undefined;
}

/**
 * `Authorization: Bearer <ID トークン>` を検証し、パスの `:uid` と一致するときだけ通す。
 * - トークンが無い・無効なら 401
 * - uid が一致しなければ 403
 * 拒否の応答本文には、入力の内容を含めない。
 */
export function requireOwner(
  verifier: IdTokenVerifier,
  param = "uid",
): MiddlewareHandler<{ Variables: AuthVariables }> {
  return async (c, next) => {
    const bearer = bearerToken(c.req.header("Authorization"));
    let tokenUid: string | undefined;
    if (bearer !== undefined) {
      try {
        tokenUid = (await verifier.verifyIdToken(bearer)).uid;
      } catch {
        tokenUid = undefined;
      }
    }
    const decision = authorizeAccess(tokenUid, c.req.param(param) ?? "", tokenUid !== undefined);
    if (!decision.allowed) {
      return c.json(
        { error: decision.status === 401 ? "unauthenticated" : "forbidden" },
        decision.status,
      );
    }
    c.set("uid", tokenUid as string);
    await next();
  };
}
