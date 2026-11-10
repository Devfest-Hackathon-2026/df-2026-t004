// 運営者 CLI の外部境界（Requirement 3.13〜3.16, 13.4, 13.5, 13.11, 13.14）
// 本番は Firestore と Firebase Auth（Admin SDK）、テストはインメモリ実装を使う。

import type { EmbeddingMeta, OpsSwitch, Program, SourceDoc } from "@hachioji-gov/shared";

// 版の名前（emb_{version} と embeddingMeta のキー）。__proto__ などをキーにさせない
export const VERSION_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

/** 確認の画面に出す原文抜粋 */
export type ChunkExcerpt = {
  id: string;
  heading?: string;
  pdfPage?: number;
  excerpt: string;
  sourceUrl: string;
  searchable: boolean;
};

/** 確認状態の書き込み。undefined の項目は削除する */
export type VerificationFields = {
  verified: boolean;
  verifiedAt: string | undefined;
  verifiedBy: string | undefined;
  verifiedContentHash: string | undefined;
  needsReview: boolean;
  updatedAt: string;
};

/** 表示してから書き込むまでに制度が変わっていないかを確かめるための値 */
export type ProgramStamp = { contentHash: string; updatedAt: string };

/** 再生成の対象を選ぶためのチャンク（ベクトル本体は読まない） */
export type ReembedChunk = {
  id: string;
  excerpt: string;
  searchable: boolean;
  embeddingMeta: Record<string, EmbeddingMeta>;
};

/** 検証のために読む、ある版のベクトル */
export type StoredVector = {
  id: string;
  searchable: boolean;
  meta: EmbeddingMeta | undefined;
  vector: number[] | undefined;
};

export type SourceRef = { id: string; url: string };

export interface AdminStore {
  /** 形が不正な文書は例外 */
  getProgram(id: string): Promise<Program | null>;
  listProgramChunks(programId: string): Promise<ChunkExcerpt[]>;
  /**
   * 確認状態を書く。expected があれば、制度の contentHash と updatedAt が一致するときだけ書く。
   * 一致しない（または制度が無い）ときは書かずに false を返す。
   */
  saveVerification(
    programId: string,
    fields: VerificationFields,
    expected: ProgramStamp | null,
  ): Promise<boolean>;
  /** 制度のチャンクの searchable をまとめて変える（collector の実装を再利用する） */
  setChunksSearchable(programId: string, searchable: boolean): Promise<void>;

  /** config/operations を読む。無い・形が違うときは null */
  readOps(): Promise<OpsSwitch | null>;
  /** config/operations を変える。無い項目は停止（false）として補う */
  updateOps(change: Partial<OpsSwitch>, by: string, at: string): Promise<OpsSwitch>;

  /** 登録済みの情報源（除外済みを含む） */
  listSources(): Promise<SourceRef[]>;
  /** 新規に登録する。同じ ID があれば変えずに "exists" */
  createSource(source: SourceDoc): Promise<"created" | "exists">;

  listChunksForReembed(): Promise<ReembedChunk[]>;
  /** emb_{version} と embeddingMeta[version] だけを書く。チャンクが無ければ false */
  writeEmbedding(
    chunkId: string,
    version: string,
    vector: number[],
    meta: EmbeddingMeta,
  ): Promise<boolean>;
  listVectors(version: string): Promise<StoredVector[]>;
  /** emb_{version} と embeddingMeta[version] を全チャンクから消す。消した件数を返す */
  removeEmbedding(version: string): Promise<number>;

  /** config/embedding の searchVersion。無い・不正なら null */
  getSearchVersion(): Promise<string | null>;
  setSearchVersion(version: string, by: string, at: string): Promise<void>;
}

export interface AdminAuth {
  /** ユーザーのカスタムクレーム。ユーザーが無ければ null */
  getClaims(uid: string): Promise<Record<string, unknown> | null>;
  /** 既存のクレームを保ったまま admin: true を付ける。ユーザーが無ければ false */
  grantAdmin(uid: string): Promise<boolean>;
}
