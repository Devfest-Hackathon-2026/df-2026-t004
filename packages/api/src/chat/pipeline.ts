// AI 相談の処理の流れ（Requirement 5.1〜5.13, 9.9, 9.13, 10.1〜10.3, 12.1, 12.3, 12.7, 13.12）
// 受付 → 文字数 → 運営スイッチと日次上限 → 意図判定 → PII マスク → 検索 → 生成 → 引用と根拠の検証

import {
  aggregateGrounding,
  buildFallbackView,
  buildGroundingInputs,
  buildLlmContext,
  dateKeyJst,
  limitSuggestions,
  maskPii,
  nextChatAction,
  parseCitations,
  planSearchQueries,
  SEARCH_TOP_K,
  splitClaims,
  validateCitations,
  validateQuestion,
  type ClaimVerdict,
  type QuotaLimits,
  type SourceCategory,
} from "@hachioji-gov/shared";
import { admitQuestion, type SwitchReader, type UsageStore } from "../operations.js";
import type {
  AnswerInput,
  ChatLlm,
  ChatSource,
  ChatStore,
  ChatVectorStore,
  Emit,
  HouseholdReader,
  QueryEmbedder,
  RetrievedChunk,
} from "./types.js";

// 国・東京都の自治体コード（Requirement 5.1）
export const NATIONAL_CODE = "00000";
export const TOKYO_CODE = "13000";

export const NO_SOURCES_MESSAGE =
  "公的資料から、この質問に答える情報が見つかりませんでした。下の窓口にお問い合わせください。";
export const MEDICAL_MESSAGE =
  "病気の診断や治療の判断はできません。医師、または下の窓口にご相談ください。急な病気やけがで迷うときは、子供の健康相談室（#8000）や救急相談センター（#7119）も使えます。";
export const TIMEOUT_MESSAGE =
  "回答を始められませんでした。時間をおいて、もう一度送信してください。";
export const GENERATION_FAILED_MESSAGE =
  "回答の作成に失敗しました。時間をおいて、もう一度送信してください。";

// 自治体ごとの問い合わせ窓口
const CONTACTS = new Map<string, string>([
  ["13201", "八王子市役所の子育て・医療の担当窓口（https://www.city.hachioji.tokyo.jp/）"],
]);
const DEFAULT_CONTACT = "お住まいの市区町村の子育て・医療の担当窓口";

export function contactFor(municipalityCode: string | null): string {
  return (
    (municipalityCode === null ? undefined : CONTACTS.get(municipalityCode)) ?? DEFAULT_CONTACT
  );
}

export type ChatRequest = {
  uid: string;
  question: string;
  category?: SourceCategory | null;
  // 「AIに聞く」で制度に限定するとき
  programId?: string | null;
};

export type ChatDeps = {
  switches: SwitchReader;
  usage: UsageStore;
  household: HouseholdReader;
  embedder: QueryEmbedder;
  vectors: ChatVectorStore;
  llm: ChatLlm;
  store: ChatStore;
  now: () => Date;
  settings: {
    limits: QuotaLimits;
    minSimilarity: number;
    fieldPrefix: string;
    firstTokenTimeoutSec: number;
  };
  // 生成のたびに、検証の結果を受け取る（評価ハーネスが使う）
  observe?: (attempt: ChatAttempt) => void;
};

export type ChatAttempt = {
  text: string;
  // 回答に渡したチャンクの数（引用番号の有効範囲 1〜n）
  sourcesCount: number;
  citationsValid: boolean;
  // 主張ごとの根拠判定。引用が無効なときは判定しないので空
  verdicts: ClaimVerdict[];
};

export type SearchRequest = {
  // PII を伏せた質問
  question: string;
  household: AnswerInput["household"];
  category?: SourceCategory | null;
  programId?: string | null;
};

export type SearchDeps = {
  embedder: QueryEmbedder;
  vectors: ChatVectorStore;
  store: Pick<ChatStore, "searchVersion">;
  settings: Pick<ChatDeps["settings"], "minSimilarity" | "fieldPrefix">;
};

/** 国・都・世帯の自治体（または制度）で絞り、設定の版の埋め込みで上位を検索する */
export async function searchChunks(
  deps: SearchDeps,
  req: SearchRequest,
): Promise<RetrievedChunk[]> {
  const queries = planSearchQueries(
    req.programId !== undefined && req.programId !== null
      ? { programId: req.programId }
      : {
          municipalityCodes: [
            NATIONAL_CODE,
            TOKYO_CODE,
            ...(req.household.municipalityCode === null ? [] : [req.household.municipalityCode]),
          ],
          ageBands: req.household.ageBands.length === 0 ? null : req.household.ageBands,
          category: req.category ?? null,
        },
  );
  const [version, embedding] = await Promise.all([
    deps.store.searchVersion(),
    deps.embedder.embedQuery(req.question),
  ]);
  return deps.vectors.search({
    queries,
    embeddingField: `${deps.settings.fieldPrefix}${version}`,
    embedding,
    minSimilarity: deps.settings.minSimilarity,
    limit: SEARCH_TOP_K,
  });
}

export type ChatOutcome =
  | "rejected"
  | "no_sources"
  | "medical_judgment"
  | "verified"
  | "fallback"
  | "timeout"
  | "failed"
  | "aborted"
  | "account_deleting";

class FirstTokenTimeout extends Error {
  override name = "FirstTokenTimeout";
}

/**
 * 1回の生成。最初の断片が timeoutMs 以内に来なければ FirstTokenTimeout。
 * 断片は届いた順に delta で送り、全文を返す。
 */
async function generate(
  deps: ChatDeps,
  input: Parameters<ChatLlm["streamAnswer"]>[0],
  emit: Emit,
  signal: AbortSignal,
): Promise<string> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  signal.addEventListener("abort", onAbort);
  const timeoutMs = deps.settings.firstTokenTimeoutSec * 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new FirstTokenTimeout());
    }, timeoutMs);
  });
  let text = "";
  try {
    const iterator = deps.llm.streamAnswer(input, controller.signal)[Symbol.asyncIterator]();
    let first = true;
    for (;;) {
      const next = first ? await Promise.race([iterator.next(), timeout]) : await iterator.next();
      if (first) clearTimeout(timer);
      first = false;
      if (next.done === true) break;
      if (next.value === "") continue;
      text += next.value;
      await emit("delta", { text: next.value });
    }
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
  return text;
}

/** 主張ごとの判定。引用のない主張は LLM に送らず uncited にする */
async function judge(llm: ChatLlm, text: string, chunks: readonly RetrievedChunk[]) {
  const inputs = buildGroundingInputs(splitClaims(text), chunks);
  const cited = inputs.filter((i) => i.kind === "cited");
  const judged = cited.length === 0 ? [] : await llm.judgeClaims(cited);
  let k = 0;
  return inputs.map((i): ClaimVerdict => {
    if (i.kind === "uncited") return "uncited";
    const v = judged.at(k++);
    // 判定の数が合わないときは範囲外として扱う（安全側）
    return judged.length === cited.length && v !== undefined ? v : "unsupported";
  });
}

function suggestionsFor(names: readonly string[]): string[] {
  const [first, second] = names;
  const list: string[] = [];
  if (first !== undefined) list.push(`${first}の申請方法を教えて`, `${first}の対象になる人は？`);
  if (second !== undefined) list.push(`${second}について詳しく教えて`);
  return limitSuggestions(list);
}

/**
 * 質問を1つ処理し、SSE のイベントを emit で送る。受付直後に status を送る。
 * 回数は受付時に1回だけ数え、再生成・検証・意図判定では数えない。
 */
export async function runChat(
  req: ChatRequest,
  deps: ChatDeps,
  emit: Emit,
  signal: AbortSignal,
): Promise<ChatOutcome> {
  await emit("status", { state: "accepted" });

  const checked = validateQuestion(req.question);
  if (!checked.ok) {
    await emit("error", {
      reason: "invalid_question",
      message: checked.message,
      length: checked.length,
    });
    return "rejected";
  }

  const household = buildLlmContext(
    (await deps.household.read(req.uid)) ?? { municipalityCode: null, ageBands: [] },
  );
  const contact = contactFor(household.municipalityCode);

  const now = deps.now();
  const admission = await admitQuestion(req.uid, {
    switches: deps.switches,
    usage: deps.usage,
    limits: deps.settings.limits,
    now,
  });
  if (!admission.ok) {
    if (admission.reason === "ops_stopped") {
      await emit("error", {
        reason: "ops_stopped",
        message: "AI 相談は一時的に停止しています。下の窓口にお問い合わせください。",
        contact,
      });
    } else {
      // 日本時間の翌日0時（dateKey の日の 15:00 UTC）
      const retryAt = new Date(Date.parse(`${dateKeyJst(now)}T15:00:00.000Z`)).toISOString();
      await emit("error", {
        reason: admission.reason,
        message:
          admission.reason === "quota_user"
            ? "今日の AI 相談の回数の上限に達しました。明日0時から再び使えます。"
            : "今日はサービス全体の AI 相談の上限に達しました。明日0時から再び使えます。",
        retryAt,
        contact,
      });
    }
    return "rejected";
  }

  // LLM と埋め込みには、電話番号・メール・郵便番号を伏せた質問だけを渡す
  const question = maskPii(checked.value);

  if ((await deps.llm.classifyIntent(question)) === "medical_judgment") {
    await emit("fallback", {
      reason: "medical_judgment",
      message: MEDICAL_MESSAGE,
      sources: [],
      contact,
    });
    return "medical_judgment";
  }

  const chunks = await searchChunks(deps, {
    question,
    household,
    category: req.category ?? null,
    programId: req.programId ?? null,
  });
  if (chunks.length === 0) {
    // 資料が無ければ LLM を呼ばない
    await emit("fallback", {
      reason: "no_sources",
      message: NO_SOURCES_MESSAGE,
      sources: [],
      contact,
    });
    return "no_sources";
  }

  const names = await deps.store.programNames([...new Set(chunks.map((c) => c.programId))]);
  const sources: ChatSource[] = chunks.map((c, i) => {
    const s: ChatSource = {
      n: i + 1,
      title: names.get(c.programId) ?? c.heading ?? c.sourceUrl,
      url: c.sourceUrl,
      fetchedAt: c.fetchedAt.slice(0, 10),
    };
    if (c.heading !== undefined) s.heading = c.heading;
    if (c.pdfPage !== undefined) s.pdfPage = c.pdfPage;
    return s;
  });

  let regenerations = 0;
  for (;;) {
    let text: string;
    try {
      text = await generate(deps, { question, context: chunks, household }, emit, signal);
    } catch (e) {
      if (signal.aborted) return "aborted";
      if (e instanceof FirstTokenTimeout) {
        await emit("error", { reason: "timeout", message: TIMEOUT_MESSAGE });
        return "timeout";
      }
      await emit("error", { reason: "generation_failed", message: GENERATION_FAILED_MESSAGE });
      return "failed";
    }
    if (signal.aborted) return "aborted";

    const citationsValid = validateCitations(text, chunks.length).length === 0;
    // 引用が無効なら根拠の判定は省く（どのみち不合格）
    const verdicts = citationsValid ? await judge(deps.llm, text, chunks) : [];
    deps.observe?.({ text, sourcesCount: chunks.length, citationsValid, verdicts });
    const grounding = aggregateGrounding(verdicts);
    const action = nextChatAction({
      citationsValid,
      groundingPassed: grounding.passed,
      regenerations,
    });

    if (action === "regenerate") {
      regenerations += 1;
      await emit("reset", {});
      continue;
    }
    if (action === "fallback") {
      const view = buildFallbackView(sources, contact);
      await emit("fallback", { reason: "unverified", ...view });
      return "fallback";
    }

    const cited = new Set(parseCitations(text));
    const citedSources = sources.filter((s) => cited.has(s.n));
    const chatId = await deps.store.saveChat(req.uid, {
      question,
      answer: text,
      sources: citedSources,
      createdAt: deps.now().toISOString(),
    });
    if (chatId === null) {
      // 回答を作っている間にアカウントの削除が始まった。確定させずに終える
      await emit("error", {
        reason: "account_deleting",
        message: "アカウントの削除中のため、回答を保存できませんでした。",
      });
      return "account_deleting";
    }
    await emit("verified", { text, chatId });
    await emit("sources", { sources: citedSources });
    const programs = [
      ...new Set(chunks.filter((_, i) => cited.has(i + 1)).map((c) => c.programId)),
    ];
    const programNames = programs.map((id) => names.get(id)).filter((n) => n !== undefined);
    await emit("suggestions", { items: suggestionsFor(programNames) });
    await emit("proposal", {
      programs: programs.flatMap((programId) => {
        const name = names.get(programId);
        return name === undefined ? [] : [{ programId, name }];
      }),
    });
    return "verified";
  }
}
