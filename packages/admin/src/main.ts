// 運営者 CLI の入口。運営者のローカルで `gcloud auth application-default login` した資格情報を使う。
// 実環境での実行は UW-GC-12（運営者の資格情報と admin クレーム）の後。
// 例: npm run admin -- --project <projectId> --operator <uid> verify <programId>

import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { createGenAiModels, VertexEmbedder } from "@hachioji-gov/collector";
import { runCli } from "./cli.js";
import { readAdminConfig } from "./config.js";
import { FirebaseAdminAuth, FirestoreAdminStore } from "./firestore.js";

const CONFIG_PATH = "config/app.config.json";

async function main(): Promise<number> {
  const loaded = readAdminConfig(JSON.parse(await readFile(CONFIG_PATH, "utf8")) as unknown);
  if (!loaded.ok) {
    process.stderr.write(`${CONFIG_PATH} の次の項目が不正です: ${loaded.keys.join(", ")}\n`);
    return 1;
  }
  const { config } = loaded;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await runCli(process.argv.slice(2), {
      connect: (project) => {
        const app = initializeApp({ projectId: project });
        const db = getFirestore(app);
        return {
          store: new FirestoreAdminStore(db, { fieldPrefix: config.embedding.fieldPrefix }),
          auth: new FirebaseAdminAuth(getAuth(app)),
          embedder: () => new VertexEmbedder(createGenAiModels(project, config.aiLocation)),
        };
      },
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
      prompt: (question) => rl.question(question),
      now: () => new Date(),
      // 運営者が指定したファイルを読む（sources import）
      // eslint-disable-next-line security/detect-non-literal-fs-filename -- 運営者のローカルでのみ実行する
      readFile: (path) => readFile(path, "utf8"),
      env: process.env,
      embedding: {
        model: config.embedding.model,
        dimensions: config.embedding.dimensions,
        version: config.embedding.version,
      },
      defaultIntervalHours: config.defaultIntervalHours,
    });
  } finally {
    rl.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
