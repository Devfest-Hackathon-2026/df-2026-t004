// Cloud Run（api）の入口。設定はリポジトリ直下の config/app.config.json を読む。
// シークレットは使わない（Vertex AI と Firestore はサービスアカウントの権限で呼ぶ）。
// 今後シークレットが要るときは、Secret Manager から注入された環境変数からだけ読む。

import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { createLogger, loadConfig, SAMPLE_POSTAL_TABLE } from "@hachioji-gov/shared";
import {
  FirestoreChatStore,
  FirestoreChatVectorStore,
  FirestoreHouseholdReader,
} from "./chat/firestore.js";
import { mountChat } from "./chat/route.js";
import { VertexChat } from "./chat/vertex.js";
import { createSwitchReader, FirestoreOpsConfigStore, FirestoreUsageStore } from "./operations.js";
import { AccountDeleter, FirestoreHouseholdStore, mountHousehold } from "./household.js";
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
  const project = process.env["GOOGLE_CLOUD_PROJECT"];
  if (project === undefined || project === "") {
    logger.error("api.project_missing");
    process.exitCode = 1;
    return;
  }
  const { config } = loaded;
  const firebase = initializeApp();
  const auth = getAuth(firebase);
  const db = getFirestore(firebase);
  const api = createApi({
    config,
    verifier: { verifyIdToken: (token) => auth.verifyIdToken(token) },
    logger,
  });
  const vertex = new VertexChat({
    project,
    location: config.ai.location,
    models: {
      generation: config.ai.generationModel,
      judge: config.ai.judgeModel,
      intent: config.ai.intentModel,
      embedding: config.embedding.model,
    },
    dimensions: config.embedding.dimensions,
    maxOutputTokens: config.ai.maxOutputTokens,
  });
  mountChat(api, {
    switches: createSwitchReader(new FirestoreOpsConfigStore(db), config.operations),
    usage: new FirestoreUsageStore(db),
    household: new FirestoreHouseholdReader(db),
    embedder: vertex,
    vectors: new FirestoreChatVectorStore(db),
    llm: vertex,
    store: new FirestoreChatStore(db, config.embedding.version),
    now: () => new Date(),
    settings: {
      limits: config.limits,
      minSimilarity: config.search.minSimilarity,
      fieldPrefix: config.embedding.fieldPrefix,
      firstTokenTimeoutSec: config.chat.firstTokenTimeoutSec,
    },
  });
  mountHousehold(api, {
    store: new FirestoreHouseholdStore(db),
    deleter: new AccountDeleter(db, {
      deleteUser: async (uid) => {
        try {
          await auth.deleteUser(uid);
          return "ok";
        } catch (error) {
          const code: unknown =
            error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined;
          if (code === "auth/user-not-found") return "user-not-found";
          throw error;
        }
      },
    }),
    // 全国の郵便番号データは未投入。投入までは開発用の小さな表を使う
    postal: SAMPLE_POSTAL_TABLE,
    now: () => new Date(),
  });
  api.app.get("/healthz", (c) => c.json({ ok: true }));
  const port = Number(process.env["PORT"] ?? "8080");
  serve({ fetch: api.app.fetch, port });
  logger.info("api.started");
}

main().catch((error: unknown) => {
  logger.error("api.failed", { error });
  process.exitCode = 1;
});
