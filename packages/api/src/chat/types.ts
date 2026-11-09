// AI 相談（RAG チャット）の境界と SSE イベントの形（Requirement 5, 10, 12, 13）

import type {
  ClaimVerdict,
  GroundingInput,
  ScoredChunk,
  SearchFilters,
  SourceAgeBand,
} from "@hachioji-gov/shared";

/** 検索で取得したチャンク。回答の根拠はこれだけ */
export type RetrievedChunk = ScoredChunk & {
  programId: string;
  excerpt: string;
  sourceUrl: string;
  heading?: string;
  pdfPage?: number;
  fetchedAt: string;
};

export type VectorSearch = {
  queries: SearchFilters[];
  // 検索に使う版のフィールド名（例: "emb_v1"）
  embeddingField: string;
  embedding: number[];
  minSimilarity: number;
  limit: number;
};

export interface ChatVectorStore {
  /** クエリを並列に実行し、統合した上位 limit 件を類似度の降順で返す */
  search(q: VectorSearch): Promise<RetrievedChunk[]>;
}

export interface QueryEmbedder {
  /** 質問の埋め込み（RETRIEVAL_QUERY、L2 正規化済み） */
  embedQuery(text: string): Promise<number[]>;
}

export type AnswerInput = {
  question: string;
  context: readonly RetrievedChunk[];
  // LLM に渡す世帯の属性（buildLlmContext の出力だけ）
  household: { municipalityCode: string | null; ageBands: SourceAgeBand[] };
};

export interface ChatLlm {
  classifyIntent(question: string): Promise<"general" | "medical_judgment">;
  streamAnswer(input: AnswerInput, signal: AbortSignal): AsyncIterable<string>;
  /** cited の主張だけを受け取り、同じ順に判定を返す */
  judgeClaims(inputs: Extract<GroundingInput, { kind: "cited" }>[]): Promise<ClaimVerdict[]>;
}

/** 世帯のうち、検索と LLM に使う属性 */
export type HouseholdAttributes = { municipalityCode: unknown; ageBands: unknown };

export interface HouseholdReader {
  read(uid: string): Promise<HouseholdAttributes | null>;
}

export type ChatSource = {
  n: number;
  title: string;
  url: string;
  fetchedAt?: string;
  heading?: string;
  pdfPage?: number;
};

export type ChatRecord = {
  // PII を伏せた質問
  question: string;
  answer: string;
  sources: ChatSource[];
  createdAt: string;
};

export interface ChatStore {
  /** 制度の名前（出典の資料名に使う） */
  programNames(ids: readonly string[]): Promise<Map<string, string>>;
  /** 検索に使う埋め込みの版（config/embedding の searchVersion） */
  searchVersion(): Promise<string>;
  /**
   * 確定した回答だけを保存する。保存したチャットの ID を返す。
   * アカウントの削除中・削除済みなら保存せず null を返す
   */
  saveChat(uid: string, record: ChatRecord): Promise<string | null>;
  listChats(uid: string, limit: number): Promise<(ChatRecord & { id: string })[]>;
}

export type ChatErrorReason =
  | "invalid_question"
  | "account_deleting"
  | "ops_stopped"
  | "quota_user"
  | "quota_global"
  | "timeout"
  | "generation_failed"
  | "internal";

export type FallbackReason = "no_sources" | "medical_judgment" | "unverified";

// SSE のイベント名と本文
export type ChatEvents = {
  status: { state: "accepted" };
  delta: { text: string };
  reset: Record<string, never>;
  verified: { text: string; chatId: string };
  sources: { sources: ChatSource[] };
  suggestions: { items: string[] };
  proposal: { programs: { programId: string; name: string }[] };
  fallback: {
    reason: FallbackReason;
    message: string;
    sources: ChatSource[];
    contact: string;
  };
  error: {
    reason: ChatErrorReason;
    message: string;
    // 上限到達のとき、再び使える時刻（日本時間の翌日0時）
    retryAt?: string;
    contact?: string;
    length?: number;
  };
};

export type Emit = <K extends keyof ChatEvents>(event: K, data: ChatEvents[K]) => Promise<void>;
