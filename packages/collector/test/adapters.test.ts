import { describe, expect, it } from "vitest";
import {
  HttpFetcher,
  USER_AGENT,
  VertexEmbedder,
  VertexExtractor,
  type GenAiModels,
} from "../src/index.js";

const URL_A = "https://www.city.hachioji.tokyo.jp/a.html";

function stubFetch(make: () => Response | Promise<Response>) {
  const seen: RequestInit[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    seen.push(init ?? {});
    return make();
  }) as typeof fetch;
  return { impl, seen };
}

describe("HttpFetcher", () => {
  it("成功なら本文と Content-Type を返し、決まった User-Agent とタイムアウトを付ける", async () => {
    const { impl, seen } = stubFetch(
      () => new Response("本文", { status: 200, headers: { "content-type": "text/html" } }),
    );
    const res = await new HttpFetcher(impl).fetch(URL_A, { timeoutMs: 30_000 });
    expect(res).toMatchObject({ kind: "ok", status: 200, contentType: "text/html" });
    if (res.kind === "ok") expect(new TextDecoder().decode(res.body)).toBe("本文");
    expect(new Headers(seen[0]?.headers).get("user-agent")).toBe(USER_AGENT);
    expect(seen[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("404・410 は「見つからない」、5xx・429 は再試行する失敗、他の 4xx は再試行しない失敗", async () => {
    const cases: [number, unknown][] = [
      [404, { kind: "not_found", status: 404 }],
      [410, { kind: "not_found", status: 410 }],
      [503, { kind: "error", reason: "http_503", retryable: true }],
      [429, { kind: "error", reason: "http_429", retryable: true }],
      [403, { kind: "error", reason: "http_403", retryable: false }],
    ];
    for (const [status, expected] of cases) {
      const { impl } = stubFetch(() => new Response("x", { status }));
      expect(await new HttpFetcher(impl).fetch(URL_A, { timeoutMs: 1000 })).toEqual(expected);
    }
  });

  it("タイムアウトと通信エラーは再試行する失敗", async () => {
    const timeout = stubFetch(() => {
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(await new HttpFetcher(timeout.impl).fetch(URL_A, { timeoutMs: 1 })).toEqual({
      kind: "error",
      reason: "timeout",
      retryable: true,
    });
    const network = stubFetch(() => {
      throw new TypeError("fetch failed");
    });
    expect(await new HttpFetcher(network.impl).fetch(URL_A, { timeoutMs: 1 })).toEqual({
      kind: "error",
      reason: "network",
      retryable: true,
    });
  });

  it("大きすぎる応答は読まない", async () => {
    const { impl } = stubFetch(
      () => new Response("x", { status: 200, headers: { "content-length": String(1e9) } }),
    );
    expect(await new HttpFetcher(impl).fetch(URL_A, { timeoutMs: 1000 })).toEqual({
      kind: "error",
      reason: "too_large",
      retryable: false,
    });
  });
});

function models(over: Partial<GenAiModels>): GenAiModels {
  return {
    embedContent: async () => ({}),
    generateContent: async () => ({}),
    ...over,
  };
}

const TARGET = { model: "gemini-embedding-001", dimensions: 3, version: "v1" };

describe("VertexEmbedder", () => {
  it("1件ずつ設定の次元で埋め込み、L2 正規化して返す", async () => {
    const params: unknown[] = [];
    const embedder = new VertexEmbedder(
      models({
        embedContent: async (p) => {
          params.push(p);
          return { embeddings: [{ values: [3, 4, 0] }] };
        },
      }),
    );
    const out = await embedder.embed(["a", "b"], "RETRIEVAL_DOCUMENT", TARGET);
    expect(out).toEqual([
      [0.6, 0.8, 0],
      [0.6, 0.8, 0],
    ]);
    expect(params).toEqual([
      {
        model: "gemini-embedding-001",
        contents: "a",
        config: { taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 3, autoTruncate: true },
      },
      {
        model: "gemini-embedding-001",
        contents: "b",
        config: { taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 3, autoTruncate: true },
      },
    ]);
  });

  it("次元が違う・空の応答は例外", async () => {
    for (const res of [{ embeddings: [{ values: [1, 0] }] }, { embeddings: [] }, {}]) {
      const embedder = new VertexEmbedder(models({ embedContent: async () => res }));
      await expect(embedder.embed(["a"], "RETRIEVAL_DOCUMENT", TARGET)).rejects.toThrow(RangeError);
    }
  });
});

describe("VertexExtractor", () => {
  it("JSON スキーマと温度 0 で抽出し、JSON を返す。資料は区切って渡す", async () => {
    const params: Parameters<GenAiModels["generateContent"]>[0][] = [];
    const extractor = new VertexExtractor(
      models({
        generateContent: async (p) => {
          params.push(p);
          return { text: '{"name":"児童手当","deadline":null}' };
        },
      }),
      "gemini-x",
      1024,
    );
    expect(await extractor.extractProgram("本文")).toEqual({ name: "児童手当", deadline: null });
    expect(params[0]).toMatchObject({
      model: "gemini-x",
      contents: "<資料>\n本文\n</資料>",
      config: { responseMimeType: "application/json", temperature: 0, maxOutputTokens: 1024 },
    });
    expect(params[0]?.config.systemInstruction).toContain("推測");
  });

  it("応答が無い・JSON でないときは null（すべての項目が空になる）", async () => {
    for (const res of [{}, { text: "not json" }]) {
      const extractor = new VertexExtractor(models({ generateContent: async () => res }), "m", 10);
      expect(await extractor.extractProgram("x")).toBeNull();
    }
  });
});
