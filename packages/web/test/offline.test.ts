import { describe, expect, it } from "vitest";
import { fetchCached } from "../src/lib/api.js";
import {
  STALE_PREFIX,
  formatJstDateTime,
  readCacheInfo,
  staleMessage,
} from "../src/lib/offline.js";

const json = (body: unknown, headers: Record<string, string> = {}, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

describe("オフライン時の表示（Requirement 12.5, 12.6）", () => {
  it("Service Worker のキャッシュから返した応答は stale になり、取得時刻を日本時間で示す", () => {
    const info = readCacheInfo(
      new Headers({ "X-SW-Cache": "hit", "X-Cached-At": "2026-11-07T12:14:00Z" }),
    );
    expect(info).toEqual({ stale: true, cachedAt: "2026-11-07T12:14:00Z" });
    expect(staleMessage(info.cachedAt)).toBe(`${STALE_PREFIX} ・ 最終取得 2026/11/07 21:14`);
    expect(formatJstDateTime("2026-12-31T15:00:00Z")).toBe("2027/01/01 00:00");
  });

  it("ネットワークから返した応答は stale ではない。時刻が不正なら無視する", () => {
    expect(readCacheInfo(new Headers({ "X-Cached-At": "not a date" }))).toEqual({
      stale: false,
      cachedAt: null,
    });
    expect(staleMessage(null)).toBe(STALE_PREFIX);
  });

  it("fetchCached: ネットワークにもキャッシュにも無ければ offline-uncached", async () => {
    const offline = (() =>
      Promise.reject(new TypeError("Failed to fetch"))) as unknown as typeof fetch;
    expect(await fetchCached("/programs/p1", {}, offline)).toEqual({ status: "offline-uncached" });
  });

  it("fetchCached: 成功・キャッシュ・404・エラーを区別する", async () => {
    const fake = (res: Response) => (() => Promise.resolve(res)) as unknown as typeof fetch;
    expect(await fetchCached("/programs/p1", {}, fake(json({ name: "x" })))).toEqual({
      status: "ok",
      data: { name: "x" },
      stale: false,
      cachedAt: null,
    });
    expect(
      await fetchCached(
        "/programs/p1",
        {},
        fake(json({ name: "x" }, { "X-SW-Cache": "hit", "X-Cached-At": "2026-11-07T12:14:00Z" })),
      ),
    ).toMatchObject({ status: "ok", stale: true });
    expect(await fetchCached("/programs/p1", {}, fake(json({}, {}, 404)))).toEqual({
      status: "not-found",
    });
    expect(await fetchCached("/programs/p1", {}, fake(json({}, {}, 500)))).toEqual({
      status: "error",
      httpStatus: 500,
    });
  });

  it("fetchCached は /api を前に付け、GET で呼ぶ", async () => {
    let seen: [string, RequestInit | undefined] | null = null;
    const spy = ((url: string, init?: RequestInit) => {
      seen = [url, init];
      return Promise.resolve(json({}));
    }) as unknown as typeof fetch;
    await fetchCached("/programs/a%2Fb", { method: "POST" }, spy);
    expect(seen![0]).toBe("/api/programs/a%2Fb");
    expect(seen![1]?.method).toBe("GET");
  });
});
