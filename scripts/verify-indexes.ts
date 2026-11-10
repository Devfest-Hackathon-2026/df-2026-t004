// デプロイ済みのインデックスと設定の一致を検査する（Requirement 13.14）
//
//   gcloud firestore indexes composite list --format=json > indexes.json
//   npm run verify-indexes -- --input indexes.json [--version v1]
//
// 標準入力からも読める（`gcloud ... --format=json | npm run verify-indexes`）。
// --version を省くと app.config.json の embedding.version を使う（検索中の版 searchVersion を渡す）。
// 検査する内容:
//   ① その版のベクトルフィールドを含むすべての複合インデックスの次元が、設定の embedding.dimensions と一致する
//   ② gen-indexes が作る17本の構成がすべて存在し、余分な構成が無い
//   ③ 17本の状態がすべて READY
// 不一致があれば、問題を列挙して非ゼロで終了する。

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  CHUNKS,
  embeddingField,
  readEmbeddingSettings,
  vectorIndexes,
  type CompositeIndex,
  type EmbeddingIndexSettings,
} from "./gen-indexes.js";

export type DeployedField = {
  fieldPath: string;
  order?: string;
  arrayConfig?: string;
  // ベクトルのとき。gcloud の出力では数値か文字列になりうるので数値に直す
  dimension?: number;
};

export type DeployedIndex = {
  name: string;
  collectionGroup: string;
  queryScope: string;
  state: string;
  fields: DeployedField[];
};

const NAME = /\/collectionGroups\/([^/]+)\/indexes\/([^/]+)$/;

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${what} がオブジェクトではありません`);
  }
  return value as Record<string, unknown>;
}

function str(obj: Record<string, unknown>, key: string, what: string): string {
  const value: unknown = Reflect.get(obj, key);
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`${what}.${key} が文字列ではありません`);
  }
  return value;
}

function parseField(raw: unknown, what: string): DeployedField {
  const obj = record(raw, what);
  const field: DeployedField = { fieldPath: str(obj, "fieldPath", what) };
  if (typeof obj["order"] === "string") field.order = obj["order"];
  if (typeof obj["arrayConfig"] === "string") field.arrayConfig = obj["arrayConfig"];
  if (obj["vectorConfig"] !== undefined) {
    const dim: unknown = record(obj["vectorConfig"], `${what}.vectorConfig`)["dimension"];
    const n = typeof dim === "string" && /^\d+$/.test(dim) ? Number(dim) : dim;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      throw new TypeError(`${what}.vectorConfig.dimension が正の整数ではありません`);
    }
    field.dimension = n;
  }
  return field;
}

/**
 * `gcloud firestore indexes composite list --format=json` の出力（JSON 文字列）を読む。
 * 形が崩れていれば例外にする（黙って読み飛ばすと、検査が素通りしてしまうため）。
 */
export function parseCompositeIndexList(text: string): DeployedIndex[] {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SyntaxError("gcloud の出力が JSON ではありません（--format=json を付けてください）");
  }
  if (!Array.isArray(json)) throw new TypeError("gcloud の出力が配列ではありません");
  return json.map((raw, i): DeployedIndex => {
    const what = `indexes[${i}]`;
    const obj = record(raw, what);
    const name = str(obj, "name", what);
    const match = NAME.exec(name);
    if (match?.[1] === undefined) throw new TypeError(`${what}.name の形が想定と異なります`);
    const fields = obj["fields"];
    if (!Array.isArray(fields)) throw new TypeError(`${what}.fields が配列ではありません`);
    return {
      name,
      collectionGroup: decodeURIComponent(match[1]),
      queryScope: typeof obj["queryScope"] === "string" ? obj["queryScope"] : "COLLECTION",
      state: typeof obj["state"] === "string" ? obj["state"] : "STATE_UNSPECIFIED",
      fields: fields.map((f, j) => parseField(f, `${what}.fields[${j}]`)),
    };
  });
}

/**
 * インデックスの構成を比べるための鍵。等価条件のフィールドは順序を問わない。
 * Firestore が末尾に付ける __name__ は無視する。
 */
function shapeKey(
  collectionGroup: string,
  queryScope: string,
  fields: readonly { fieldPath: string; order?: string; dimension?: number }[],
  vectorField: string,
): string {
  const scalar = fields
    .filter((f) => f.fieldPath !== "__name__" && f.fieldPath !== vectorField)
    .map((f) => `${f.fieldPath}:${f.order ?? "?"}`)
    .sort();
  const vectors = fields.filter((f) => f.fieldPath === vectorField).length;
  return `${collectionGroup}|${queryScope}|${scalar.join(",")}|vector*${vectors}`;
}

function expectedFields(index: CompositeIndex): DeployedField[] {
  return index.fields.map((f) =>
    "order" in f
      ? { fieldPath: f.fieldPath, order: f.order }
      : { fieldPath: f.fieldPath, dimension: f.vectorConfig.dimension },
  );
}

export type VerifyResult = { ok: boolean; problems: string[]; matched: number };

/** デプロイ済みのインデックスが、設定から生成した17本と一致するかを検査する（純粋関数） */
export function verifyIndexes(
  deployed: readonly DeployedIndex[],
  settings: EmbeddingIndexSettings,
): VerifyResult {
  const vectorField = embeddingField(settings);
  const expected = vectorIndexes(settings);
  const problems: string[] = [];
  const relevant = deployed.filter((d) => d.fields.some((f) => f.fieldPath === vectorField));

  // ① 次元
  for (const d of relevant) {
    for (const f of d.fields) {
      if (f.fieldPath === vectorField && f.dimension !== settings.dimensions) {
        problems.push(
          `${d.name}: ${vectorField} の次元が ${f.dimension ?? "（ベクトルでない）"} で、設定の ${settings.dimensions} と異なります`,
        );
      }
    }
  }

  // ② 本数と構成、③ 状態
  const byKey = new Map<string, DeployedIndex[]>();
  for (const d of relevant) {
    const key = shapeKey(d.collectionGroup, d.queryScope, d.fields, vectorField);
    byKey.set(key, [...(byKey.get(key) ?? []), d]);
  }
  const expectedKeys = new Set<string>();
  let matched = 0;
  for (const e of expected) {
    const key = shapeKey(e.collectionGroup, e.queryScope, expectedFields(e), vectorField);
    expectedKeys.add(key);
    const label = e.fields.map((f) => f.fieldPath).join(", ");
    const found = byKey.get(key) ?? [];
    if (found.length === 0) {
      problems.push(`不足: ${e.collectionGroup}(${label})`);
      continue;
    }
    matched += 1;
    if (!found.some((d) => d.state === "READY")) {
      const states = found.map((d) => d.state).join("/");
      problems.push(`READY でない: ${e.collectionGroup}(${label}) の状態は ${states}`);
    }
  }
  for (const [key, list] of byKey) {
    if (!expectedKeys.has(key)) {
      for (const d of list) {
        const label = d.fields.map((f) => f.fieldPath).join(", ");
        problems.push(`想定外: ${d.name}(${label}) は gen-indexes の構成にありません`);
      }
    }
  }
  if (!relevant.some((d) => d.collectionGroup === CHUNKS)) {
    problems.push(`${CHUNKS} に ${vectorField} のインデックスが1本もありません`);
  }
  return { ok: problems.length === 0, problems, matched };
}

export type CliArgs = { input?: string; version?: string };

export function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {};
  const rest = [...argv];
  while (rest.length > 0) {
    const flag = rest.shift();
    const value = rest.shift();
    if (flag === "--input" && value !== undefined) {
      args.input = value;
    } else if (flag === "--version" && value !== undefined) {
      args.version = value;
    } else {
      throw new Error(`不明な引数です: ${flag}（使えるのは --input <file> と --version <v>）`);
    }
  }
  return args;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf-8");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = await readEmbeddingSettings();
  const settings = { ...config, version: args.version ?? config.version };
  const text =
    args.input === undefined
      ? await readStdin()
      : // eslint-disable-next-line security/detect-non-literal-fs-filename -- 運用者が指定した gcloud の出力
        await readFile(args.input, "utf-8");
  const result = verifyIndexes(parseCompositeIndexList(text), settings);
  if (result.ok) {
    console.log(
      `OK: ${embeddingField(settings)} の ${result.matched} 本がすべて READY で、次元は ${settings.dimensions} です`,
    );
    return;
  }
  for (const p of result.problems) console.error(`NG: ${p}`);
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
