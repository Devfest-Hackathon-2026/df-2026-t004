import { decodeEvalResult, encodeEvalResult, type EvalSet } from "@hachioji-gov/shared";
import { describe, expect, it } from "vitest";
import {
  runAnswerEval,
  runIdOf,
  runPerf,
  runRetrievalEval,
  type AnswerOutcome,
  type ChatTiming,
  type RunMeta,
} from "../src/index.js";

const URL_A = "https://kosodate.city.hachioji.tokyo.jp/a.html";
const URL_B = "https://kosodate.city.hachioji.tokyo.jp/b.html";

const SET: EvalSet = {
  version: "test-v1",
  questions: [
    {
      id: "q1",
      question: "児童手当はいくら",
      category: "childcare",
      expected: { kind: "answerable", sourceUrls: [URL_A], requiredFacts: ["15,000円"] },
    },
    {
      id: "q2",
      question: "マル乳は何歳まで",
      category: "medical",
      expected: { kind: "answerable", sourceUrls: [URL_B], requiredFacts: ["6歳"] },
    },
    {
      id: "n1",
      question: "市営住宅の家賃",
      category: "welfare",
      expected: { kind: "no_answer", expectedBehavior: "fallback_with_contact" },
    },
  ],
};

const META: RunMeta = {
  ranAt: new Date("2026-11-09T12:00:00.123Z"),
  models: {
    generation: "gen-model",
    judge: "judge-model",
    embedding: { model: "gemini-embedding-001", dimensions: 768, version: "v1" },
  },
};

describe("runIdOf", () => {
  it("実行日時から runId を作る", () => {
    expect(runIdOf(META.ranAt)).toBe("20261109T120000Z");
  });
});

describe("runRetrievalEval", () => {
  it("再現率@5 を答えのある質問だけで計算し、上位5件より後は数えない", async () => {
    const results: Record<string, string[]> = {
      q1: [URL_A],
      // 6件目に正解がある
      q2: ["u1", "u2", "u3", "u4", "u5", URL_B].map((x) =>
        x.startsWith("u") ? `${URL_A}?${x}` : x,
      ),
      n1: [],
    };
    const result = await runRetrievalEval(
      SET,
      { retrieve: async (q) => results[q.id] ?? [] },
      META,
    );
    expect(result.metrics).toEqual({ recallAt5: 0.5 });
    expect(result.perQuestion).toEqual([
      { id: "q1", retrievedHit: true },
      { id: "q2", retrievedHit: false },
      { id: "n1", behavior: "not_found" },
    ]);
    expect(result).toMatchObject({
      runId: "20261109T120000Z",
      ranAt: "2026-11-09T12:00:00.123Z",
      evalSetVersion: "test-v1",
      models: META.models,
    });
    // 保存形式として正しい
    expect(decodeEvalResult(encodeEvalResult(result))).toEqual({ ok: true, value: result });
  });
});

describe("runAnswerEval", () => {
  it("根拠範囲内率と引用の有効率を別々に計算し、答えのない質問は集計に含めない", async () => {
    const outcomes: Record<string, AnswerOutcome> = {
      q1: {
        behavior: "answered",
        text: "月15,000円です[1]。3歳以上は10,000円です[3]。",
        sourcesCount: 2,
        verdicts: ["supported", "unsupported"],
      },
      q2: {
        behavior: "answered",
        text: "6歳になって最初の3月31日までです[1][2]。",
        sourcesCount: 2,
        verdicts: ["supported"],
      },
      n1: { behavior: "fallback", text: "", sourcesCount: 0, verdicts: [] },
    };
    const result = await runAnswerEval(
      SET,
      { answer: async (q) => outcomes[q.id] as AnswerOutcome },
      META,
    );
    expect(result.metrics.groundedRate).toBeCloseTo(2 / 3);
    expect(result.metrics.citationValidRate).toBeCloseTo(3 / 4);
    expect(result.perQuestion).toEqual([
      {
        id: "q1",
        behavior: "answered",
        groundedClaims: 1,
        totalClaims: 2,
        validCitations: 1,
        totalCitations: 2,
      },
      {
        id: "q2",
        behavior: "answered",
        groundedClaims: 1,
        totalClaims: 1,
        validCitations: 2,
        totalCitations: 2,
      },
      {
        id: "n1",
        behavior: "fallback",
        groundedClaims: 0,
        totalClaims: 0,
        validCitations: 0,
        totalCitations: 0,
      },
    ]);
  });

  it("答えた質問が無ければ指標を出さない", async () => {
    const result = await runAnswerEval(
      SET,
      { answer: async () => ({ behavior: "fallback", text: "", sourcesCount: 0, verdicts: [] }) },
      META,
    );
    expect(result.metrics).toEqual({});
  });
});

describe("runPerf", () => {
  function client(timings: ChatTiming[]) {
    const sent: string[] = [];
    return {
      sent,
      send: async (q: string) => {
        sent.push(q);
        return timings[(sent.length - 1) % timings.length] as ChatTiming;
      },
    };
  }

  it("起動済みは1回ウォームアップしてから10回計測し、p50 と p90 を出す", async () => {
    const timings = Array.from({ length: 11 }, (_, i) => ({
      waitingMs: 100 + i,
      firstDeltaMs: 1000 + i * 100,
    }));
    // ウォームアップは極端に遅い値にしておき、集計に入らないことを確かめる
    timings[0] = { waitingMs: 9999, firstDeltaMs: 99999 };
    const c = client(timings);
    const perf = await runPerf(SET, c, { mode: "warm", runs: 10 });
    expect(c.sent).toHaveLength(11);
    expect(perf).toEqual({
      warmWaiting: { p50Ms: 105, p90Ms: 109, samples: 10 },
      warmFirstDelta: { p50Ms: 1500, p90Ms: 1900, samples: 10 },
    });
    // 質問は評価セットから順に使う
    expect(c.sent.slice(1, 4)).toEqual(SET.questions.map((q) => q.question));
  });

  it("コールドスタートは毎回インスタンスを捨ててから計測する。断片が来なければ数えない", async () => {
    let prepared = 0;
    const c = client([
      { waitingMs: 800, firstDeltaMs: 5000 },
      { waitingMs: 900, firstDeltaMs: null },
    ]);
    const perf = await runPerf(SET, c, {
      mode: "cold",
      runs: 4,
      prepareCold: async () => {
        prepared += 1;
      },
    });
    expect(prepared).toBe(4);
    expect(c.sent).toHaveLength(4);
    expect(perf).toEqual({
      coldWaiting: { p50Ms: 800, p90Ms: 900, samples: 4 },
      coldFirstDelta: { p50Ms: 5000, p90Ms: 5000, samples: 2 },
    });
  });

  it("cold で prepareCold が無ければ例外", async () => {
    await expect(runPerf(SET, client([]), { mode: "cold", runs: 1 })).rejects.toThrow(RangeError);
  });
});
