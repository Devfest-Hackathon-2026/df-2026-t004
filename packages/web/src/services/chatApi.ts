// AI 相談の API（POST /chat、SSE）。本物（T17）ができるまでは仮実装でストリーミングを再現する。

import { API_BASE } from "../lib/api";
import { toChatEvent, type ChatEvent, type ChatSource } from "../lib/chat";
import { createSseParser } from "../lib/sse";

export type ChatRequest = { readonly question: string; readonly programId?: string };

export interface ChatApi {
  /** イベントを順に onEvent へ渡す。確定前に切れたときは reject する */
  ask(req: ChatRequest, onEvent: (e: ChatEvent) => void, signal: AbortSignal): Promise<void>;
}

export const FIRST_EVENT_TIMEOUT_MS = 30_000;

export function createHttpChatApi(idToken: () => Promise<string | null>): ChatApi {
  return {
    async ask(req, onEvent, signal) {
      const token = await idToken();
      const ctrl = new AbortController();
      signal.addEventListener("abort", () => ctrl.abort());
      // 30秒以内に応答が始まらなければ失敗にする（Requirement 5.10）
      const timer = setTimeout(() => ctrl.abort(), FIRST_EVENT_TIMEOUT_MS);
      try {
        const res = await fetch(`${API_BASE}/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(req),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`POST /chat ${res.status}`);
        const parser = createSseParser((m) => {
          clearTimeout(timer);
          const e = toChatEvent(m.event, m.data);
          if (e) onEvent(e);
        });
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parser.feed(value);
        }
        parser.end();
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

const MOCK_SOURCES: ChatSource[] = [
  {
    n: 1,
    title: "[資料名（八王子市のページ）]",
    url: "https://www.city.hachioji.tokyo.jp/",
    fetchedAt: "2026-10-01",
  },
  {
    n: 2,
    title: "[資料名（PDF）p.3]",
    url: "https://example.com/doc.pdf",
    fetchedAt: "2026-10-01",
  },
];
const MOCK_ANSWER =
  "0歳の子どもの通院費は、八王子市の医療費助成の対象になる可能性があります。[1]\n保険診療の自己負担分が助成されます（ダミーの回答）。[2]\n申請には医療証の交付申請が必要です。[1]";

/**
 * 仮実装。質問の言葉で、次の場合を再現する。
 * - 「保育園」「根拠」: 下書き → reset → 再生成 → fallback（根拠を確認できませんでした）
 * - 「熱」「診断」「症状」: 回答を作らず、医師への相談を案内する（fallback）
 * - 「上限」: 日次上限のエラー（再開時刻つき）
 * - 「中断」: 途中で接続が切れる
 */
export function createMockChatApi(): ChatApi {
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      });
    });
  const stream = async (
    text: string,
    onEvent: (e: ChatEvent) => void,
    signal: AbortSignal,
    stopAt?: number,
  ) => {
    const chars = [...text];
    for (let i = 0; i < chars.length; i += 4) {
      if (stopAt !== undefined && i >= stopAt) throw new Error("stream interrupted");
      onEvent({ type: "delta", text: chars.slice(i, i + 4).join("") });
      await sleep(40, signal);
    }
  };
  return {
    async ask(req, onEvent, signal) {
      onEvent({ type: "status", status: "accepted" });
      await sleep(600, signal);
      const q = req.question;
      if (q.includes("上限")) {
        onEvent({
          type: "error",
          message: "きょうの AI 相談の回数の上限に達しました。",
          // API と同じく、日本時間の翌日0時を ISO で返す
          retryAt: new Date(
            Date.parse(new Date(Date.now() + 9 * 3_600_000).toISOString().slice(0, 10)) +
              15 * 3_600_000,
          ).toISOString(),
          contact: "[八王子市 子育て支援課（ダミー）] 042-000-0000",
        });
        return;
      }
      if (/熱|診断|症状/.test(q)) {
        // 医療の判断を求める質問は、回答を作らずに医師への相談を案内する（API と同じ）
        onEvent({
          type: "fallback",
          message:
            "体調や治療についての判断はできません。気になる症状があるときは、医師に相談してください。",
          sources: [],
          contact: "[八王子市 休日・夜間の診療案内（ダミー）] 042-000-0000",
        });
        return;
      }
      if (/保育園|根拠/.test(q)) {
        await stream("保育園の入園については、[3] の資料によると……", onEvent, signal);
        onEvent({ type: "reset" });
        await sleep(500, signal);
        await stream("入園の条件は……[4]", onEvent, signal);
        onEvent({
          type: "fallback",
          sources: MOCK_SOURCES,
          contact: "[八王子市 保育幼稚園課（ダミー）] 042-000-0000",
        });
        return;
      }
      await stream(MOCK_ANSWER, onEvent, signal, q.includes("中断") ? 40 : undefined);
      onEvent({ type: "verified" });
      onEvent({ type: "sources", sources: MOCK_SOURCES });
      onEvent({
        type: "proposal",
        programId: req.programId ?? "infant-medical",
        programName: "[乳幼児の医療費助成（ダミー）]",
      });
      onEvent({
        type: "suggestions",
        suggestions: [
          "申請に必要なものは？",
          "いつまでに申請すればいい？",
          "保育園に入れるか心配",
          "4つめ（表示されない）",
        ],
      });
    },
  };
}
