import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { HEALTH_PATH, mountHealth } from "../src/health.js";
import { stripApiPrefix, withApiPrefix } from "../src/prefix.js";

describe("/api の接頭辞（Hosting の rewrites 経由のリクエスト）", () => {
  it("/api と /api/... だけを取り除く", () => {
    expect(stripApiPrefix("/api")).toBe("/");
    expect(stripApiPrefix("/api/household")).toBe("/household");
    expect(stripApiPrefix("/api/users/u1/chats")).toBe("/users/u1/chats");
    expect(stripApiPrefix("/apix/household")).toBeNull();
    expect(stripApiPrefix("/health")).toBeNull();
    expect(stripApiPrefix("/household")).toBeNull();
  });

  it("本文・ヘッダー・クエリを保ったまま、接頭辞の無いルートに届く", async () => {
    const app = new Hono();
    app.put("/household", async (c) =>
      c.json({
        body: (await c.req.json()) as unknown,
        auth: c.req.header("Authorization") ?? null,
        q: c.req.query("category") ?? null,
      }),
    );
    const fetch = withApiPrefix(app.fetch);

    const res = await fetch(
      new Request("http://localhost/api/household?category=medical", {
        method: "PUT",
        headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
        body: JSON.stringify({ postalCode: "1920083" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      body: { postalCode: "1920083" },
      auth: "Bearer t",
      q: "medical",
    });
    expect((await fetch(new Request("http://localhost/api/missing"))).status).toBe(404);
  });

  it("稼働確認は /health と、Hosting 経由の /api/health の両方で届く（#125）", async () => {
    // Cloud Run は z で終わるパスの一部を予約しているため、z で終わらないこと
    expect(HEALTH_PATH.endsWith("z")).toBe(false);
    const app = new Hono();
    mountHealth(app);
    const fetch = withApiPrefix(app.fetch);
    for (const path of [HEALTH_PATH, `/api${HEALTH_PATH}`]) {
      const res = await fetch(new Request(`http://localhost${path}`));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    }
    expect((await fetch(new Request("http://localhost/healthz"))).status).toBe(404);
  });
});
