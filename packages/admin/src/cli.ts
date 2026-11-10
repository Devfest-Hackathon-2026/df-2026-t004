// 引数の解釈とコマンドの振り分け。接続（Firestore・Auth・Vertex AI）は呼び出し側から受け取る。

import { parseArgs } from "node:util";
import type { Embedder } from "@hachioji-gov/collector";
import {
  addSource,
  cleanupEmbeddings,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  grantAdmin,
  importSources,
  reembed,
  setOps,
  setSearchVersion,
  unverifyProgram,
  verifyEmbeddings,
  verifyProgram,
  type CommandContext,
  type EmbeddingConfig,
  type OpsTarget,
} from "./commands.js";
import type { AdminAuth, AdminStore } from "./ports.js";

export const USAGE = `使い方: admin --project <projectId> [--operator <uid>] <command>

  verify <programId>                  原文とハッシュを表示し、対話で確認してから確認済みにする（--operator 必須）
  unverify <programId>                確認を取り消し、検索・表示の対象から外す（--operator 必須）
  ops stop|start [ai|collection]      運営スイッチを切り替える（省略時は両方）
  grant-admin <uid>                   ユーザーに admin クレームを付与する
  sources add --id <id> --url <url> --municipality-code <code> --level <national|tokyo|city>
              [--format html|pdf] [--category <c>] [--age-bands a,b] [--title <t>]
              [--related-source-id <id>] [--interval-hours <n>]
  sources import <file> [--dry-run]   JSON の配列から一括登録する（登録済みの URL は飛ばす）
  reembed [--to <version>]            原文抜粋から埋め込みを作り直す（既定は設定の版）
  reembed --verify [--to <version>]   検索対象のチャンクのベクトルを検査する
  reembed --cleanup --version <ver>   使っていない版の埋め込みを削除する
  embedding set-search-version <ver>  検索に使う版を切り替える（全チャンクがそろっていなければ拒否）

--project は必須です（操作対象を必ず明示します）。`;

// Google Cloud のプロジェクト ID の形式
const PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export type Connection = { store: AdminStore; auth: AdminAuth; embedder: () => Embedder };

export type CliDeps = {
  connect: (project: string) => Connection;
  out: (line: string) => void;
  err: (line: string) => void;
  prompt: (question: string) => Promise<string>;
  now: () => Date;
  readFile: (path: string) => Promise<string>;
  env: Readonly<Record<string, string | undefined>>;
  embedding: EmbeddingConfig;
  defaultIntervalHours: number;
};

const OPTIONS = {
  project: { type: "string" },
  operator: { type: "string" },
  to: { type: "string" },
  verify: { type: "boolean" },
  cleanup: { type: "boolean" },
  version: { type: "string" },
  "dry-run": { type: "boolean" },
  id: { type: "string" },
  url: { type: "string" },
  "municipality-code": { type: "string" },
  level: { type: "string" },
  format: { type: "string" },
  category: { type: "string" },
  "age-bands": { type: "string" },
  title: { type: "string" },
  "related-source-id": { type: "string" },
  "interval-hours": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];

function sourceInput(v: Values): Record<string, unknown> {
  const interval = v["interval-hours"];
  return {
    id: v.id,
    url: v.url,
    municipalityCode: v["municipality-code"],
    level: v.level,
    format: v.format,
    category: v.category,
    ageBands: v["age-bands"]
      ?.split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
    title: v.title,
    relatedSourceId: v["related-source-id"],
    // 数でなければそのまま渡し、検証で「無効」にする
    intervalHours: interval === undefined || !/^\d+$/.test(interval) ? interval : Number(interval),
  };
}

/** CLI を実行して終了コードを返す */
export async function runCli(argv: readonly string[], deps: CliDeps): Promise<number> {
  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true, strict: true });
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error));
    deps.err(USAGE);
    return EXIT_USAGE;
  }
  const { values, positionals } = parsed;
  if (values.help === true || positionals.length === 0) {
    deps.out(USAGE);
    return values.help === true ? EXIT_OK : EXIT_USAGE;
  }

  const project = values.project;
  if (project === undefined || !PROJECT_PATTERN.test(project)) {
    deps.err("--project <projectId> で操作対象のプロジェクトを指定してください。");
    return EXIT_USAGE;
  }
  // 環境変数と食い違うときは、取り違えを避けるために止める
  const fromEnvs = [
    ["GOOGLE_CLOUD_PROJECT", deps.env["GOOGLE_CLOUD_PROJECT"]],
    ["GCLOUD_PROJECT", deps.env["GCLOUD_PROJECT"]],
  ] as const;
  for (const [key, fromEnv] of fromEnvs) {
    if (fromEnv !== undefined && fromEnv !== "" && fromEnv !== project) {
      deps.err(`--project（${project}）と環境変数 ${key}（${fromEnv}）が異なるため中止しました。`);
      return EXIT_USAGE;
    }
  }
  const operator = values.operator ?? null;
  if (operator !== null && !UID_PATTERN.test(operator)) {
    deps.err("--operator の uid が不正です。");
    return EXIT_USAGE;
  }

  const [command, ...args] = positionals;
  const usage = (message: string): number => {
    deps.err(message);
    deps.err(USAGE);
    return EXIT_USAGE;
  };
  const one = (): string | null => (args.length === 1 ? (args[0] ?? null) : null);

  // 実行内容を決めてから接続する（使い方の誤りでは接続しない）
  let run: (ctx: CommandContext) => Promise<number>;
  switch (command) {
    case "verify":
    case "unverify": {
      const id = one();
      if (id === null) return usage(`${command} <programId> を指定してください。`);
      run = (ctx) => (command === "verify" ? verifyProgram(ctx, id) : unverifyProgram(ctx, id));
      break;
    }
    case "ops": {
      const [action, target = "all", ...rest] = args;
      if ((action !== "stop" && action !== "start") || rest.length > 0) {
        return usage("ops stop|start [ai|collection] を指定してください。");
      }
      if (target !== "ai" && target !== "collection" && target !== "all") {
        return usage("対象は ai か collection です（省略時は両方）。");
      }
      run = (ctx) => setOps(ctx, action, target as OpsTarget);
      break;
    }
    case "grant-admin": {
      const uid = one();
      if (uid === null || !UID_PATTERN.test(uid))
        return usage("grant-admin <uid> を指定してください。");
      run = (ctx) => grantAdmin(ctx, uid);
      break;
    }
    case "sources": {
      const [sub, ...rest] = args;
      if (sub === "add" && rest.length === 0) {
        run = (ctx) => addSource(ctx, sourceInput(values));
      } else if (sub === "import" && rest.length === 1 && rest[0] !== undefined) {
        const file = rest[0];
        run = (ctx) => importSources(ctx, file, values["dry-run"] === true);
      } else {
        return usage("sources add ... または sources import <file> を指定してください。");
      }
      break;
    }
    case "reembed": {
      if (args.length > 0) return usage("reembed は位置引数を取りません。");
      if (values.cleanup === true) {
        const version = values.version;
        if (version === undefined || values.verify === true || values.to !== undefined) {
          return usage("reembed --cleanup --version <version> を指定してください。");
        }
        run = (ctx) => cleanupEmbeddings(ctx, version);
      } else {
        const version = values.to ?? deps.embedding.version;
        run = (ctx) =>
          values.verify === true ? verifyEmbeddings(ctx, version) : reembed(ctx, version);
      }
      break;
    }
    case "embedding": {
      const [sub, version, ...rest] = args;
      if (sub !== "set-search-version" || version === undefined || rest.length > 0) {
        return usage("embedding set-search-version <version> を指定してください。");
      }
      run = (ctx) => setSearchVersion(ctx, version);
      break;
    }
    default:
      return usage(`不明なコマンドです: ${command ?? ""}`);
  }

  const emulator = deps.env["FIRESTORE_EMULATOR_HOST"];
  deps.out(
    `対象プロジェクト: ${project}` +
      (emulator !== undefined && emulator !== "" ? `（Emulator: ${emulator}）` : ""),
  );
  const conn = deps.connect(project);
  try {
    return await run({
      ...conn,
      out: deps.out,
      err: deps.err,
      prompt: deps.prompt,
      now: deps.now,
      readFile: deps.readFile,
      project,
      operator,
      embedding: deps.embedding,
      defaultIntervalHours: deps.defaultIntervalHours,
    });
  } catch (error) {
    // 途中で失敗した操作は、同じコマンドの再実行で完了できる
    deps.err(`失敗しました: ${error instanceof Error ? error.message : String(error)}`);
    deps.err("同じコマンドを再実行すると、残りの処理を完了できます。");
    return EXIT_FAILED;
  }
}
