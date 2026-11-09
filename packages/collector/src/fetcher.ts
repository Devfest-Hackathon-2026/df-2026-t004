// HTTP で公的サイトを取得する（Requirement 3.1, 3.2）

import type { Fetcher, FetchResult } from "./ports.js";

// 連絡先として公開リポジトリを示す。個人のメールアドレスは入れない
export const USER_AGENT = "hachioji-gov-collector/0.1 (+https://github.com/yunamaki3/GDGoC2026)";

// 想定外に大きい応答は読まない
export const MAX_BODY_BYTES = 20 * 1024 * 1024;

export class HttpFetcher implements Fetcher {
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async fetch(url: string, opts: { timeoutMs: number }): Promise<FetchResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: { "User-Agent": USER_AGENT },
        redirect: "follow",
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (e) {
      const timeout = e instanceof Error && e.name === "TimeoutError";
      return { kind: "error", reason: timeout ? "timeout" : "network", retryable: true };
    }
    if (res.status === 404 || res.status === 410) {
      await res.body?.cancel();
      return { kind: "not_found", status: res.status };
    }
    if (!res.ok) {
      await res.body?.cancel();
      const retryable = res.status >= 500 || res.status === 429 || res.status === 408;
      return { kind: "error", reason: `http_${res.status}`, retryable };
    }
    const length = Number(res.headers.get("content-length") ?? "0");
    if (length > MAX_BODY_BYTES) {
      await res.body?.cancel();
      return { kind: "error", reason: "too_large", retryable: false };
    }
    let body: Uint8Array;
    try {
      body = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      const timeout = e instanceof Error && e.name === "TimeoutError";
      return { kind: "error", reason: timeout ? "timeout" : "network", retryable: true };
    }
    if (body.byteLength > MAX_BODY_BYTES) {
      return { kind: "error", reason: "too_large", retryable: false };
    }
    return {
      kind: "ok",
      status: res.status,
      contentType: res.headers.get("content-type") ?? "",
      body,
    };
  }
}
