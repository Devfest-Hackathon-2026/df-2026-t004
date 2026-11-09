// Cloud Run（api）の入口。設定はリポジトリ直下の config/app.config.json を読む。
// シークレットは使わない（Vertex AI と Firestore はサービスアカウントの権限で呼ぶ）。
// 今後シークレットが要るときは、Secret Manager から注入された環境変数からだけ読む。

import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { createLogger, loadConfig } from "@hachioji-gov/shared";
import { createApi } from "./server.js";

const logger = createLogger();

async function main(): Promise<void> {
  const loaded = loadConfig(
    JSON.parse(await readFile("config/app.config.json", "utf8")) as unknown,
  );
  if (!loaded.ok) {
    // 設定が足りないときは起動しない
    logger.error("api.config_invalid", { count: loaded.errors.length });
    process.exitCode = 1;
    return;
  }
  const auth = getAuth(initializeApp());
  const { app } = createApi({
    config: loaded.config,
    verifier: { verifyIdToken: (token) => auth.verifyIdToken(token) },
    logger,
  });
  app.get("/healthz", (c) => c.json({ ok: true }));
  const port = Number(process.env["PORT"] ?? "8080");
  serve({ fetch: app.fetch, port });
  logger.info("api.started");
}

main().catch((error: unknown) => {
  logger.error("api.failed", { error });
  process.exitCode = 1;
});
