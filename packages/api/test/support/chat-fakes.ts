// チャットのテスト用の偽物（Vertex AI・Firestore を使わない）
import type { ClaimVerdict, OpsSwitch } from "@hachioji-gov/shared";
import {
  createSwitchReader,
  MemoryUsageStore,
  type AnswerInput,
  type ChatDeps,
  type ChatLlm,
  type ChatRecord,
  type ChatStore,
  type HouseholdAttributes,
  type RetrievedChunk,
  type VectorSearch,
} from "../../src/index.js";

export const CHUNKS: RetrievedChunk[] = [
  {
    chunkId: "c1",
    similarity: 0.9,
    programId: "city-jido-teate",
    excerpt: "3歳未満の児童一人あたりの金額は15,000円です。",
    sourceUrl: "https://kosodate.city.hachioji.tokyo.jp/nenrei/1_2sai/sodan_support/1178.html",
    heading: "3．支給金額",
    fetchedAt: "2026-11-09T00:00:00.000Z",
  },
  {
    chunkId: "c2",
    similarity: 0.8,
    programId: "city-marunyu",
    excerpt: "保険診療の自己負担分を助成します。",
    sourceUrl: "https://kosodate.city.hachioji.tokyo.jp/nenrei/1_2sai/sodan_support/1180.html",
    fetchedAt: "2026-11-08T00:00:00.000Z",
  },
];

export const GOOD_ANSWER = "3歳未満は月15,000円です[1]。";

export class FakeLlm implements ChatLlm {
  intent: "general" | "medical_judgment" = "general";
  // 生成のたびに順に返す回答（最後の値を繰り返す）
  answers: string[] = [GOOD_ANSWER];
  verdicts: (inputs: number) => ClaimVerdict[] = (n) =>
    Array.from({ length: n }, () => "supported");
  // 最初の断片までの遅延（ミリ秒）
  firstDelayMs = 0;
  failGenerate = false;
  generateCalls = 0;
  judgeCalls = 0;
  intentCalls = 0;
  readonly seen: AnswerInput[] = [];
  readonly intentQuestions: string[] = [];

  async classifyIntent(question: string) {
    this.intentCalls += 1;
    this.intentQuestions.push(question);
    return this.intent;
  }

  async *streamAnswer(input: AnswerInput, signal: AbortSignal): AsyncIterable<string> {
    this.seen.push(input);
    const text = this.answers[Math.min(this.generateCalls, this.answers.length - 1)] ?? "";
    this.generateCalls += 1;
    if (this.firstDelayMs > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, this.firstDelayMs);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    if (this.failGenerate) throw new Error("generation failed");
    // 2つに分けて流す
    const mid = Math.ceil(text.length / 2);
    for (const part of [text.slice(0, mid), text.slice(mid)]) {
      if (signal.aborted) return;
      yield part;
    }
  }

  async judgeClaims(inputs: unknown[]): Promise<ClaimVerdict[]> {
    this.judgeCalls += 1;
    return this.verdicts(inputs.length);
  }
}

export class FakeChatStore implements ChatStore {
  readonly chats = new Map<string, (ChatRecord & { id: string })[]>();
  version = "v1";

  async programNames(ids: readonly string[]) {
    const names = new Map([
      ["city-jido-teate", "児童手当"],
      ["city-marunyu", "乳幼児医療費助成"],
    ]);
    return new Map(ids.flatMap((id) => (names.has(id) ? [[id, names.get(id) as string]] : [])));
  }

  async searchVersion() {
    return this.version;
  }

  async saveChat(uid: string, record: ChatRecord) {
    const list = this.chats.get(uid) ?? [];
    const id = `chat${list.length + 1}`;
    list.push({ ...record, id });
    this.chats.set(uid, list);
    return id;
  }

  async listChats(uid: string, limit: number) {
    return (this.chats.get(uid) ?? []).slice(-limit).reverse();
  }
}

export function chatDeps(over: { ops?: OpsSwitch; chunks?: RetrievedChunk[] } = {}) {
  const llm = new FakeLlm();
  const store = new FakeChatStore();
  const usage = new MemoryUsageStore();
  const searches: VectorSearch[] = [];
  const embedded: string[] = [];
  const household: HouseholdAttributes = { municipalityCode: "13201", ageBands: ["age_0_2"] };
  const deps: ChatDeps = {
    switches: createSwitchReader(
      { read: async () => over.ops ?? { aiEnabled: true, collectionEnabled: true } },
      { cacheTtlSec: 5, maxStaleSec: 10 },
    ),
    usage,
    household: { read: async () => household },
    embedder: {
      embedQuery: async (text) => {
        embedded.push(text);
        return [1, 0, 0];
      },
    },
    vectors: {
      search: async (q) => {
        searches.push(q);
        return over.chunks ?? CHUNKS;
      },
    },
    llm,
    store,
    now: () => new Date("2026-11-09T03:00:00.000Z"),
    settings: {
      limits: { perUserPerDay: 20, globalPerDay: 500 },
      minSimilarity: 0.3,
      fieldPrefix: "emb_",
      firstTokenTimeoutSec: 30,
    },
  };
  return { deps, llm, store, usage, searches, embedded };
}

export type SseEvent = { event: string; data: unknown };

/** SSE の応答本文をイベントの配列にする */
export function parseSse(text: string): SseEvent[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n\n")
    .filter((b) => b.trim() !== "")
    .map((block) => {
      const lines = block.split("\n");
      const event =
        lines
          .find((l) => l.startsWith("event:"))
          ?.slice(6)
          .trim() ?? "message";
      const data = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      return { event, data: data === "" ? null : (JSON.parse(data) as unknown) };
    });
}
