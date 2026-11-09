// テスト用のインメモリ実装（Requirement 3.1, 3.5）

import type { EmbeddingTarget, OpsSwitch, SourceDoc } from "@hachioji-gov/shared";
import type {
  ChunkToWrite,
  Clock,
  CollectorStore,
  Embedder,
  Fetcher,
  FetchLog,
  FetchResult,
  OpsConfigStore,
  ProgramExtractor,
  ProgramRecord,
  SourcePatch,
} from "./ports.js";

// 保存されたチャンク（ベクトルは版ごとのフィールド名で持つ）
export type StoredChunk = Omit<ChunkToWrite, "embedding" | "searchable"> & {
  searchable: boolean;
  vectors: Record<string, number[]>;
};

export class MemoryStore implements CollectorStore {
  readonly sources = new Map<string, SourceDoc>();
  readonly programs = new Map<string, ProgramRecord>();
  readonly chunks = new Map<string, StoredChunk>();
  readonly logs: FetchLog[] = [];
  // テスト用: この名前の操作で例外を投げる
  failOn: Set<string> = new Set();

  constructor(sources: SourceDoc[] = []) {
    for (const s of sources) this.sources.set(s.id, structuredClone(s));
  }

  private check(op: string): void {
    if (this.failOn.has(op)) throw new Error(`injected failure: ${op}`);
  }

  async listSources(): Promise<SourceDoc[]> {
    this.check("listSources");
    return [...this.sources.values()].map((s) => structuredClone(s));
  }

  async updateSource(id: string, patch: SourcePatch): Promise<void> {
    this.check("updateSource");
    const s = this.sources.get(id);
    if (s !== undefined) this.sources.set(id, { ...s, ...patch });
  }

  async getProgram(id: string): Promise<ProgramRecord | null> {
    const p = this.programs.get(id);
    return p === undefined ? null : structuredClone(p);
  }

  async beginReplace(
    sourceId: string,
    programId: string,
    needsReview: boolean,
    at: string,
  ): Promise<void> {
    this.check("beginReplace");
    for (const c of this.chunksOf((c) => c.sourceId === sourceId)) c.searchable = false;
    const p = this.programs.get(programId);
    if (needsReview && p !== undefined) {
      this.programs.set(programId, { ...p, needsReview: true, updatedAt: at });
      for (const c of this.chunksOf((c) => c.programId === programId)) c.searchable = false;
    }
  }

  async saveProgram(program: ProgramRecord): Promise<void> {
    this.check("saveProgram");
    this.programs.set(program.id, structuredClone(program));
  }

  async upsertChunks(
    sourceId: string,
    chunks: ChunkToWrite[],
    target: EmbeddingTarget,
  ): Promise<void> {
    this.check("upsertChunks");
    const keep = new Set(chunks.map((c) => c.id));
    for (const { embedding, ...rest } of chunks) {
      this.chunks.set(rest.id, {
        ...structuredClone(rest),
        searchable: false,
        vectors: { [target.version]: [...embedding] },
      });
    }
    this.check("deleteOldChunks");
    for (const c of this.chunksOf((c) => c.sourceId === sourceId && !keep.has(c.id))) {
      this.chunks.delete(c.id);
    }
  }

  async setSearchable(programId: string, searchable: boolean): Promise<void> {
    for (const c of this.chunksOf((c) => c.programId === programId)) c.searchable = searchable;
  }

  async markExcluded(sourceId: string): Promise<void> {
    this.check("markExcluded");
    for (const c of this.chunksOf((c) => c.sourceId === sourceId)) c.searchable = false;
    const s = this.sources.get(sourceId);
    if (s !== undefined) this.sources.set(sourceId, { ...s, status: "excluded" });
    const p = this.programs.get(sourceId);
    if (p !== undefined) {
      this.programs.set(sourceId, { ...p, status: "excluded" });
      for (const c of this.chunksOf((c) => c.programId === sourceId)) c.searchable = false;
    }
  }

  async addFetchLog(log: FetchLog): Promise<void> {
    this.logs.push({ ...log });
  }

  private chunksOf(pred: (c: StoredChunk) => boolean): StoredChunk[] {
    return [...this.chunks.values()].filter(pred);
  }
}

/** URL ごとに決めた応答を返す。呼ばれた URL を記録する */
export class MemoryFetcher implements Fetcher {
  readonly calls: string[] = [];
  constructor(readonly responses: Map<string, FetchResult | FetchResult[]> = new Map()) {}

  async fetch(url: string): Promise<FetchResult> {
    this.calls.push(url);
    const r = this.responses.get(url);
    if (r === undefined) return { kind: "not_found", status: 404 };
    if (Array.isArray(r)) return r.length > 1 ? (r.shift() as FetchResult) : (r[0] as FetchResult);
    return r;
  }
}

/** 文字列から決まった単位ベクトルを作る埋め込み */
export class FakeEmbedder implements Embedder {
  calls = 0;
  fail = false;
  async embed(texts: string[], _task: string, model: EmbeddingTarget): Promise<number[][]> {
    this.calls += 1;
    if (this.fail) throw new Error("injected embed failure");
    return texts.map((t) => {
      const v = Array.from({ length: model.dimensions }, (_, i) =>
        i === 0 ? 1 : ((t.codePointAt(i % Math.max(1, t.length)) ?? 0) % 7) / 100,
      );
      const norm = Math.hypot(...v);
      return v.map((x) => x / norm);
    });
  }
}

export class FakeExtractor implements ProgramExtractor {
  fail = false;
  constructor(readonly result: unknown = { name: null }) {}
  async extractProgram(): Promise<unknown> {
    if (this.fail) throw new Error("injected extract failure");
    return structuredClone(this.result);
  }
}

export class FixedClock implements Clock {
  constructor(public time: Date) {}
  now(): Date {
    return new Date(this.time.getTime());
  }
}

/** 呼ばれるたびに順に値を返す運営スイッチ。最後の値は繰り返す。null は読み取り失敗 */
export class MemoryOps implements OpsConfigStore {
  reads = 0;
  constructor(readonly values: (OpsSwitch | null)[]) {}
  async read(): Promise<OpsSwitch> {
    const v = this.values[Math.min(this.reads, this.values.length - 1)];
    this.reads += 1;
    if (v === null || v === undefined) throw new Error("ops read failed");
    return v;
  }
}
