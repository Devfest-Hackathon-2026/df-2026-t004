// チャットの Firestore 実装（Requirement 4.7, 5.1, 5.14）

import { mergeResults, type SourceAgeBand } from "@hachioji-gov/shared";
import type { Firestore, Query } from "firebase-admin/firestore";
import type {
  ChatRecord,
  ChatStore,
  ChatVectorStore,
  HouseholdAttributes,
  HouseholdReader,
  RetrievedChunk,
  VectorSearch,
} from "./types.js";

const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
// 類似度を入れる結果のフィールド（保存はしない）
const SIMILARITY_FIELD = "__similarity";

export class FirestoreChatVectorStore implements ChatVectorStore {
  constructor(private readonly db: Firestore) {}

  async search(q: VectorSearch): Promise<RetrievedChunk[]> {
    if (!FIELD.test(q.embeddingField)) throw new RangeError("invalid embedding field");
    const lists = await Promise.all(
      q.queries.map(async (filters) => {
        let query: Query = this.db.collection("chunks");
        for (const [key, value] of Object.entries(filters)) {
          if (!FIELD.test(key)) throw new RangeError("invalid filter field");
          query = query.where(key, "==", value);
        }
        const snap = await query
          .findNearest({
            vectorField: q.embeddingField,
            queryVector: q.embedding,
            limit: q.limit,
            distanceMeasure: "DOT_PRODUCT",
            // DOT_PRODUCT のしきい値は「以上」で効く
            distanceThreshold: q.minSimilarity,
            distanceResultField: SIMILARITY_FIELD,
          })
          .get();
        return snap.docs.map((d): RetrievedChunk => {
          const chunk: RetrievedChunk = {
            chunkId: d.id,
            similarity: Number(d.get(SIMILARITY_FIELD)),
            programId: String(d.get("programId")),
            excerpt: String(d.get("excerpt")),
            sourceUrl: String(d.get("sourceUrl")),
            fetchedAt: String(d.get("fetchedAt")),
          };
          const heading: unknown = d.get("heading");
          const pdfPage: unknown = d.get("pdfPage");
          if (typeof heading === "string") chunk.heading = heading;
          if (typeof pdfPage === "number") chunk.pdfPage = pdfPage;
          return chunk;
        });
      }),
    );
    return mergeResults(lists, q.limit);
  }
}

export class FirestoreChatStore implements ChatStore {
  constructor(
    private readonly db: Firestore,
    private readonly defaultVersion: string,
  ) {}

  async programNames(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const snaps = await this.db.getAll(...ids.map((id) => this.db.collection("programs").doc(id)));
    const out = new Map<string, string>();
    for (const s of snaps) {
      const name: unknown = s.get("name");
      if (s.exists && typeof name === "string") out.set(s.id, name);
    }
    return out;
  }

  async searchVersion(): Promise<string> {
    const version: unknown = (await this.db.collection("config").doc("embedding").get()).get(
      "searchVersion",
    );
    return typeof version === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(version)
      ? version
      : this.defaultVersion;
  }

  async saveChat(uid: string, record: ChatRecord): Promise<string> {
    const ref = await this.db.collection("users").doc(uid).collection("chats").add(record);
    return ref.id;
  }

  async listChats(uid: string, limit: number): Promise<(ChatRecord & { id: string })[]> {
    const snap = await this.db
      .collection("users")
      .doc(uid)
      .collection("chats")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();
    return snap.docs.map((d) => ({ ...(d.data() as ChatRecord), id: d.id }));
  }
}

// 子どもの年齢（歳）から年齢区分にする
function bandOfAge(age: number): SourceAgeBand | null {
  if (!Number.isInteger(age) || age < 0) return null;
  if (age <= 2) return "age_0_2";
  if (age <= 5) return "age_3_5";
  if (age <= 11) return "age_6_11";
  if (age <= 14) return "age_12_14";
  if (age <= 18) return "age_15_18";
  return null;
}

/**
 * users/{uid} の世帯情報から、自治体と年齢区分を読む。
 * 妊娠中の区分は保存せず、同意のある要配慮情報（sensitive/profile の出産予定日）から導く。
 * 世帯の保存形式は T20 で確定させる（ここは自治体コードと子どもの年齢だけを使う）。
 */
export class FirestoreHouseholdReader implements HouseholdReader {
  constructor(private readonly db: Firestore) {}

  async read(uid: string): Promise<HouseholdAttributes | null> {
    const user = this.db.collection("users").doc(uid);
    const [snap, sensitive] = await Promise.all([
      user.get(),
      user.collection("sensitive").doc("profile").get(),
    ]);
    if (!snap.exists) return null;
    const household: unknown = snap.get("household");
    const children: unknown = snap.get("children");
    const bands = new Set<SourceAgeBand>();
    if (Array.isArray(children)) {
      for (const child of children as unknown[]) {
        const age: unknown =
          child !== null && typeof child === "object" ? Reflect.get(child, "ageYears") : undefined;
        const band = typeof age === "number" ? bandOfAge(age) : null;
        if (band !== null) bands.add(band);
      }
    }
    if (snap.get("sensitiveLocked") !== true && typeof sensitive.get("dueDate") === "string") {
      bands.add("pregnancy");
    }
    return {
      municipalityCode:
        household !== null && typeof household === "object"
          ? Reflect.get(household, "municipalityCode")
          : null,
      ageBands: [...bands],
    };
  }
}
