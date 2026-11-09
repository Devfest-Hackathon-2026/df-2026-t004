// API クライアントの土台。Firebase Hosting のリライトで /api/** が Cloud Run に届く。

import { readCacheInfo, type CacheInfo } from "./offline";

export const API_BASE = "/api";

export type CachedFetchResult<T> =
  | ({ readonly status: "ok"; readonly data: T } & CacheInfo)
  | { readonly status: "offline-uncached" }
  | { readonly status: "not-found" }
  | { readonly status: "error"; readonly httpStatus?: number };

/**
 * Service Worker のキャッシュ対象（GET /api/programs/:id など）を取得する。
 * ネットワークにもキャッシュにも無いときは offline-uncached を返す。
 */
export async function fetchCached<T>(
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<CachedFetchResult<T>> {
  let res: Response;
  try {
    res = await fetchImpl(`${API_BASE}${path}`, { ...init, method: "GET" });
  } catch {
    return { status: "offline-uncached" };
  }
  if (res.status === 404) return { status: "not-found" };
  if (!res.ok) return { status: "error", httpStatus: res.status };
  try {
    const data = (await res.json()) as T;
    return { status: "ok", data, ...readCacheInfo(res.headers) };
  } catch {
    return { status: "error", httpStatus: res.status };
  }
}
