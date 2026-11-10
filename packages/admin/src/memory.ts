// テスト用のインメモリ実装

import type { EmbeddingMeta, OpsSwitch, Program, SourceDoc } from "@hachioji-gov/shared";
import type {
  AdminAuth,
  AdminStore,
  ChunkExcerpt,
  ProgramStamp,
  ReembedChunk,
  SourceRef,
  StoredVector,
  VerificationFields,
} from "./ports.js";

export type MemoryChunk = ChunkExcerpt & {
  programId: string;
  embeddingMeta: Record<string, EmbeddingMeta>;
  vectors: Record<string, number[]>;
};

const VERIFICATION_KEYS = new Set(["verifiedAt", "verifiedBy", "verifiedContentHash"]);

export class MemoryAdminStore implements AdminStore {
  readonly programs = new Map<string, Program>();
  readonly chunks = new Map<string, MemoryChunk>();
  readonly sources = new Map<string, SourceDoc>();
  ops: (OpsSwitch & { updatedAt?: string; updatedBy?: string }) | null = null;
  searchVersion: string | null = null;
  // テスト用: この名前の操作で例外を投げる（回数を指定すると、その回数だけ）
  readonly failOn = new Map<string, number>();

  private check(op: string): void {
    const left = this.failOn.get(op);
    if (left === undefined || left <= 0) return;
    this.failOn.set(op, left - 1);
    throw new Error(`injected failure: ${op}`);
  }

  async getProgram(id: string): Promise<Program | null> {
    this.check("getProgram");
    const p = this.programs.get(id);
    return p === undefined ? null : structuredClone(p);
  }

  async listProgramChunks(programId: string): Promise<ChunkExcerpt[]> {
    return [...this.chunks.values()]
      .filter((c) => c.programId === programId)
      .map((c) => ({
        id: c.id,
        excerpt: c.excerpt,
        sourceUrl: c.sourceUrl,
        searchable: c.searchable,
        ...(c.heading === undefined ? {} : { heading: c.heading }),
        ...(c.pdfPage === undefined ? {} : { pdfPage: c.pdfPage }),
      }));
  }

  async saveVerification(
    programId: string,
    fields: VerificationFields,
    expected: ProgramStamp | null,
  ): Promise<boolean> {
    this.check("saveVerification");
    const p = this.programs.get(programId);
    if (p === undefined) return false;
    if (
      expected !== null &&
      (p.contentHash !== expected.contentHash || p.updatedAt !== expected.updatedAt)
    ) {
      return false;
    }
    const rest = Object.fromEntries(
      Object.entries(p).filter(([k]) => !VERIFICATION_KEYS.has(k)),
    ) as Omit<Program, "verifiedAt" | "verifiedBy" | "verifiedContentHash">;
    const next: Program = {
      ...rest,
      verified: fields.verified,
      needsReview: fields.needsReview,
      updatedAt: fields.updatedAt,
      ...(fields.verifiedAt === undefined ? {} : { verifiedAt: fields.verifiedAt }),
      ...(fields.verifiedBy === undefined ? {} : { verifiedBy: fields.verifiedBy }),
      ...(fields.verifiedContentHash === undefined
        ? {}
        : { verifiedContentHash: fields.verifiedContentHash }),
    };
    this.programs.set(programId, next);
    return true;
  }

  async setChunksSearchable(programId: string, searchable: boolean): Promise<void> {
    this.check("setChunksSearchable");
    for (const c of this.chunks.values()) {
      if (c.programId === programId) c.searchable = searchable;
    }
  }

  async readOps(): Promise<OpsSwitch | null> {
    return this.ops === null
      ? null
      : { aiEnabled: this.ops.aiEnabled, collectionEnabled: this.ops.collectionEnabled };
  }

  async updateOps(change: Partial<OpsSwitch>, by: string, at: string): Promise<OpsSwitch> {
    this.check("updateOps");
    const value: OpsSwitch = {
      aiEnabled: change.aiEnabled ?? this.ops?.aiEnabled ?? false,
      collectionEnabled: change.collectionEnabled ?? this.ops?.collectionEnabled ?? false,
    };
    this.ops = { ...value, updatedAt: at, updatedBy: by };
    return value;
  }

  async listSources(): Promise<SourceRef[]> {
    return [...this.sources.values()].map((s) => ({ id: s.id, url: s.url }));
  }

  async createSource(source: SourceDoc): Promise<"created" | "exists"> {
    this.check("createSource");
    if (this.sources.has(source.id)) return "exists";
    this.sources.set(source.id, structuredClone(source));
    return "created";
  }

  async listChunksForReembed(): Promise<ReembedChunk[]> {
    return [...this.chunks.values()].map((c) => ({
      id: c.id,
      excerpt: c.excerpt,
      searchable: c.searchable,
      embeddingMeta: structuredClone(c.embeddingMeta),
    }));
  }

  async writeEmbedding(
    chunkId: string,
    version: string,
    vector: number[],
    meta: EmbeddingMeta,
  ): Promise<boolean> {
    this.check("writeEmbedding");
    const c = this.chunks.get(chunkId);
    if (c === undefined) return false;
    c.vectors = { ...c.vectors, [version]: [...vector] };
    c.embeddingMeta = { ...c.embeddingMeta, [version]: { ...meta } };
    return true;
  }

  async listVectors(version: string): Promise<StoredVector[]> {
    return [...this.chunks.values()].map((c) => ({
      id: c.id,
      searchable: c.searchable,
      meta: Object.prototype.hasOwnProperty.call(c.embeddingMeta, version)
        ? (Reflect.get(c.embeddingMeta, version) as EmbeddingMeta)
        : undefined,
      vector: Object.prototype.hasOwnProperty.call(c.vectors, version)
        ? (Reflect.get(c.vectors, version) as number[])
        : undefined,
    }));
  }

  async removeEmbedding(version: string): Promise<number> {
    let count = 0;
    for (const c of this.chunks.values()) {
      const has =
        Object.prototype.hasOwnProperty.call(c.embeddingMeta, version) ||
        Object.prototype.hasOwnProperty.call(c.vectors, version);
      if (!has) continue;
      c.embeddingMeta = Object.fromEntries(
        Object.entries(c.embeddingMeta).filter(([v]) => v !== version),
      );
      c.vectors = Object.fromEntries(Object.entries(c.vectors).filter(([v]) => v !== version));
      count += 1;
    }
    return count;
  }

  async getSearchVersion(): Promise<string | null> {
    return this.searchVersion;
  }

  async setSearchVersion(version: string): Promise<void> {
    this.check("setSearchVersion");
    this.searchVersion = version;
  }
}

export class MemoryAdminAuth implements AdminAuth {
  readonly users = new Map<string, Record<string, unknown>>();

  async getClaims(uid: string): Promise<Record<string, unknown> | null> {
    const claims = this.users.get(uid);
    return claims === undefined ? null : { ...claims };
  }

  async grantAdmin(uid: string): Promise<boolean> {
    const claims = this.users.get(uid);
    if (claims === undefined) return false;
    this.users.set(uid, { ...claims, admin: true });
    return true;
  }
}
