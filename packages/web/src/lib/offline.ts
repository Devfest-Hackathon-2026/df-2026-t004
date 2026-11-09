// オフライン時の表示（Requirement 11.9, 12.4〜12.6）

export const OFFLINE_BANNER_MESSAGE =
  "オフラインです。入力した内容は保持されます。AI相談などの一部の機能は使えません。";
export const STALE_PREFIX = "最新でない可能性があります";
export const UNCACHED_OFFLINE_MESSAGE =
  "オフラインのため、この制度の情報を表示できません。前に開いた制度は、オフラインでも見られます。";

type HeaderReader = { get(name: string): string | null };

export type CacheInfo = {
  /** Service Worker のキャッシュから返された（ネットワークに届かなかった・5秒を超えた） */
  readonly stale: boolean;
  /** サーバーが応答を作った時刻（ISO 8601）。キャッシュの時刻として表示する */
  readonly cachedAt: string | null;
};

export function readCacheInfo(headers: HeaderReader): CacheInfo {
  const at = headers.get("X-Cached-At");
  return {
    stale: headers.get("X-SW-Cache") === "hit",
    cachedAt: at && !Number.isNaN(Date.parse(at)) ? at : null,
  };
}

/** 日本時間で `YYYY/MM/DD HH:mm` */
export function formatJstDateTime(iso: string): string {
  const t = new Date(Date.parse(iso) + 9 * 3_600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}/${p(t.getUTCMonth() + 1)}/${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
}

export function staleMessage(cachedAt: string | null): string {
  return cachedAt ? `${STALE_PREFIX} ・ 最終取得 ${formatJstDateTime(cachedAt)}` : STALE_PREFIX;
}
