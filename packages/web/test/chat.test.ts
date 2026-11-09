import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  EMPTY_ANSWER,
  applyChatEvent,
  checkQuestion,
  interruptAnswer,
  splitCitations,
  toChatEvent,
  type ChatEvent,
} from "../src/lib/chat.js";
import { createSseParser, type SseMessage } from "../src/lib/sse.js";
import { createMockChatApi } from "../src/services/chatApi.js";

const run = (events: ChatEvent[]) => events.reduce(applyChatEvent, EMPTY_ANSWER);

describe("SSE の解析", () => {
  it("どこで区切って届いても、同じイベント列になる", () => {
    const raw =
      'event: status\ndata: {"status":"accepted"}\n\n: comment\nevent: delta\ndata: {"text":"あ"}\n\r\nevent: delta\ndata: {"text":"い"}\n\nevent: verified\ndata: {}\n\n';
    const whole: SseMessage[] = [];
    const p1 = createSseParser((m) => whole.push(m));
    p1.feed(raw);
    p1.end();
    expect(whole.map((m) => m.event)).toEqual(["status", "delta", "delta", "verified"]);
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: raw.length }), { maxLength: 8 }), (cuts) => {
        const pts = [...new Set([0, ...cuts, raw.length])].sort((a, b) => a - b);
        const got: SseMessage[] = [];
        const p = createSseParser((m) => got.push(m));
        for (let i = 0; i < pts.length - 1; i++) p.feed(raw.slice(pts[i], pts[i + 1]));
        p.end();
        expect(got).toEqual(whole);
      }),
    );
  });
});

describe("回答の状態（Requirement 5.7, 5.12, 12.3, 12.7）", () => {
  it("delta は届いた順に追加し、reset で下書きを捨てる", () => {
    expect(
      run([
        { type: "delta", text: "あい" },
        { type: "delta", text: "う" },
      ]),
    ).toMatchObject({ status: "draft", text: "あいう" });
    expect(run([{ type: "delta", text: "x" }, { type: "reset" }])).toMatchObject({
      status: "waiting",
      text: "",
    });
  });

  it("fallback では本文を事実として表示しない", () => {
    const a = run([
      { type: "delta", text: "根拠のない主張" },
      { type: "fallback", sources: [], contact: "窓口" },
    ]);
    expect(a).toMatchObject({ status: "fallback", text: "", contact: "窓口" });
  });

  it("次の質問候補は最大3件", () => {
    fc.assert(
      fc.property(fc.array(fc.string(), { maxLength: 10 }), (s) => {
        expect(run([{ type: "suggestions", suggestions: s }]).suggestions.length).toBe(
          Math.min(3, s.length),
        );
      }),
    );
  });

  it("確定前に切れたら、途中までの回答を残して interrupted にする", () => {
    expect(interruptAnswer(run([{ type: "delta", text: "途中" }]))).toMatchObject({
      status: "interrupted",
      text: "途中",
    });
    expect(
      interruptAnswer(run([{ type: "delta", text: "全部" }, { type: "verified" }])).status,
    ).toBe("verified");
  });

  it("確定の後の delta は無視する", () => {
    expect(
      run([{ type: "delta", text: "a" }, { type: "verified" }, { type: "delta", text: "b" }]).text,
    ).toBe("a");
  });

  it("SSE のデータを型に変え、壊れたものは捨てる", () => {
    expect(toChatEvent("delta", '{"text":"x"}')).toEqual({ type: "delta", text: "x" });
    expect(toChatEvent("error", '{"message":"上限","retryAt":"0:00"}')).toEqual({
      type: "error",
      message: "上限",
      retryAt: "0:00",
    });
    expect(toChatEvent("sources", '{"sources":[{"n":1,"title":"t","url":"u"},{"bad":1}]}')).toEqual(
      {
        type: "sources",
        sources: [{ n: 1, title: "t", url: "u" }],
      },
    );
    expect(toChatEvent("unknown", "{}")).toBeNull();
    expect(toChatEvent("proposal", "{}")).toBeNull();
  });
});

describe("質問の文字数（Requirement 5.9）", () => {
  it("1〜500文字のときだけ送れて、超えたら文字数を示す", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 700 }), (n) => {
        const r = checkQuestion("あ".repeat(n));
        expect(r.ok).toBe(n <= 500);
        expect(r.count).toBe(n);
        if (n > 500) expect(r.message).toContain(`${n}文字`);
      }),
    );
    expect(checkQuestion("   ").ok).toBe(false);
  });
});

describe("引用番号の分割", () => {
  it("[n] を取り出し、残りの文字はそのまま", () => {
    expect(splitCitations("あ[1]い[12]")).toEqual([
      { kind: "text", text: "あ" },
      { kind: "cite", n: 1 },
      { kind: "text", text: "い" },
      { kind: "cite", n: 12 },
    ]);
    fc.assert(
      fc.property(fc.string(), (s) => {
        fc.pre(!/\[0\d?\]/.test(s));
        const joined = splitCitations(s)
          .map((p) => (p.kind === "text" ? p.text : `[${p.n}]`))
          .join("");
        expect(joined).toBe(s);
      }),
    );
  });
});

describe("チャットの仮実装", () => {
  it("通常は verified・出典・候補・制度の提案まで届く。保育園の質問は fallback になる", async () => {
    const api = createMockChatApi();
    const ev: ChatEvent[] = [];
    await api.ask({ question: "通院費は？" }, (e) => ev.push(e), new AbortController().signal);
    const a = run(ev);
    expect(a.status).toBe("verified");
    expect(a.sources.length).toBe(2);
    expect(a.proposal?.programId).toBe("infant-medical");
    const fb: ChatEvent[] = [];
    await api.ask(
      { question: "保育園に入れる？" },
      (e) => fb.push(e),
      new AbortController().signal,
    );
    expect(fb.map((e) => e.type)).toContain("reset");
    expect(run(fb).status).toBe("fallback");
  }, 20_000);
});
