// 評価の実行（Requirement 12.8, 14.3〜14.7）
// 検索の評価と回答の評価を分けて実行する。本番のパイプラインへの接続はこの境界の実装で行う。

import {
  citationCounts,
  citationValidRate,
  groundedRate,
  percentile,
  recallAtK,
  retrievalHit,
  SEARCH_TOP_K,
  type ClaimVerdict,
  type EmbeddingTarget,
  type EvalQuestion,
  type EvalResult,
  type EvalSet,
} from "@hachioji-gov/shared";

/** 本番と同じクエリ計画で検索し、上位の出典URLを順に返す */
export interface Retriever {
  retrieve(question: EvalQuestion): Promise<string[]>;
}

export type AnswerOutcome = {
  behavior: "answered" | "fallback" | "not_found";
  // 生成した回答の本文（引用番号 [n] を含む）
  text: string;
  // 回答に渡したチャンクの数（引用番号の有効範囲 1〜n）
  sourcesCount: number;
  // 主張ごとの根拠判定
  verdicts: ClaimVerdict[];
};

/** 本番と同じパイプライン（検索 → 生成 → 引用検証 → 根拠確認）を1問実行する */
export interface AnswerRunner {
  answer(question: EvalQuestion): Promise<AnswerOutcome>;
}

export type RunMeta = {
  ranAt: Date;
  models: { generation: string; judge: string; embedding: EmbeddingTarget };
};

/** 実行日時から runId を作る（例: 20261109T120000Z） */
export function runIdOf(ranAt: Date): string {
  return ranAt
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function baseResult(set: EvalSet, meta: RunMeta): EvalResult {
  return {
    runId: runIdOf(meta.ranAt),
    ranAt: meta.ranAt.toISOString(),
    evalSetVersion: set.version,
    models: meta.models,
    metrics: {},
    perQuestion: [],
  };
}

/** 検索の評価。再現率@5（答えのない質問は分母に含めない） */
export async function runRetrievalEval(
  set: EvalSet,
  retriever: Retriever,
  meta: RunMeta,
): Promise<EvalResult> {
  const result = baseResult(set, meta);
  const outcomes = [];
  for (const q of set.questions) {
    const urls = (await retriever.retrieve(q)).slice(0, SEARCH_TOP_K);
    outcomes.push({ expected: q.expected, retrievedUrls: urls });
    result.perQuestion.push(
      q.expected.kind === "answerable"
        ? { id: q.id, retrievedHit: retrievalHit(q.expected.sourceUrls, urls) }
        : { id: q.id, behavior: urls.length === 0 ? "not_found" : "answered" },
    );
  }
  const recall = recallAtK(outcomes);
  if (recall !== null) result.metrics.recallAt5 = recall;
  return result;
}

/** 回答の評価。根拠範囲内率と引用の有効率を別々に計算する */
export async function runAnswerEval(
  set: EvalSet,
  runner: AnswerRunner,
  meta: RunMeta,
): Promise<EvalResult> {
  const result = baseResult(set, meta);
  const grounded = [];
  const citations = [];
  for (const q of set.questions) {
    const out = await runner.answer(q);
    const g = {
      groundedClaims: out.verdicts.filter((v) => v === "supported").length,
      totalClaims: out.verdicts.length,
    };
    const c = citationCounts(out.text, out.sourcesCount);
    // 答えのない質問は、根拠と引用の集計に含めない（期待動作は fallback）
    if (q.expected.kind === "answerable" && out.behavior === "answered") {
      grounded.push(g);
      citations.push(c);
    }
    result.perQuestion.push({ id: q.id, behavior: out.behavior, ...g, ...c });
  }
  const gr = groundedRate(grounded);
  const cr = citationValidRate(citations);
  if (gr !== null) result.metrics.groundedRate = gr;
  if (cr !== null) result.metrics.citationValidRate = cr;
  return result;
}

export type ChatTiming = {
  // 送信から status イベント（待機表示）までの時間
  waitingMs: number;
  // 送信から最初の delta（テキスト断片）までの時間。来なければ null
  firstDeltaMs: number | null;
};

export interface ChatClient {
  send(question: string): Promise<ChatTiming>;
}

export type PerfOptions = {
  mode: "warm" | "cold";
  runs: number;
  // コールドスタートの計測の前に、インスタンスを捨てる処理（新しいリビジョンを作るなど）
  prepareCold?: () => Promise<void>;
};

export type PerfStats = { p50Ms: number; p90Ms: number; samples: number };

function stats(values: number[]): PerfStats | null {
  return values.length === 0
    ? null
    : { p50Ms: percentile(values, 50), p90Ms: percentile(values, 90), samples: values.length };
}

/**
 * 性能の計測。起動済み（warm）は直前に1回送って起動させてから、
 * コールドスタート（cold）は毎回 prepareCold の後に送る。質問は評価セットから順に使う。
 */
export async function runPerf(
  set: EvalSet,
  client: ChatClient,
  options: PerfOptions,
): Promise<Record<string, PerfStats>> {
  const questions = set.questions.map((q) => q.question);
  if (questions.length === 0) throw new RangeError("質問がありません");
  if (options.mode === "cold" && options.prepareCold === undefined) {
    throw new RangeError("cold の計測には prepareCold が必要です");
  }
  const waiting: number[] = [];
  const firstDelta: number[] = [];
  if (options.mode === "warm") await client.send(questions[0] as string);
  for (let i = 0; i < options.runs; i++) {
    if (options.mode === "cold") await options.prepareCold?.();
    const t = await client.send(questions[i % questions.length] as string);
    waiting.push(t.waitingMs);
    if (t.firstDeltaMs !== null) firstDelta.push(t.firstDeltaMs);
  }
  const out: Record<string, PerfStats> = {};
  const w = stats(waiting);
  const d = stats(firstDelta);
  if (w !== null) out[`${options.mode}Waiting`] = w;
  if (d !== null) out[`${options.mode}FirstDelta`] = d;
  return out;
}
