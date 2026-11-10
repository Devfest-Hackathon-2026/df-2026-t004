// 実環境の Firestore で、等価条件だけの事前フィルタつきベクトル検索が動くかを確かめる（U-1、UW-GC-9）
//
//   GOOGLE_CLOUD_PROJECT=<project> npm run probe-vector-search [-- --version v1]
//
// gen-indexes が作る17本のインデックスと同じ等価条件の組で、API（packages/api/src/chat/firestore.ts）と
// 同じ形の findNearest を1回ずつ実行する。対応するインデックスが無い・READY でないときは
// Firestore がエラー（FAILED_PRECONDITION）を返すので、それを NG として列挙して非ゼロで終了する。
// 読み取りだけで、何も書き込まない。結果の件数は問わない（chunks が空でも、インデックスが使えれば成功）。

import { pathToFileURL } from "node:url";
import { initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore, type Query } from "firebase-admin/firestore";
import {
  CHUNKS,
  embeddingField,
  equalityFieldSets,
  readEmbeddingSettings,
  type EmbeddingIndexSettings,
} from "./gen-indexes.js";

export type ProbeQuery = {
  // 表示用（例: municipalityCode, searchable, band_age_0_2）
  label: string;
  filters: Record<string, string | boolean>;
};

export type ProbeOutcome =
  | { label: string; ok: true; count: number }
  | {
      label: string;
      ok: false;
      error: string;
    };

/** 等価条件の値。インデックスが使えるかだけを見るので、実在する値である必要はない */
function probeValue(field: string): string | boolean {
  if (field === "searchable" || field.startsWith("band_")) return true;
  if (field === "municipalityCode") return "000000";
  return "probe";
}

/** gen-indexes の17本と1対1で対応する、確認用のクエリ */
export function probeQueries(): ProbeQuery[] {
  return equalityFieldSets().map((set) => ({
    label: set.join(", "),
    filters: Object.fromEntries(set.map((field) => [field, probeValue(field)])),
  }));
}

/** 長さ dimensions の単位ベクトル（API の埋め込みと同じく L2 正規化済み） */
export function unitVector(dimensions: number): number[] {
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new RangeError(`次元 ${dimensions} は正の整数ではありません`);
  }
  return Array.from({ length: dimensions }, (_, i) => (i === 0 ? 1 : 0));
}

/** エラーの1行目だけを返す（Firestore のエラーは、インデックス作成の URL などを含む長い文になる） */
export function firstLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0] ?? text;
}

export async function probe(
  db: Firestore,
  settings: EmbeddingIndexSettings,
): Promise<ProbeOutcome[]> {
  const vectorField = embeddingField(settings);
  const queryVector = unitVector(settings.dimensions);
  const outcomes: ProbeOutcome[] = [];
  // 失敗の理由を1本ずつ見たいので、並列にせず順に実行する
  for (const q of probeQueries()) {
    let query: Query = db.collection(CHUNKS);
    for (const [key, value] of Object.entries(q.filters)) query = query.where(key, "==", value);
    try {
      const snap = await query
        .findNearest({
          vectorField,
          queryVector,
          limit: 5,
          distanceMeasure: "DOT_PRODUCT",
          distanceThreshold: 0,
          distanceResultField: "__similarity",
        })
        .get();
      outcomes.push({ label: q.label, ok: true, count: snap.size });
    } catch (error) {
      outcomes.push({ label: q.label, ok: false, error: firstLine(error) });
    }
  }
  return outcomes;
}

export function parseArgs(argv: readonly string[]): { version?: string } {
  const args: { version?: string } = {};
  const rest = [...argv];
  while (rest.length > 0) {
    const flag = rest.shift();
    const value = rest.shift();
    if (flag === "--version" && value !== undefined) {
      args.version = value;
    } else {
      throw new Error(`不明な引数です: ${flag}（使えるのは --version <v>）`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const config = await readEmbeddingSettings();
  const settings = { ...config, version: args.version ?? config.version };
  const project = process.env["GOOGLE_CLOUD_PROJECT"];
  if (
    (project === undefined || project === "") &&
    process.env["FIRESTORE_EMULATOR_HOST"] === undefined
  ) {
    throw new Error("環境変数 GOOGLE_CLOUD_PROJECT が必要です");
  }
  const db = getFirestore(initializeApp(project === undefined ? {} : { projectId: project }));
  const outcomes = await probe(db, settings);
  for (const o of outcomes) {
    if (o.ok) console.log(`OK: [${o.label}] ${o.count} 件`);
    else console.error(`NG: [${o.label}] ${o.error}`);
  }
  const failed = outcomes.filter((o) => !o.ok).length;
  if (failed === 0) {
    console.log(
      `OK: ${embeddingField(settings)} の等価条件つきベクトル検索 ${outcomes.length} 通りがすべて実行できました`,
    );
    return;
  }
  console.error(`NG: ${outcomes.length} 通りのうち ${failed} 通りが失敗しました`);
  process.exitCode = 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(firstLine(error));
    process.exitCode = 1;
  });
}
