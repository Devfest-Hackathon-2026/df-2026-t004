// POST /chat（SSE）への送信と時間の計測（Requirement 12.1, 12.2, 12.8）

import type { ChatClient, ChatTiming } from "./runner.js";

export type HttpChatClientOptions = {
  url: string;
  // 計測用アカウントの ID トークン（環境変数から渡す。ファイルやログに残さない）
  idToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

/** SSE の文字列から、完結したイベントの名前を順に取り出す。残りは rest に返す */
export function takeEvents(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events = blocks.map((block) => {
    const line = block.split("\n").find((l) => l.startsWith("event:"));
    return line === undefined ? "message" : line.slice("event:".length).trim();
  });
  return { events, rest };
}

export class HttpChatClient implements ChatClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: HttpChatClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => performance.now());
  }

  async send(question: string): Promise<ChatTiming> {
    const started = this.now();
    const res = await this.fetchImpl(this.options.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        Authorization: `Bearer ${this.options.idToken}`,
      },
      body: JSON.stringify({ question }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 60_000),
    });
    if (!res.ok || res.body === null) throw new Error(`chat request failed: ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let waitingMs: number | null = null;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const { events, rest } = takeEvents(buffer + decoder.decode(value, { stream: true }));
        buffer = rest;
        for (const event of events) {
          const elapsed = this.now() - started;
          if (event === "status" && waitingMs === null) waitingMs = elapsed;
          if (event === "delta") return { waitingMs: waitingMs ?? elapsed, firstDeltaMs: elapsed };
          if (event === "fallback" || event === "error") {
            return { waitingMs: waitingMs ?? elapsed, firstDeltaMs: null };
          }
        }
      }
    } finally {
      // 最初の断片まで測れば十分。残りは読まずに閉じる
      await reader.cancel().catch(() => {});
    }
    if (waitingMs === null) throw new Error("no status event");
    return { waitingMs, firstDeltaMs: null };
  }
}
