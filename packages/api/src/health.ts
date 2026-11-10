// 稼働確認（認証なし。外から API が動いているかを確かめる）
// Cloud Run は z で終わるパスの一部（/healthz など）を予約していて、コンテナに届かない（#125）。
// そのため z で終わらない /health にする。Hosting 経由では /api/health で届く。

import type { Env, Hono } from "hono";

export const HEALTH_PATH = "/health";

export function mountHealth<E extends Env>(app: Hono<E>): void {
  app.get(HEALTH_PATH, (c) => c.json({ ok: true }));
}
