import { describe, expect, it } from "vitest";
import { HttpChatClient, takeEvents } from "../src/index.js";

describe("takeEvents", () => {
  it("完結したイベントの名前だけを返し、途中の分は残す", () => {
    expect(takeEvents('event: status\ndata: {}\n\nevent: delta\ndata: "a"\n\nevent: so')).toEqual({
      events: ["status", "delta"],
      rest: "event: so",
    });
    expect(takeEvents("data: x\r\n\r\n")).toEqual({ events: ["message"], rest: "" });
  });
});

// 決まった時刻にチャンクを返す SSE の応答
function sseClient(chunks: [number, string][], status = 200) {
  let clock = 0;
  const seen: RequestInit[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(init ?? {});
    let i = 0;
    // 読まれたときにだけ次のチャンクを出す（先読みさせない）
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          const next = chunks[i++];
          if (next === undefined) {
            controller.close();
            return;
          }
          clock = next[0];
          controller.enqueue(new TextEncoder().encode(next[1]));
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, { status, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const client = new HttpChatClient({
    url: "https://api.example.com/chat",
    idToken: "test-token",
    fetchImpl,
    now: () => clock,
  });
  return { client, seen };
}

describe("HttpChatClient", () => {
  it("status までと最初の delta までの時間を測る", async () => {
    const { client, seen } = sseClient([
      [120, "event: status\ndata: {}\n\n"],
      [900, "event: del"],
      [1500, 'ta\ndata: "a"\n\n'],
      [2000, 'event: delta\ndata: "b"\n\n'],
    ]);
    expect(await client.send("質問")).toEqual({ waitingMs: 120, firstDeltaMs: 1500 });
    const init = seen[0];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-token");
    expect(new Headers(init?.headers).get("accept")).toBe("text/event-stream");
    expect(init?.body).toBe(JSON.stringify({ question: "質問" }));
  });

  it("fallback なら断片なしとして返す", async () => {
    const { client } = sseClient([
      [100, "event: status\ndata: {}\n\n"],
      [3000, "event: fallback\ndata: {}\n\n"],
    ]);
    expect(await client.send("q")).toEqual({ waitingMs: 100, firstDeltaMs: null });
  });

  it("失敗の応答や status の無い応答は例外", async () => {
    await expect(sseClient([], 429).client.send("q")).rejects.toThrow("429");
    await expect(sseClient([[10, ": ping\n\n"]]).client.send("q")).rejects.toThrow("no status");
  });
});
