// API アプリケーションの組み立て
import { randomUUID } from "node:crypto";
import { createLogger, type Logger } from "@hachioji-gov/shared";
import { Hono } from "hono";
import type { AuthVariables } from "./auth.js";

export type AppVariables = AuthVariables & {
  requestId: string;
  logger: Logger;
};

export type AppEnv = { Variables: AppVariables };

export type AppOptions = {
  logger?: Logger;
};

/**
 * 共通のミドルウェア（リクエストID、アクセスログ、例外処理）を付けた Hono アプリを作る。
 * ログには `redactForLog` の許可リストの項目だけが出る。
 */
export function createApp(options: AppOptions = {}): Hono<AppEnv> {
  const logger = options.logger ?? createLogger();
  const app = new Hono<AppEnv>();

  app.use(async (c, next) => {
    const requestId = randomUUID();
    const started = performance.now();
    c.set("requestId", requestId);
    c.set("logger", logger);
    await next();
    logger.info("request.completed", {
      requestId,
      status: c.res.status,
      durationMs: performance.now() - started,
    });
  });

  app.onError((err, c) => {
    logger.error("request.failed", { requestId: c.get("requestId"), error: err });
    // 例外の内容は応答にも出さない
    return c.json({ error: "internal" }, 500);
  });

  return app;
}
