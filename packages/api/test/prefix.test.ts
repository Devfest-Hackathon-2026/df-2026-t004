import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { stripApiPrefix, withApiPrefix } from "../src/prefix.js";

describe("/api の接頭辞（Hosting の rewrites 経由のリクエスト）", () => {
  it("/api と /api/... だけを取り除く", () => {
    expect(stripApiPrefix("/api")).toBe("/");
    expect(stripApiPrefix("/api/household")).toBe("/household");
    expect(stripApiPrefix("/api/users/u1/chats")).toBe("/users/u1/chats");
    expect(stripApiPrefix("/apix/household")).toBeNull();
    expect(stripApiPrefix("/healthz")).toBeNull();
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
    app.get("/healthz", (c) => c.json({ ok: true }));
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
    expect((await fetch(new Request("http://localhost/healthz"))).status).toBe(200);
    expect((await fetch(new Request("http://localhost/api/missing"))).status).toBe(404);
  });
});
