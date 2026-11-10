// Firestore と Firebase Auth の実装（Admin SDK）。
// 制度・チャンク・config/* はクライアントから書き込めない（Security Rules で全拒否）ため、運営者の資格情報で書く。

import type { Auth } from "firebase-admin/auth";
import {
  FieldPath,
  FieldValue,
  type DocumentData,
  type Firestore,
  type Query,
  type QueryDocumentSnapshot,
  type WriteBatch,
} from "firebase-admin/firestore";
import { FirestoreCollectorStore, FirestoreOpsConfigStore } from "@hachioji-gov/collector";
import {
  decodeProgram,
  type EmbeddingMeta,
  type OpsSwitch,
  type Program,
  type SourceDoc,
} from "@hachioji-gov/shared";
import {
  VERSION_PATTERN,
  type AdminAuth,
  type AdminStore,
  type ChunkExcerpt,
  type ProgramStamp,
  type ReembedChunk,
  type SourceRef,
  type StoredVector,
  type VerificationFields,
} from "./ports.js";

// 一覧を読むときの1ページの件数
const PAGE_SIZE = 300;
// gRPC の状態コード
const NOT_FOUND = 5;
const ALREADY_EXISTS = 6;

export type FirestoreAdminOptions = {
  fieldPrefix: string;
  // バッチの確定（テストで途中の失敗を起こすために差し替える）
  commit?: (batch: WriteBatch) => Promise<unknown>;
};

function codeOf(error: unknown): unknown {
  return error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined;
}

function assertVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) throw new RangeError("invalid embedding version");
}

function metaRecord(value: unknown): Record<string, EmbeddingMeta> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, EmbeddingMeta> = {};
  for (const [version, meta] of Object.entries(value as Record<string, unknown>)) {
    if (!VERSION_PATTERN.test(version) || meta === null || typeof meta !== "object") continue;
    const { model, dimensions, createdAt } = meta as Record<string, unknown>;
    if (typeof model === "string" && typeof dimensions === "number") {
      Object.defineProperty(out, version, {
        value: { model, dimensions, createdAt: typeof createdAt === "string" ? createdAt : "" },
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return out;
}

function vectorOf(value: unknown): number[] | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const toArray: unknown = Reflect.get(value, "toArray");
  return typeof toArray === "function" ? (toArray.call(value) as number[]) : undefined;
}

export class FirestoreAdminStore implements AdminStore {
  private readonly chunkWriter: FirestoreCollectorStore;
  private readonly opsReader: FirestoreOpsConfigStore;

  constructor(
    private readonly db: Firestore,
    private readonly options: FirestoreAdminOptions,
  ) {
    // チャンクの searchable の一括更新と、運営スイッチの読み取りは collector の実装を使う
    this.chunkWriter = new FirestoreCollectorStore(db, {
      fieldPrefix: options.fieldPrefix,
      ...(options.commit === undefined ? {} : { commit: options.commit }),
    });
    this.opsReader = new FirestoreOpsConfigStore(db);
  }

  private field(version: string): string {
    assertVersion(version);
    return `${this.options.fieldPrefix}${version}`;
  }

  async getProgram(id: string): Promise<Program | null> {
    const snap = await this.db.collection("programs").doc(id).get();
    if (!snap.exists) return null;
    const decoded = decodeProgram(snap.id, snap.data());
    if (!decoded.ok) {
      throw new TypeError(`programs/${id} の形が不正です: ${decoded.errors.join(", ")}`);
    }
    return decoded.value;
  }

  async listProgramChunks(programId: string): Promise<ChunkExcerpt[]> {
    const snap = await this.db
      .collection("chunks")
      .where("programId", "==", programId)
      .select("excerpt", "heading", "pdfPage", "sourceUrl", "searchable")
      .get();
    return snap.docs
      .map((d) => {
        const heading: unknown = d.get("heading");
        const pdfPage: unknown = d.get("pdfPage");
        return {
          id: d.id,
          excerpt: String(d.get("excerpt") ?? ""),
          sourceUrl: String(d.get("sourceUrl") ?? ""),
          searchable: d.get("searchable") === true,
          ...(typeof heading === "string" ? { heading } : {}),
          ...(typeof pdfPage === "number" ? { pdfPage } : {}),
        };
      })
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  async saveVerification(
    programId: string,
    fields: VerificationFields,
    expected: ProgramStamp | null,
  ): Promise<boolean> {
    const ref = this.db.collection("programs").doc(programId);
    const data: DocumentData = {
      verified: fields.verified,
      needsReview: fields.needsReview,
      updatedAt: fields.updatedAt,
      verifiedAt: fields.verifiedAt ?? FieldValue.delete(),
      verifiedBy: fields.verifiedBy ?? FieldValue.delete(),
      verifiedContentHash: fields.verifiedContentHash ?? FieldValue.delete(),
    };
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return false;
      if (
        expected !== null &&
        (snap.get("contentHash") !== expected.contentHash ||
          snap.get("updatedAt") !== expected.updatedAt)
      ) {
        return false;
      }
      tx.update(ref, data);
      return true;
    });
  }

  async setChunksSearchable(programId: string, searchable: boolean): Promise<void> {
    await this.chunkWriter.setSearchable(programId, searchable);
  }

  async readOps(): Promise<OpsSwitch | null> {
    try {
      return await this.opsReader.read();
    } catch {
      return null;
    }
  }

  async updateOps(change: Partial<OpsSwitch>, by: string, at: string): Promise<OpsSwitch> {
    const ref = this.db.collection("config").doc("operations");
    return this.db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = (key: keyof OpsSwitch): boolean => snap.get(key) === true;
      const value: OpsSwitch = {
        aiEnabled: change.aiEnabled ?? current("aiEnabled"),
        collectionEnabled: change.collectionEnabled ?? current("collectionEnabled"),
      };
      tx.set(ref, { ...value, updatedAt: at, updatedBy: by });
      return value;
    });
  }

  async listSources(): Promise<SourceRef[]> {
    const snap = await this.db.collection("sources").select("url").get();
    return snap.docs.map((d) => ({ id: d.id, url: String(d.get("url") ?? "") }));
  }

  async createSource(source: SourceDoc): Promise<"created" | "exists"> {
    const { id, ...data } = source;
    try {
      // create は同じ ID があると失敗する（既存の登録を上書きしない）
      await this.db.collection("sources").doc(id).create(data);
      return "created";
    } catch (error) {
      if (codeOf(error) === ALREADY_EXISTS) return "exists";
      throw error;
    }
  }

  /** チャンクを ID 順にページ単位で読む */
  private async *pages(fields: string[]): AsyncGenerator<QueryDocumentSnapshot> {
    let last: QueryDocumentSnapshot | undefined;
    for (;;) {
      let q: Query = this.db
        .collection("chunks")
        .orderBy(FieldPath.documentId())
        .select(...fields)
        .limit(PAGE_SIZE);
      if (last !== undefined) q = q.startAfter(last);
      const snap = await q.get();
      yield* snap.docs;
      if (snap.docs.length < PAGE_SIZE) return;
      last = snap.docs.at(-1);
    }
  }

  async listChunksForReembed(): Promise<ReembedChunk[]> {
    const out: ReembedChunk[] = [];
    for await (const d of this.pages(["excerpt", "searchable", "embeddingMeta"])) {
      out.push({
        id: d.id,
        excerpt: String(d.get("excerpt") ?? ""),
        searchable: d.get("searchable") === true,
        embeddingMeta: metaRecord(d.get("embeddingMeta")),
      });
    }
    return out;
  }

  async writeEmbedding(
    chunkId: string,
    version: string,
    vector: number[],
    meta: EmbeddingMeta,
  ): Promise<boolean> {
    const field = this.field(version);
    try {
      // excerpt や searchable には触れない
      await this.db
        .collection("chunks")
        .doc(chunkId)
        .update(field, FieldValue.vector(vector), new FieldPath("embeddingMeta", version), {
          model: meta.model,
          dimensions: meta.dimensions,
          createdAt: meta.createdAt,
        });
      return true;
    } catch (error) {
      if (codeOf(error) === NOT_FOUND) return false;
      throw error;
    }
  }

  async listVectors(version: string): Promise<StoredVector[]> {
    const field = this.field(version);
    const out: StoredVector[] = [];
    for await (const d of this.pages(["searchable", "embeddingMeta", field])) {
      const metas = metaRecord(d.get("embeddingMeta"));
      out.push({
        id: d.id,
        searchable: d.get("searchable") === true,
        meta: Object.prototype.hasOwnProperty.call(metas, version)
          ? (Reflect.get(metas, version) as EmbeddingMeta)
          : undefined,
        vector: vectorOf(d.get(field)),
      });
    }
    return out;
  }

  async removeEmbedding(version: string): Promise<number> {
    const field = this.field(version);
    const metaPath = new FieldPath("embeddingMeta", version);
    let count = 0;
    let batch = this.db.batch();
    let pending = 0;
    const commit = this.options.commit ?? ((b: WriteBatch) => b.commit());
    for await (const d of this.pages(["embeddingMeta", field])) {
      const metas = metaRecord(d.get("embeddingMeta"));
      const has =
        Object.prototype.hasOwnProperty.call(metas, version) || d.get(field) !== undefined;
      if (!has) continue;
      batch.update(d.ref, field, FieldValue.delete(), metaPath, FieldValue.delete());
      pending += 1;
      count += 1;
      if (pending >= PAGE_SIZE) {
        await commit(batch);
        batch = this.db.batch();
        pending = 0;
      }
    }
    if (pending > 0) await commit(batch);
    return count;
  }

  async getSearchVersion(): Promise<string | null> {
    const version: unknown = (await this.db.collection("config").doc("embedding").get()).get(
      "searchVersion",
    );
    return typeof version === "string" && VERSION_PATTERN.test(version) ? version : null;
  }

  async setSearchVersion(version: string, by: string, at: string): Promise<void> {
    assertVersion(version);
    await this.db
      .collection("config")
      .doc("embedding")
      .set({ searchVersion: version, updatedAt: at, updatedBy: by });
  }
}

export class FirebaseAdminAuth implements AdminAuth {
  constructor(private readonly auth: Auth) {}

  private async claimsOf(uid: string): Promise<Record<string, unknown> | null> {
    try {
      const user = await this.auth.getUser(uid);
      return { ...(user.customClaims ?? {}) };
    } catch (error) {
      if (codeOf(error) === "auth/user-not-found") return null;
      throw error;
    }
  }

  async getClaims(uid: string): Promise<Record<string, unknown> | null> {
    return this.claimsOf(uid);
  }

  async grantAdmin(uid: string): Promise<boolean> {
    const claims = await this.claimsOf(uid);
    if (claims === null) return false;
    // 既存のクレームを保ったまま admin を付ける
    await this.auth.setCustomUserClaims(uid, { ...claims, admin: true });
    return true;
  }
}
