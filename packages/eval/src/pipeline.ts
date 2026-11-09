// 本番の検索・生成のパイプラインへの接続（Requirement 14.3〜14.5）
// 検索の評価は本番と同じクエリ計画で検索だけを行い、回答の評価は本番の runChat をそのまま動かす。

import {
  runChat,
  searchChunks,
  type ChatAttempt,
  type ChatDeps,
  type ChatStore,
  type SearchDeps,
} from "@hachioji-gov/api";
import { buildLlmContext, maskPii, type EvalQuestion } from "@hachioji-gov/shared";
import type { AnswerOutcome, AnswerRunner, Retriever } from "./runner.js";

// 評価で使う利用者 ID（履歴は保存しないので、どのユーザーにも結び付かない）
const EVAL_UID = "eval";

function householdOf(q: EvalQuestion) {
  return q.household ?? { municipalityCode: null, ageBands: [] };
}

/** 本番と同じクエリ計画で検索し、上位の出典URLを順に返す（生成は行わない） */
export class PipelineRetriever implements Retriever {
  constructor(private readonly deps: SearchDeps) {}

  async retrieve(q: EvalQuestion): Promise<string[]> {
    const chunks = await searchChunks(this.deps, {
      question: maskPii(q.question),
      household: buildLlmContext(householdOf(q)),
    });
    return chunks.map((c) => c.sourceUrl);
  }
}

export type AnswerDeps = Omit<
  ChatDeps,
  "switches" | "usage" | "household" | "observe" | "store"
> & {
  store: Pick<ChatStore, "programNames" | "searchVersion">;
};

/**
 * 本番の runChat（検索 → 生成 → 引用検証 → 根拠確認）を1問ずつ動かす。
 * 運営者の操作なので、運営スイッチと日次上限は数えず、履歴も保存しない。
 */
export class PipelineAnswerRunner implements AnswerRunner {
  constructor(private readonly deps: AnswerDeps) {}

  async answer(q: EvalQuestion): Promise<AnswerOutcome> {
    const attempts: ChatAttempt[] = [];
    const outcome = await runChat(
      { uid: EVAL_UID, question: q.question },
      {
        ...this.deps,
        switches: { get: async () => ({ aiEnabled: true, collectionEnabled: true }) },
        usage: { reserve: async () => ({ ok: true, next: { user: 0, global: 0 } }) },
        household: { read: async () => householdOf(q) },
        store: {
          programNames: (ids) => this.deps.store.programNames(ids),
          searchVersion: () => this.deps.store.searchVersion(),
          saveChat: async () => EVAL_UID,
          listChats: async () => [],
        },
        observe: (attempt) => attempts.push(attempt),
      },
      async () => {},
      new AbortController().signal,
    );
    // 再生成したときは、最後の生成の結果で評価する
    const attempt = attempts.at(-1);
    switch (outcome) {
      case "verified":
      case "fallback":
        if (attempt === undefined) throw new Error(`${q.id}: 生成の結果がありません`);
        return {
          behavior: outcome === "verified" ? "answered" : "fallback",
          text: attempt.text,
          sourcesCount: attempt.sourcesCount,
          verdicts: attempt.verdicts,
        };
      case "no_sources":
        return { behavior: "not_found", text: "", sourcesCount: 0, verdicts: [] };
      case "medical_judgment":
        return { behavior: "fallback", text: "", sourcesCount: 0, verdicts: [] };
      default:
        // 時間切れや生成の失敗は、品質の結果として数えずに止める
        throw new Error(`${q.id}: ${outcome}`);
    }
  }
}
