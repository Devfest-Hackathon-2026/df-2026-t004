// Cloud Run Job の入口。日次で Cloud Scheduler から起動される。
// 実環境での実行は UW-GC-7（Cloud Run Job の作成）の後。設定はリポジトリ直下の config/app.config.json を読む。

import { readFile } from "node:fs/promises";
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { createLogger, loadConfig } from "@hachioji-gov/shared";
import { HttpFetcher } from "./fetcher.js";
import { FirestoreCollectorStore, FirestoreOpsConfigStore } from "./firestore.js";
import { runCollection } from "./run.js";
import {
  createGenAiModels,
  EXTRACT_MAX_OUTPUT_TOKENS,
  VertexEmbedder,
  VertexExtractor,
} from "./vertex.js";

const logger = createLogger();

async function main(): Promise<number> {
  const loaded = loadConfig(
    JSON.parse(await readFile("config/app.config.json", "utf8")) as unknown,
  );
  if (!loaded.ok) {
    // 設定が足りないときは動かさない（キー名は秘密ではないが、件数だけ出す）
    logger.error("collector.config_invalid", { count: loaded.errors.length });
    return 1;
  }
  const project = process.env["GOOGLE_CLOUD_PROJECT"];
  if (project === undefined || project === "") {
    logger.error("collector.project_missing");
    return 1;
  }
  const { config } = loaded;
  const db = getFirestore(initializeApp());
  const models = createGenAiModels(project, config.ai.location);
  const started = Date.now();
  const summary = await runCollection(
    {
      store: new FirestoreCollectorStore(db, { fieldPrefix: config.embedding.fieldPrefix }),
      fetcher: new HttpFetcher(),
      embedder: new VertexEmbedder(models),
      extractor: new VertexExtractor(models, config.ai.intentModel, EXTRACT_MAX_OUTPUT_TOKENS),
      clock: { now: () => new Date() },
      ops: new FirestoreOpsConfigStore(db),
    },
    {
      ...config.collector,
      embedding: {
        model: config.embedding.model,
        dimensions: config.embedding.dimensions,
        version: config.embedding.version,
      },
    },
  );
  const durationMs = Date.now() - started;
  if (summary.stopped) logger.warn("collector.stopped", { durationMs });
  logger.info("collector.fetched", { count: summary.fetched, durationMs });
  logger.info("collector.replaced", { count: summary.replaced });
  logger.info("collector.deferred", { count: summary.deferred });
  if (summary.errors > 0) logger.warn("collector.errors", { count: summary.errors });
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    logger.error("collector.failed", { error });
    process.exitCode = 1;
  },
);
