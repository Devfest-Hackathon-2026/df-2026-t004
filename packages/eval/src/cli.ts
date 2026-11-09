// 評価ハーネスのコマンド（Requirement 12.8, 14.1〜14.8）
//
//   npm run eval -- validate
//   EVAL_ID_TOKEN=... npm run eval -- perf --url https://<api>/chat --mode warm
//   EVAL_ID_TOKEN=... npm run eval -- perf --url https://<api>/chat --mode cold --service api
//
// 評価セットは eval/evalset.v1.json、結果は eval/results/{runId}.json に保存する（Firestore には保存しない）。
// eval retrieval / eval answer は、本番の検索・生成のパイプライン（T17）ができてから接続する。

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { encodeEvalResult, validateEvalSet, type EvalResult } from "@hachioji-gov/shared";
import { runIdOf, runPerf } from "./runner.js";
import { HttpChatClient } from "./sse.js";

const EVAL_SET_PATH = "eval/evalset.v1.json";
const RESULTS_DIR = "eval/results";
const RUNS = 10;
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,62}$/;

async function loadSet() {
  const checked = validateEvalSet(JSON.parse(await readFile(EVAL_SET_PATH, "utf8")) as unknown);
  if (!checked.ok) {
    for (const e of checked.errors) console.error(e);
    throw new Error("評価セットが不正です");
  }
  return checked.value;
}

// 結果に記録するモデル名（設定ファイルの値をそのまま使う）
async function models(): Promise<EvalResult["models"]> {
  const raw = JSON.parse(await readFile("config/app.config.json", "utf8")) as {
    ai: { generationModel: string; judgeModel: string };
    embedding: { model: string; dimensions: number; version: string };
  };
  return {
    generation: raw.ai.generationModel,
    judge: raw.ai.judgeModel,
    embedding: {
      model: raw.embedding.model,
      dimensions: raw.embedding.dimensions,
      version: raw.embedding.version,
    },
  };
}

async function save(result: EvalResult): Promise<string> {
  await mkdir(RESULTS_DIR, { recursive: true });
  const path = `${RESULTS_DIR}/${result.runId}.json`;
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- runId は日時から作った文字列
  await writeFile(path, encodeEvalResult(result), "utf8");
  return path;
}

/** Cloud Run に新しいリビジョンを作らせ、起動済みのインスタンスを捨てる */
function coldStarter(service: string, region: string): () => Promise<void> {
  if (!SERVICE_NAME.test(service) || !SERVICE_NAME.test(region)) {
    throw new RangeError("service と region の形式が不正です");
  }
  const run = promisify(execFile);
  return async () => {
    await run(
      "gcloud",
      [
        "run",
        "services",
        "update",
        service,
        "--region",
        region,
        "--update-env-vars",
        `EVAL_COLD_AT=${Date.now()}`,
        "--quiet",
      ],
      { shell: process.platform === "win32" },
    );
  };
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      url: { type: "string" },
      mode: { type: "string", default: "warm" },
      service: { type: "string", default: "api" },
      region: { type: "string", default: "asia-northeast1" },
    },
  });

  if (command === "validate") {
    const set = await loadSet();
    const noAnswer = set.questions.filter((q) => q.expected.kind === "no_answer").length;
    console.log(`OK: ${set.version}（${set.questions.length}問、答えのない質問 ${noAnswer}問）`);
    return 0;
  }

  if (command === "perf") {
    const idToken = process.env["EVAL_ID_TOKEN"];
    if (values.url === undefined || idToken === undefined || idToken === "") {
      console.error("--url と環境変数 EVAL_ID_TOKEN（計測用アカウントの ID トークン）が必要です");
      return 1;
    }
    if (values.mode !== "warm" && values.mode !== "cold") {
      console.error("--mode は warm か cold です");
      return 1;
    }
    const set = await loadSet();
    const ranAt = new Date();
    const perf = await runPerf(set, new HttpChatClient({ url: values.url, idToken }), {
      mode: values.mode,
      runs: RUNS,
      ...(values.mode === "cold"
        ? { prepareCold: coldStarter(values.service, values.region) }
        : {}),
    });
    const path = await save({
      runId: runIdOf(ranAt),
      ranAt: ranAt.toISOString(),
      evalSetVersion: set.version,
      models: await models(),
      metrics: {},
      perQuestion: [],
      perf,
    });
    console.log(JSON.stringify(perf, null, 2));
    console.log(`保存しました: ${path}`);
    return 0;
  }

  if (command === "retrieval" || command === "answer") {
    console.error(`eval ${command} は、検索・生成のパイプライン（T17）ができてから接続します`);
    return 1;
  }

  console.error("使い方: npm run eval -- <validate|perf> [オプション]");
  return 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : "失敗しました");
    process.exitCode = 1;
  },
);
