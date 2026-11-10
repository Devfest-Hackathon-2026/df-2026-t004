// API の組み立て（Requirement 1.9, 1.10, 9.6, 9.7, 9.10, 13.7）

import { createRateLimiter, type AppConfig, type Logger } from "@hachioji-gov/shared";
import type { Hono, MiddlewareHandler } from "hono";
import { createApp, type AppEnv } from "./app.js";
import type { IdTokenVerifier } from "./auth.js";
import {
  authenticate,
  authorizeOwner,
  rateLimitByIp,
  rateLimitByUser,
  rejectDeletingAccount,
  rejectMultipart,
  requireRecentSignIn,
  type AccountStatus,
  type Now,
} from "./middleware.js";

export type ApiDeps = {
  config: Pick<AppConfig, "rateLimit">;
  verifier: IdTokenVerifier;
  // アカウント削除の途中のユーザーを拒否する（省略時は確かめない）
  accountStatus?: AccountStatus;
  logger?: Logger;
  now?: Now;
};

/** ルートに付けるミドルウェアの組 */
export type Guards = {
  // ログインしていれば通す（自分のデータは uid をトークンから取る）
  signedIn: MiddlewareHandler<AppEnv>[];
  // パスの :uid が本人のときだけ通す
  owner: MiddlewareHandler<AppEnv>[];
  // 直前に再認証したときだけ通す（元に戻せない操作の前に。signedIn の後に付ける）
  recentSignIn: MiddlewareHandler<AppEnv>;
};

export type Api = { app: Hono<AppEnv>; guards: Guards };

/**
 * 共通ミドルウェアを付けた API を作る。ルートは返り値の app と guards を使って足す。
 *   app.use("/household", ...guards.signedIn)
 *   app.use("/users/:uid/*", ...guards.owner)
 */
export function createApi(deps: ApiDeps): Api {
  const now = deps.now ?? Date.now;
  const { rateLimit } = deps.config;
  const byIp = createRateLimiter({
    limit: rateLimit.perIpPerMinute,
    windowSec: rateLimit.windowSec,
    maxEntries: rateLimit.maxEntries,
  });
  const byUser = createRateLimiter({
    limit: rateLimit.perUserPerMinute,
    windowSec: rateLimit.windowSec,
    maxEntries: rateLimit.maxEntries,
  });

  // ⑤構造化ログと⑥エラーハンドラは createApp が外側に付ける
  const app = createApp(deps.logger === undefined ? {} : { logger: deps.logger });
  app.use("*", rateLimitByIp(byIp, now));
  app.use("*", rejectMultipart);

  const signedIn = [
    authenticate(deps.verifier),
    ...(deps.accountStatus === undefined ? [] : [rejectDeletingAccount(deps.accountStatus)]),
    rateLimitByUser(byUser, now),
  ];
  return {
    app,
    guards: {
      signedIn,
      owner: [...signedIn, authorizeOwner()],
      recentSignIn: requireRecentSignIn(now),
    },
  };
}
