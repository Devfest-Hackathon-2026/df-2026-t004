// firebase/firestore.indexes.json を config/app.config.json から生成する（Requirement 4.7, 5.1, 13.13）
//
//   npm run gen-indexes
//
// - chunks のベクトル検索用の複合インデックスを、1つの埋め込み版あたり17本つくる
//   （shared の planSearchQueries が作る等価条件のクエリの組み合わせと1対1で対応する）
// - usage / usageUsers / deletionJobs の expireAt に TTL ポリシーを付ける
// - 出力は Prettier で整形してから書く（CI の index-consistency で、再生成との差分を検査する）
//
// 埋め込み版の移行中（v1 → v2）は、設定を v2 にして再生成し、`firebase deploy --only firestore:indexes`
// を --force なしで実行する。ファイルに無い v1 のインデックスは削除されずに残るので、合計34本になる。

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { appConfigSchema, SOURCE_AGE_BANDS } from "@hachioji-gov/shared";
import prettier from "prettier";

export type EmbeddingIndexSettings = {
  fieldPrefix: string;
  version: string;
  dimensions: number;
};

export type IndexField =
  | { fieldPath: string; order: "ASCENDING" }
  | { fieldPath: string; vectorConfig: { dimension: number; flat: Record<string, never> } };

export type CompositeIndex = {
  collectionGroup: string;
  queryScope: "COLLECTION";
  fields: IndexField[];
};

export type FieldOverride = {
  collectionGroup: string;
  fieldPath: string;
  ttl: boolean;
  indexes: never[];
};

export type IndexesFile = {
  indexes: CompositeIndex[];
  fieldOverrides: FieldOverride[];
};

// ベクトル検索の対象のコレクション
export const CHUNKS = "chunks";
// 1つの埋め込み版あたりのベクトルインデックスの本数（設計書「複合インデックスの本数」）
export const VECTOR_INDEXES_PER_VERSION = 17;
// Firestore のベクトルの次元の上限
export const MAX_VECTOR_DIMENSION = 2048;
// TTL ポリシーを付けるコレクション（expireAt は Firestore の Timestamp 型で保存する）
export const TTL_COLLECTIONS = ["usage", "usageUsers", "deletionJobs"] as const;
export const TTL_FIELD = "expireAt";

// API（packages/api/src/chat/firestore.ts）がフィールド名として受け付ける形と同じ
const FIELD_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/** 埋め込みのフィールド名（例: emb_v1）。API が受け付けない名前なら例外にする */
export function embeddingField(settings: EmbeddingIndexSettings): string {
  const field = `${settings.fieldPrefix}${settings.version}`;
  if (!FIELD_NAME.test(field)) {
    throw new RangeError(
      `埋め込みのフィールド名 "${field}" は使えません（英字で始まる英数字と _）`,
    );
  }
  return field;
}

/**
 * 検索の等価条件のフィールドの組（ベクトル以外）。
 * planSearchQueries の3つの形に合わせる:
 * - 年齢区分あり: municipalityCode, searchable, band_X [, category]（7区分 × カテゴリ有無 = 14）
 * - 年齢区分なし: municipalityCode, searchable [, category]（2）
 * - 制度限定: programId, searchable（1）
 */
export function equalityFieldSets(): string[][] {
  const sets: string[][] = [];
  for (const withCategory of [false, true]) {
    for (const band of SOURCE_AGE_BANDS) {
      sets.push(["municipalityCode", "searchable", `band_${band}`, ...cat(withCategory)]);
    }
  }
  for (const withCategory of [false, true]) {
    sets.push(["municipalityCode", "searchable", ...cat(withCategory)]);
  }
  sets.push(["programId", "searchable"]);
  return sets;
}

function cat(withCategory: boolean): string[] {
  return withCategory ? ["category"] : [];
}

/** 1つの埋め込み版の、chunks のベクトルインデックス（17本） */
export function vectorIndexes(settings: EmbeddingIndexSettings): CompositeIndex[] {
  if (!Number.isInteger(settings.dimensions) || settings.dimensions < 1) {
    throw new RangeError(`次元 ${settings.dimensions} は正の整数ではありません`);
  }
  if (settings.dimensions > MAX_VECTOR_DIMENSION) {
    throw new RangeError(`次元 ${settings.dimensions} は上限の ${MAX_VECTOR_DIMENSION} を超えます`);
  }
  const vector = embeddingField(settings);
  return equalityFieldSets().map((set) => ({
    collectionGroup: CHUNKS,
    queryScope: "COLLECTION",
    fields: [
      ...set.map((fieldPath): IndexField => ({ fieldPath, order: "ASCENDING" })),
      { fieldPath: vector, vectorConfig: { dimension: settings.dimensions, flat: {} } },
    ],
  }));
}

/** TTL ポリシー（expireAt は検索に使わないので、単一フィールドのインデックスも外す） */
export function ttlFieldOverrides(): FieldOverride[] {
  return TTL_COLLECTIONS.map((collectionGroup) => ({
    collectionGroup,
    fieldPath: TTL_FIELD,
    ttl: true,
    indexes: [],
  }));
}

export function buildIndexesFile(settings: EmbeddingIndexSettings): IndexesFile {
  return { indexes: vectorIndexes(settings), fieldOverrides: ttlFieldOverrides() };
}

/** app.config.json の内容から、インデックスの生成に使う設定を取り出す（共有の設定スキーマで検証する） */
export function embeddingSettingsFrom(raw: unknown): EmbeddingIndexSettings {
  const embedding: unknown =
    raw !== null && typeof raw === "object" ? Reflect.get(raw, "embedding") : undefined;
  const parsed = appConfigSchema.shape.embedding.safeParse(embedding);
  if (!parsed.success) {
    const keys = parsed.error.issues.map((i) => ["embedding", ...i.path.map(String)].join("."));
    throw new Error(`app.config.json の embedding が不正です: ${[...new Set(keys)].join(", ")}`);
  }
  const { fieldPrefix, version, dimensions } = parsed.data;
  return { fieldPrefix, version, dimensions };
}

const ROOT = new URL("../", import.meta.url);
export const CONFIG_PATH = fileURLToPath(new URL("config/app.config.json", ROOT));
export const INDEXES_PATH = fileURLToPath(new URL("firebase/firestore.indexes.json", ROOT));

export async function readEmbeddingSettings(path = CONFIG_PATH): Promise<EmbeddingIndexSettings> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- リポジトリ内の設定ファイル
  return embeddingSettingsFrom(JSON.parse(await readFile(path, "utf-8")) as unknown);
}

/** JSON を Prettier（リポジトリの設定）で整形した文字列にする */
export async function formatIndexesFile(file: IndexesFile, path = INDEXES_PATH): Promise<string> {
  const options = (await prettier.resolveConfig(path)) ?? {};
  return prettier.format(JSON.stringify(file, null, 2), { ...options, filepath: path });
}

async function main(): Promise<void> {
  const settings = await readEmbeddingSettings();
  const text = await formatIndexesFile(buildIndexesFile(settings));
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- リポジトリ内の固定パス
  await writeFile(INDEXES_PATH, text, "utf-8");
  console.log(
    `wrote ${VECTOR_INDEXES_PER_VERSION} vector indexes for ${embeddingField(settings)} ` +
      `(dimension ${settings.dimensions}) and ${TTL_COLLECTIONS.length} TTL policies`,
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
