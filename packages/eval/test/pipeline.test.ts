// 本番のパイプラインへの接続（Requirement 14.3〜14.5）
import type { EvalQuestion, EvalSet } from "@hachioji-gov/shared";
import { describe, expect, it } from "vitest";
import { chatDeps, CHUNKS, GOOD_ANSWER } from "../../api/test/support/chat-fakes.js";
import { PipelineAnswerRunner, PipelineRetriever, runAnswerEval } from "../src/index.js";

const Q: EvalQuestion = {
  id: "q1",
  question: "児童手当はいくら？連絡先は090-0000-0000です",
  category: "childcare",
  household: { ageBands: ["age_0_2"], municipalityCode: "13201" },
  expected: { kind: "answerable", sourceUrls: [CHUNKS[0]?.sourceUrl ?? ""], requiredFacts: [] },
};

const codesOf = (queries: Record<string, unknown>[]) =>
  [...new Set(queries.map((q) => q["municipalityCode"]))].sort();

describe("PipelineRetriever", () => {
  it("本番と同じクエリ計画で検索し、出典URLを順に返す（生成はしない）", async () => {
    const t = chatDeps();
    const urls = await new PipelineRetriever(t.deps).retrieve(Q);
    expect(urls).toEqual(CHUNKS.map((c) => c.sourceUrl));
    // 埋め込みには PII を伏せた質問を渡す
    expect(t.embedded[0]).not.toContain("090-0000-0000");
    expect(t.searches[0]?.embeddingField).toBe("emb_v1");
    expect(codesOf(t.searches[0]?.queries ?? [])).toEqual(["00000", "13000", "13201"]);
    expect(t.llm.generateCalls + t.llm.intentCalls).toBe(0);
  });

  it("世帯の無い質問は国と都だけで探す", async () => {
    const t = chatDeps();
    await new PipelineRetriever(t.deps).retrieve({ ...Q, household: undefined });
    expect(codesOf(t.searches[0]?.queries ?? [])).toEqual(["00000", "13000"]);
  });
});

describe("PipelineAnswerRunner", () => {
  it("検証を通った回答を answered にし、履歴に保存せず、回数も数えない", async () => {
    const t = chatDeps({ ops: { aiEnabled: false, collectionEnabled: true } });
    const out = await new PipelineAnswerRunner(t.deps).answer(Q);
    expect(out).toEqual({
      behavior: "answered",
      text: GOOD_ANSWER,
      sourcesCount: CHUNKS.length,
      verdicts: ["supported"],
    });
    expect(t.store.chats.size).toBe(0);
    expect(t.usage.counts.size).toBe(0);
  });

  it("作り直したときは最後の生成で評価する", async () => {
    const t = chatDeps();
    t.llm.answers = ["児童手当は月15,000円です[9]。", GOOD_ANSWER];
    const out = await new PipelineAnswerRunner(t.deps).answer(Q);
    expect(out).toMatchObject({ behavior: "answered", text: GOOD_ANSWER });
    expect(t.llm.generateCalls).toBe(2);
  });

  it("検証を通らなければ fallback（最後の生成の判定を残す）", async () => {
    const t = chatDeps();
    t.llm.answers = ["児童手当は月15,000円です[9]。"];
    const out = await new PipelineAnswerRunner(t.deps).answer(Q);
    expect(out).toEqual({
      behavior: "fallback",
      text: "児童手当は月15,000円です[9]。",
      sourcesCount: CHUNKS.length,
      verdicts: [],
    });
  });

  it("資料が無ければ not_found、医療の判断の質問は fallback", async () => {
    const none = chatDeps({ chunks: [] });
    expect(await new PipelineAnswerRunner(none.deps).answer(Q)).toMatchObject({
      behavior: "not_found",
    });
    const medical = chatDeps();
    medical.llm.intent = "medical_judgment";
    expect(await new PipelineAnswerRunner(medical.deps).answer(Q)).toMatchObject({
      behavior: "fallback",
      verdicts: [],
    });
  });

  it("生成に失敗したら、結果として数えずに止める", async () => {
    const t = chatDeps();
    t.llm.failGenerate = true;
    await expect(new PipelineAnswerRunner(t.deps).answer(Q)).rejects.toThrow("q1: failed");
  });

  it("runAnswerEval とつないで指標を計算できる", async () => {
    const t = chatDeps();
    const set: EvalSet = { version: "test-v1", questions: [Q] };
    const result = await runAnswerEval(set, new PipelineAnswerRunner(t.deps), {
      ranAt: new Date("2026-11-10T00:00:00.000Z"),
      models: {
        generation: "gen",
        judge: "judge",
        embedding: { model: "gemini-embedding-001", dimensions: 768, version: "v1" },
      },
    });
    expect(result.metrics).toEqual({ groundedRate: 1, citationValidRate: 1 });
  });
});
