// AI 相談（POST /chat, GET /users/:uid/chats）の単体テスト（Requirement 5, 9.9, 10, 12, 13.12）
import { createLogger, scanLogForLeaks } from "@hachioji-gov/shared";
import { describe, expect, it } from "vitest";
import {
  createApi,
  MEDICAL_MESSAGE,
  mountChat,
  NO_SOURCES_MESSAGE,
  TIMEOUT_MESSAGE,
  type IdTokenVerifier,
} from "../src/index.js";
import { CANARIES, CANARY_QUESTION } from "./support/canaries.js";
import { chatDeps, GOOD_ANSWER, parseSse } from "./support/chat-fakes.js";

const verifier: IdTokenVerifier = {
  verifyIdToken: async (token) => {
    if (!token.startsWith("token-")) throw new Error("invalid");
    return { uid: token.slice("token-".length) };
  },
};

function setup(over: Parameters<typeof chatDeps>[0] = {}) {
  const fakes = chatDeps(over);
  const lines: string[] = [];
  const api = createApi({
    config: {
      rateLimit: { perUserPerMinute: 100, perIpPerMinute: 100, windowSec: 60, maxEntries: 100 },
    },
    verifier,
    logger: createLogger({ sink: (line) => lines.push(line) }),
  });
  mountChat(api, fakes.deps);
  const ask = async (body: unknown, uid = "u1") => {
    const res = await api.app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer token-${uid}` },
      body: JSON.stringify(body),
    });
    return { res, events: res.status === 200 ? parseSse(await res.text()) : [] };
  };
  return { ...fakes, api, lines, ask };
}

const names = (events: { event: string }[]) => events.map((e) => e.event);
const dataOf = (events: { event: string; data: unknown }[], name: string) =>
  events.find((e) => e.event === name)?.data as Record<string, unknown> | undefined;

describe("POST /chat", () => {
  it("検証を通った回答は verified・sources・suggestions・proposal の順で送り、履歴に保存する", async () => {
    const t = setup();
    const { res, events } = await t.ask({ question: "児童手当はいくらですか" });
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(names(events)).toEqual([
      "status",
      "delta",
      "delta",
      "verified",
      "sources",
      "suggestions",
      "proposal",
    ]);
    expect(dataOf(events, "verified")).toEqual({ text: GOOD_ANSWER, chatId: "chat1" });
    // 引用した [1] だけを出典にする
    const sources = dataOf(events, "sources")?.["sources"] as { n: number; title: string }[];
    expect(sources.map((s) => [s.n, s.title])).toEqual([[1, "児童手当"]]);
    expect(dataOf(events, "proposal")).toEqual({
      programs: [{ programId: "city-jido-teate", name: "児童手当" }],
    });
    expect((dataOf(events, "suggestions")?.["items"] as string[]).length).toBeLessThanOrEqual(3);
    expect(t.store.chats.get("u1")).toHaveLength(1);
    // 国・都・世帯の自治体で絞り、設定の版の埋め込みフィールドで検索する
    expect(t.searches[0]?.embeddingField).toBe("emb_v1");
    expect(t.searches[0]?.minSimilarity).toBe(0.3);
  });

  it("資料が見つからないときは LLM を呼ばずに案内を返す", async () => {
    const t = setup({ chunks: [] });
    const { events } = await t.ask({ question: "児童手当はいくらですか" });
    expect(names(events)).toEqual(["status", "fallback"]);
    expect(dataOf(events, "fallback")).toMatchObject({
      reason: "no_sources",
      message: NO_SOURCES_MESSAGE,
      sources: [],
    });
    expect(dataOf(events, "fallback")?.["contact"]).toContain("八王子市");
    expect(t.llm.generateCalls).toBe(0);
    expect(t.store.chats.size).toBe(0);
  });

  it("診断・治療の判断を求める質問には答えず、医師と窓口を案内する", async () => {
    const t = setup();
    t.llm.intent = "medical_judgment";
    const { events } = await t.ask({ question: "熱があるけど薬を飲ませていい？" });
    expect(names(events)).toEqual(["status", "fallback"]);
    expect(dataOf(events, "fallback")).toMatchObject({
      reason: "medical_judgment",
      message: MEDICAL_MESSAGE,
    });
    expect(t.searches).toHaveLength(0);
    expect(t.llm.generateCalls).toBe(0);
  });

  it("引用が無効なら reset して作り直し、2回目が通れば verified", async () => {
    const t = setup();
    t.llm.answers = ["児童手当は月15,000円です[9]。", GOOD_ANSWER];
    const { events } = await t.ask({ question: "児童手当はいくらですか" });
    expect(names(events)).toEqual([
      "status",
      "delta",
      "delta",
      "reset",
      "delta",
      "delta",
      "verified",
      "sources",
      "suggestions",
      "proposal",
    ]);
    expect(t.llm.generateCalls).toBe(2);
    // 引用が無効な回答は根拠の判定に回さない
    expect(t.llm.judgeCalls).toBe(1);
  });

  it("根拠の範囲外と判定されたら作り直す", async () => {
    const t = setup();
    let calls = 0;
    t.llm.verdicts = (n) => {
      calls += 1;
      return Array.from({ length: n }, () => (calls === 1 ? "unsupported" : "supported"));
    };
    const { events } = await t.ask({ question: "児童手当はいくらですか" });
    expect(names(events)).toContain("reset");
    expect(names(events)).toContain("verified");
    expect(t.llm.generateCalls).toBe(2);
  });

  it("作り直しても通らなければ、回答本文を出さずに出典と窓口だけを返す", async () => {
    const t = setup();
    t.llm.answers = ["引用のない回答です。"];
    const { events } = await t.ask({ question: "児童手当はいくらですか" });
    expect(names(events).at(-1)).toBe("fallback");
    expect(names(events)).not.toContain("verified");
    const fallback = dataOf(events, "fallback");
    expect(fallback?.["reason"]).toBe("unverified");
    expect(JSON.stringify(fallback)).not.toContain("引用のない回答です。");
    expect((fallback?.["sources"] as unknown[]).length).toBeGreaterThan(0);
    expect(t.store.chats.size).toBe(0);
  });

  it("1人の1日の上限に達したら、翌日0時（日本時間）と窓口を返す", async () => {
    const t = setup();
    t.deps.settings.limits = { perUserPerDay: 1, globalPerDay: 500 };
    await t.ask({ question: "児童手当はいくらですか" });
    const { events } = await t.ask({ question: "児童手当はいくらですか" });
    expect(dataOf(events, "error")).toMatchObject({
      reason: "quota_user",
      retryAt: "2026-11-09T15:00:00.000Z",
    });
    expect(dataOf(events, "error")?.["contact"]).toContain("八王子市");
    expect(t.llm.generateCalls).toBe(1);
  });

  it("全体の1日の上限に達したら quota_global", async () => {
    const t = setup();
    t.deps.settings.limits = { perUserPerDay: 20, globalPerDay: 1 };
    await t.ask({ question: "児童手当はいくらですか" }, "u1");
    const { events } = await t.ask({ question: "児童手当はいくらですか" }, "u2");
    expect(dataOf(events, "error")?.["reason"]).toBe("quota_global");
  });

  it("運営スイッチが止まっていれば、LLM を呼ばずに停止を伝える", async () => {
    const t = setup({ ops: { aiEnabled: false, collectionEnabled: true } });
    const { events } = await t.ask({ question: "児童手当はいくらですか" });
    expect(dataOf(events, "error")?.["reason"]).toBe("ops_stopped");
    expect(t.llm.intentCalls).toBe(0);
  });

  it("文字数が範囲外の質問は回数を使わず、文字数を返す", async () => {
    const t = setup();
    const { events } = await t.ask({ question: "あ".repeat(501) });
    expect(dataOf(events, "error")).toMatchObject({ reason: "invalid_question", length: 501 });
    expect(t.usage.counts.size).toBe(0);
    const empty = await t.ask({ question: "   " });
    expect(dataOf(empty.events, "error")?.["reason"]).toBe("invalid_question");
  });

  it("最初の断片が時間内に来なければ、タイムアウトを伝えて保存しない", async () => {
    const t = setup();
    t.deps.settings.firstTokenTimeoutSec = 0.05;
    t.llm.firstDelayMs = 1000;
    const { events } = await t.ask({ question: "児童手当はいくらですか" });
    expect(dataOf(events, "error")).toEqual({ reason: "timeout", message: TIMEOUT_MESSAGE });
    expect(t.store.chats.size).toBe(0);
  });

  it("生成に失敗したら generation_failed を返す", async () => {
    const t = setup();
    t.llm.failGenerate = true;
    const { events } = await t.ask({ question: "児童手当はいくらですか" });
    expect(dataOf(events, "error")?.["reason"]).toBe("generation_failed");
  });

  it("LLM と埋め込みには、電話番号とメールを伏せた質問だけを渡す", async () => {
    const t = setup();
    const question = "090-0000-0000 か someone@example.com に連絡がほしいです。児童手当は？";
    await t.ask({ question });
    const sent = [...t.llm.intentQuestions, ...t.embedded, ...t.llm.seen.map((s) => s.question)];
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) {
      expect(s).not.toContain("090-0000-0000");
      expect(s).not.toContain("someone@example.com");
    }
    // 保存する履歴も伏せたもの
    expect(t.store.chats.get("u1")?.[0]?.question).not.toContain("090-0000-0000");
  });

  it("質問文と回答はログに出ない", async () => {
    const t = setup();
    t.llm.answers = [`${CANARY_QUESTION}です[1]。`];
    await t.ask({ question: CANARY_QUESTION });
    expect(t.lines.length).toBeGreaterThan(0);
    expect(scanLogForLeaks(t.lines.join("\n"), { canaries: CANARIES })).toEqual([]);
  });

  it("本文の形が違えば 400、トークンが無ければ 401", async () => {
    const t = setup();
    expect((await t.ask({ q: "x" })).res.status).toBe(400);
    expect((await t.ask({ question: "x", category: "unknown" })).res.status).toBe(400);
    expect((await t.ask({ question: "x", programId: "../x" })).res.status).toBe(400);
    const res = await t.api.app.request("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("制度を指定したときは、その制度の資料だけで検索する", async () => {
    const t = setup();
    await t.ask({ question: "対象は？", programId: "city-jido-teate" });
    expect(t.searches[0]?.queries).toEqual([{ programId: "city-jido-teate", searchable: true }]);
  });
});

describe("GET /users/:uid/chats", () => {
  it("本人の履歴だけを新しい順に返し、他人の履歴は 403", async () => {
    const t = setup();
    await t.ask({ question: "児童手当はいくらですか" });
    await t.ask({ question: "乳幼児医療費助成について" });
    const own = await t.api.app.request("/users/u1/chats", {
      headers: { Authorization: "Bearer token-u1" },
    });
    expect(own.status).toBe(200);
    const body = (await own.json()) as { chats: { id: string }[] };
    expect(body.chats.map((c) => c.id)).toEqual(["chat2", "chat1"]);
    const other = await t.api.app.request("/users/u1/chats", {
      headers: { Authorization: "Bearer token-u2" },
    });
    expect(other.status).toBe(403);
  });
});
