// 収集の外部境界（Requirement 3.1, 3.5）。本番は HTTP・Vertex AI・Firestore、テストはインメモリ実装を使う。

import type {
  ChunkDraft,
  EmbeddingMeta,
  EmbeddingTarget,
  OpsSwitch,
  SourceAgeBand,
  SourceCategory,
  SourceDoc,
  SourceLevel,
} from "@hachioji-gov/shared";

export type FetchResult =
  | { kind: "ok"; status: number; contentType: string; body: Uint8Array }
  // 404 / 410。2回連続したら情報源を除外する
  | { kind: "not_found"; status: number }
  // 通信エラー・タイムアウト・5xx など。「見つからない」とは数えず、チャンクを保持する
  | { kind: "error"; reason: string; retryable: boolean };

export interface Fetcher {
  fetch(url: string, opts: { timeoutMs: number }): Promise<FetchResult>;
}

export type EmbeddingTask = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export interface Embedder {
  /** L2 正規化済みのベクトルを、texts と同じ順に返す */
  embed(texts: string[], task: EmbeddingTask, model: EmbeddingTarget): Promise<number[][]>;
}

export interface ProgramExtractor {
  /** 構造化抽出の生の結果（表示専用）。normalizeExtraction で正規化してから使う */
  extractProgram(text: string): Promise<unknown>;
}

export interface Clock {
  now(): Date;
}

export interface OpsConfigStore {
  /** config/operations を読む。読めないときは例外（呼び出し側で停止として扱う） */
  read(): Promise<OpsSwitch>;
}

// programs/{programId}。型は C の PR #73 の Program と同じ形にしてある（マージ後にそちらへ寄せる）
export type ProgramRecord = {
  id: string;
  sourceId: string;
  name: string;
  level: SourceLevel;
  municipalityCode: string;
  category: SourceCategory;
  ageBands: SourceAgeBand[];
  summary: string | null;
  eligibility: string | null;
  procedure: string | null;
  requiredDocs: string[] | null;
  deadline: string | null;
  contact: { name: string; phone?: string; url?: string } | null;
  sourceName: string | null;
  sourceUrl: string | null;
  fetchedAt: string | null;
  verified: boolean;
  verifiedAt?: string;
  verifiedBy?: string;
  verifiedContentHash?: string;
  contentHash: string;
  needsReview: boolean;
  status: "active" | "excluded";
  updatedAt: string;
};

// 書き込むチャンク。ベクトルは emb_{version}、記録は embeddingMeta[version] に保存する
export type ChunkToWrite = ChunkDraft & {
  embedding: number[];
  embeddingMeta: Record<string, EmbeddingMeta>;
};

export type FetchLogResult =
  "unchanged" | "replaced" | "not_found" | "excluded" | "error" | "deferred" | "skipped";

// fetchLogs/{logId}。出典URL・時刻・原因だけを記録し、個人情報は入れない
export type FetchLog = {
  sourceId: string;
  url: string;
  at: string;
  result: FetchLogResult;
  // 原因の識別子（例: "timeout"、"http_503"、"maxPagesPerRun"）
  reason?: string;
  // 書き込んだチャンク数など
  count?: number;
};

export type SourcePatch = Partial<Pick<SourceDoc, "lastFetchedAt" | "lastHash" | "missCount">>;

export interface CollectorStore {
  listSources(): Promise<SourceDoc[]>;
  updateSource(id: string, patch: SourcePatch): Promise<void>;
  getProgram(id: string): Promise<ProgramRecord | null>;
  /**
   * 置換の①。情報源の旧チャンクを searchable=false にする。needsReview が真なら、
   * 制度を needsReview にして、その制度のチャンクをすべて searchable=false にする。
   * ここより後で失敗しても、検索対象から外れる側（安全側）に倒れる。
   */
  beginReplace(
    sourceId: string,
    programId: string,
    needsReview: boolean,
    at: string,
  ): Promise<void>;
  /** 制度を書く（HTML の情報源の構造化情報と状態） */
  saveProgram(program: ProgramRecord): Promise<void>;
  /** 置換の②③。新チャンクを searchable=false で書き込んでから、情報源の旧チャンクを削除する */
  upsertChunks(sourceId: string, chunks: ChunkToWrite[], target: EmbeddingTarget): Promise<void>;
  /** 制度のチャンクの searchable をまとめて変える（運営者の確認で使う） */
  setSearchable(programId: string, searchable: boolean): Promise<void>;
  /** 情報源を除外し、そのチャンクを検索対象から外す。HTML の情報源なら制度も除外する */
  markExcluded(sourceId: string): Promise<void>;
  addFetchLog(log: FetchLog): Promise<void>;
}
