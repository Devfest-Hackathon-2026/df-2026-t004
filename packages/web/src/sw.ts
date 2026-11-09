// Service Worker（Requirement 12.4〜12.6）
// - 静的資産は Precache
// - GET /api/programs/:id は NetworkFirst（5秒で諦めてキャッシュ）、最大50件
//   キャッシュから返したときは X-SW-Cache: hit を付け、画面で「最新でない可能性」を出す
// - それ以外の API（チャットの POST を含む）はキャッシュしない
/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import { ExpirationPlugin } from "workbox-expiration";
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { NetworkFirst } from "workbox-strategies";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

export const PROGRAM_CACHE = "programs-v1";
const PROGRAM_PATH = /^\/api\/programs\/[^/]+$/;

precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

// SPA の画面遷移は index.html を返す（API は除く）
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), { denylist: [/^\/api\//] }),
);

registerRoute(
  ({ url, request }) =>
    request.method === "GET" &&
    url.origin === self.location.origin &&
    PROGRAM_PATH.test(url.pathname),
  new NetworkFirst({
    cacheName: PROGRAM_CACHE,
    networkTimeoutSeconds: 5,
    plugins: [
      new ExpirationPlugin({ maxEntries: 50 }),
      {
        // キャッシュから返すときだけ印を付ける
        cachedResponseWillBeUsed: async ({ cachedResponse }) => {
          if (!cachedResponse) return cachedResponse;
          const headers = new Headers(cachedResponse.headers);
          headers.set("X-SW-Cache", "hit");
          return new Response(await cachedResponse.blob(), {
            status: cachedResponse.status,
            statusText: cachedResponse.statusText,
            headers,
          });
        },
      },
    ],
  }),
);

// 画面側の「更新する」から呼ばれる
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") void self.skipWaiting();
});
clientsClaim();
