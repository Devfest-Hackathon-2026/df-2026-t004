// Firestore 版の書き込み（Requirement 3.3, 3.4, 3.6, 3.15, 13.13）
// 書き込みは Admin SDK だけで行う（Security Rules でクライアントからは全拒否）。

import {
  FieldValue,
  type DocumentReference,
  type Firestore,
  type WriteBatch,
} from "firebase-admin/firestore";
import type { EmbeddingTarget, OpsSwitch, SourceDoc } from "@hachioji-gov/shared";
import type {
  ChunkToWrite,
  CollectorStore,
  FetchLog,
  OpsConfigStore,
  ProgramRecord,
  SourcePatch,
} from "./ports.js";

// 1回のバッチ書き込みの件数（Firestore の上限 500 より少なくする）
export const BATCH_SIZE = 400;

export type FirestoreStoreOptions = {
  // 埋め込みのフィールド名の接頭辞（設定の embedding.fieldPrefix。例: "emb_"）
  fieldPrefix: string;
  batchSize?: number;
  // バッチの確定（テストで途中の失敗を起こすために差し替える）
  commit?: (batch: WriteBatch) => Promise<unknown>;
};

const VERSION_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

export class FirestoreCollectorStore implements CollectorStore {
  private readonly batchSize: number;
  private readonly commit: (batch: WriteBatch) => Promise<unknown>;

  constructor(
    private readonly db: Firestore,
    private readonly options: FirestoreStoreOptions,
  ) {
    this.batchSize = Math.max(1, Math.min(options.batchSize ?? BATCH_SIZE, 500));
    this.commit = options.commit ?? ((batch) => batch.commit());
  }

  async listSources(): Promise<SourceDoc[]> {
    const snap = await this.db.collection("sources").where("status", "==", "active").get();
    return snap.docs.map((d) => ({ ...(d.data() as Omit<SourceDoc, "id">), id: d.id }));
  }

  async updateSource(id: string, patch: SourcePatch): Promise<void> {
    await this.db.collection("sources").doc(id).update(patch);
  }

  async getProgram(id: string): Promise<ProgramRecord | null> {
    const snap = await this.db.collection("programs").doc(id).get();
    return snap.exists ? { ...(snap.data() as Omit<ProgramRecord, "id">), id: snap.id } : null;
  }

  async beginReplace(
    sourceId: string,
    programId: string,
    needsReview: boolean,
    at: string,
  ): Promise<void> {
    // チャンクを先に外してから制度を needsReview にする。途中で失敗しても、
    // 「needsReview なのに検索対象のチャンクがある」状態にはならない
    await this.updateWhere("sourceId", sourceId, { searchable: false });
    const programRef = this.db.collection("programs").doc(programId);
    if (needsReview && (await programRef.get()).exists) {
      await this.updateWhere("programId", programId, { searchable: false });
      await programRef.update({ needsReview: true, updatedAt: at });
    }
  }

  async saveProgram(program: ProgramRecord): Promise<void> {
    const { id, ...data } = program;
    await this.db.collection("programs").doc(id).set(data);
  }

  async upsertChunks(
    sourceId: string,
    chunks: ChunkToWrite[],
    target: EmbeddingTarget,
  ): Promise<void> {
    if (!VERSION_PATTERN.test(target.version)) throw new RangeError("invalid embedding version");
    const field = `${this.options.fieldPrefix}${target.version}`;
    const keep = new Set(chunks.map((c) => c.id));
    for (const c of chunks) {
      if (c.sourceId !== sourceId) throw new RangeError("chunk from another source");
    }
    // ② 新チャンクを searchable=false で書き込む
    await this.inBatches(chunks, (batch, c) => {
      const { id, embedding, ...data } = c;
      batch.set(this.db.collection("chunks").doc(id), {
        ...data,
        searchable: false,
        [field]: FieldValue.vector(embedding),
      });
    });
    // ③ 新しい集合に無い旧チャンクを削除する
    const old = await this.db.collection("chunks").where("sourceId", "==", sourceId).get();
    const stale = old.docs.filter((d) => !keep.has(d.id)).map((d) => d.ref);
    await this.inBatches(stale, (batch, ref) => batch.delete(ref));
  }

  async setSearchable(programId: string, searchable: boolean): Promise<void> {
    await this.updateWhere("programId", programId, { searchable });
  }

  async markExcluded(sourceId: string): Promise<void> {
    await this.updateWhere("sourceId", sourceId, { searchable: false });
    const programRef = this.db.collection("programs").doc(sourceId);
    if ((await programRef.get()).exists) {
      // HTML の情報源なら制度も除外し、PDF のチャンクも外す
      await programRef.update({ status: "excluded" });
      await this.updateWhere("programId", sourceId, { searchable: false });
    }
    await this.db.collection("sources").doc(sourceId).update({ status: "excluded" });
  }

  async addFetchLog(log: FetchLog): Promise<void> {
    await this.db.collection("fetchLogs").add(log);
  }

  private async updateWhere(
    key: "sourceId" | "programId",
    value: string,
    data: { searchable: boolean },
  ): Promise<void> {
    const snap = await this.db.collection("chunks").where(key, "==", value).get();
    const refs: DocumentReference[] = snap.docs
      .filter((d) => d.get("searchable") !== data.searchable)
      .map((d) => d.ref);
    await this.inBatches(refs, (batch, ref) => batch.update(ref, data));
  }

  private async inBatches<T>(items: readonly T[], add: (batch: WriteBatch, item: T) => void) {
    for (let i = 0; i < items.length; i += this.batchSize) {
      const batch = this.db.batch();
      for (const item of items.slice(i, i + this.batchSize)) add(batch, item);
      await this.commit(batch);
    }
  }
}

/** config/operations を読む。文書が無い・形が違うときは例外（呼び出し側で停止として扱う） */
export class FirestoreOpsConfigStore implements OpsConfigStore {
  constructor(private readonly db: Firestore) {}

  async read(): Promise<OpsSwitch> {
    const snap = await this.db.collection("config").doc("operations").get();
    const aiEnabled: unknown = snap.get("aiEnabled");
    const collectionEnabled: unknown = snap.get("collectionEnabled");
    if (typeof aiEnabled !== "boolean" || typeof collectionEnabled !== "boolean") {
      throw new TypeError("config/operations is missing or invalid");
    }
    return { aiEnabled, collectionEnabled };
  }
}
