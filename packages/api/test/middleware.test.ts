// 共通ミドルウェアの単体テスト（Requirement 1.9, 1.10, 9.5〜9.7, 15.3）
import { createLogger, scanLogForLeaks } from "@hachioji-gov/shared";
import { describe, expect, it } from "vitest";
import {
  clientIp,
  createApi,
  RECENT_SIGN_IN_SEC,
  UNKNOWN_IP,
  type IdTokenVerifier,
} from "../src/index.js";
import { CANARIES, CANARY_QUESTION } from "./support/canaries.js";

// "token-<uid>" を uid に対応づける偽の検証器。検証した回数を数える
function fakeVerifier() {
  const v = {
    calls: 0,
    verifyIdToken: async (token: string) => {
      v.calls += 1;
      if (!token.startsWith("token-")) throw new Error(`invalid token ${token}`);
      return { uid: token.slice("token-".length) };
    },
  };
  return v satisfies IdTokenVerifier;
}

const BASE = Date.UTC(2026, 10, 9, 0, 0, 0);
const EMAIL = "someone@example.com";

function setup(limits: { perUser: number; perIp: number }) {
  const lines: string[] = [];
  let now = BASE;
  const verifier = fakeVerifier();
  const writes: string[] = [];
  const { app, guards } = createApi({
    config: {
      rateLimit: {
        perUserPerMinute: limits.perUser,
        perIpPerMinute: limits.perIp,
        windowSec: 60,
        maxEntries: 100,
      },
    },
    verifier,
    logger: createLogger({ sink: (line) => lines.push(line) }),
    now: () => now,
  });
  app.use("/me", ...guards.signedIn);
  app.post("/me", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    // 入力をそのままロガーに渡しても、許可リストで落ちる
    c.get("logger").info("me.write", { ...body, count: 1 });
    writes.push(c.get("uid"));
    return c.json({ uid: c.get("uid") });
  });
  app.use("/users/:uid/*", ...guards.owner);
  app.get("/users/:uid/data", (c) => c.json({ uid: c.get("uid") }));
  app.get("/public", (c) => c.json({ ok: true }));

  const post = (token?: string, ip = "203.0.113.1") =>
    app.request("/me", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": `198.51.100.9, ${ip}`,
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: JSON.stringify({ question: CANARY_QUESTION, email: EMAIL }),
    });
  return {
    app,
    lines,
    verifier,
    writes,
    post,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("レート制限", () => {
  it("IP ごとの上限を超えたら 429 と Retry-After。トークン検証も処理もしない", async () => {
    const t = setup({ perUser: 100, perIp: 2 });
    expect((await t.post("token-a")).status).toBe(200);
    expect((await t.post("token-b")).status).toBe(200);
    const res = await t.post("token-c");
    expect(res.status).toBe(429);
    const retry = Number(res.headers.get("Retry-After"));
    expect(retry).toBeGreaterThanOrEqual(1);
    expect(retry).toBeLessThanOrEqual(60);
    expect(await res.json()).toEqual({ error: "rate_limited", retryAfterSec: retry });
    expect(t.verifier.calls).toBe(2);
    expect(t.writes).toEqual(["a", "b"]);
    // 別の IP は影響を受けない
    expect((await t.post("token-c", "203.0.113.2")).status).toBe(200);
  });

  it("ユーザーごとの上限を超えたら 429。IP を変えても同じユーザーは止まる", async () => {
    const t = setup({ perUser: 2, perIp: 100 });
    expect((await t.post("token-a", "203.0.113.1")).status).toBe(200);
    expect((await t.post("token-a", "203.0.113.2")).status).toBe(200);
    const res = await t.post("token-a", "203.0.113.3");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    expect(t.writes).toEqual(["a", "a"]);
    // 他のユーザーは影響を受けない
    expect((await t.post("token-b")).status).toBe(200);
    // 窓が過ぎれば戻る
    t.advance(60_000);
    expect((await t.post("token-a")).status).toBe(200);
  });

  it("未認証の要求はユーザーの回数を使わない", async () => {
    const t = setup({ perUser: 1, perIp: 100 });
    expect((await t.post()).status).toBe(401);
    expect((await t.post("bad")).status).toBe(401);
    expect((await t.post("token-a")).status).toBe(200);
  });
});

describe("認証と認可", () => {
  it("ログインが要るルートは、トークンが無い・無効なら 401", async () => {
    const t = setup({ perUser: 100, perIp: 100 });
    expect((await t.post()).status).toBe(401);
    const res = await t.post("bad");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthenticated" });
    expect(t.writes).toEqual([]);
  });

  it("パスの uid が本人でなければ 403、本人なら通る", async () => {
    const t = setup({ perUser: 100, perIp: 100 });
    const get = (uid: string, token?: string) =>
      t.app.request(`/users/${uid}/data`, {
        headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
      });
    expect((await get("alice")).status).toBe(401);
    expect((await get("alice", "token-bob")).status).toBe(403);
    expect(await (await get("alice", "token-alice")).json()).toEqual({ uid: "alice" });
  });

  it("ログインが要らないルートはそのまま通る", async () => {
    const t = setup({ perUser: 100, perIp: 100 });
    expect((await t.app.request("/public")).status).toBe(200);
  });
});

describe("multipart/form-data", () => {
  it("画像などの multipart は 415 で受け付けない", async () => {
    const t = setup({ perUser: 100, perIp: 100 });
    const form = new FormData();
    form.append("file", new Blob(["x"], { type: "image/png" }), "a.png");
    const res = await t.app.request("/me", {
      method: "POST",
      headers: { Authorization: "Bearer token-a" },
      body: form,
    });
    expect(res.status).toBe(415);
    expect(t.writes).toEqual([]);
  });
});

describe("ログ", () => {
  it("質問文・メール・トークンをログに出さない（許可リストとスキャン）", async () => {
    const t = setup({ perUser: 1, perIp: 100 });
    await t.post("token-a");
    await t.post("token-a"); // 429
    await t.post("bad"); // 401
    const text = t.lines.join("\n");
    expect(text).toContain('"message":"me.write"');
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain("token-a");
    expect(scanLogForLeaks(text, { canaries: CANARIES })).toEqual([]);
    const statuses = t.lines
      .map((l) => JSON.parse(l) as { message: string; status?: number })
      .filter((e) => e.message === "request.completed")
      .map((e) => e.status);
    expect(statuses).toEqual([200, 429, 401]);
  });
});

describe("clientIp", () => {
  const ipOf = async (header?: string) => {
    const { app } = createApi({
      config: {
        rateLimit: { perUserPerMinute: 1, perIpPerMinute: 1, windowSec: 60, maxEntries: 9 },
      },
      verifier: fakeVerifier(),
      logger: createLogger({ sink: () => {} }),
    });
    app.get("/ip", (c) => c.text(clientIp(c)));
    const res = await app.request("/ip", {
      headers: header === undefined ? {} : { "X-Forwarded-For": header },
    });
    return res.text();
  };

  it("X-Forwarded-For の最後の値を使い、利用者が足した先頭の値は使わない", async () => {
    expect(await ipOf("1.1.1.1, 203.0.113.7")).toBe("203.0.113.7");
    expect(await ipOf("203.0.113.7")).toBe("203.0.113.7");
  });

  it("Hosting 経由（最後が中継サーバー）なら1つ前を使う（#129、U-8）", async () => {
    expect(await ipOf("35.201.207.169,66.249.82.200")).toBe("35.201.207.169");
    expect(await ipOf("203.0.113.9,35.201.207.169")).toBe("35.201.207.169");
    expect(await ipOf("203.0.113.9,35.201.207.169,66.249.82.38")).toBe("35.201.207.169");
    // 中継サーバーの範囲（66.249.64.0/19）の端と、その外
    expect(await ipOf("35.201.207.169,66.249.64.0")).toBe("35.201.207.169");
    expect(await ipOf("35.201.207.169,66.249.95.255")).toBe("35.201.207.169");
    expect(await ipOf("35.201.207.169,66.249.96.1")).toBe("66.249.96.1");
    expect(await ipOf("35.201.207.169,66.249.63.255")).toBe("66.249.63.255");
    // 中継サーバーしか無ければ、その値のまま
    expect(await ipOf("66.249.82.200")).toBe("66.249.82.200");
  });

  it("無い・空・長すぎるときは unknown", async () => {
    expect(await ipOf()).toBe(UNKNOWN_IP);
    expect(await ipOf(" , ")).toBe(UNKNOWN_IP);
    expect(await ipOf("x".repeat(65))).toBe(UNKNOWN_IP);
  });
});

describe("requireRecentSignIn（アカウント削除の前の再認証、#106）", () => {
  // "fresh-<秒前>" は、その秒数だけ前にログインしたトークン。"noauth" は auth_time が無いトークン
  const verifier: IdTokenVerifier = {
    verifyIdToken: async (token) => {
      if (!token.startsWith("fresh-")) return { uid: "u1" };
      const ago = Number(token.slice("fresh-".length));
      return { uid: "u1", auth_time: Math.floor(BASE / 1000) - ago };
    },
  };
  const { app, guards } = createApi({
    config: {
      rateLimit: { perUserPerMinute: 100, perIpPerMinute: 100, windowSec: 60, maxEntries: 9 },
    },
    verifier,
    logger: createLogger({ sink: () => {} }),
    now: () => BASE,
  });
  app.use("/danger", ...guards.signedIn);
  app.delete("/danger", guards.recentSignIn, (c) => c.json({ ok: true }));
  const del = async (token: string) => {
    const res = await app.request("/danger", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    return { status: res.status, body: (await res.json()) as unknown };
  };

  it("直前（5分以内）に再認証したトークンなら通す", async () => {
    expect(await del("fresh-0")).toEqual({ status: 200, body: { ok: true } });
    expect((await del(`fresh-${RECENT_SIGN_IN_SEC}`)).status).toBe(200);
  });

  it("古い・auth_time が無い・未来すぎるトークンは 401 reauthentication_required", async () => {
    const stale = { status: 401, body: { error: "reauthentication_required" } };
    expect(await del(`fresh-${RECENT_SIGN_IN_SEC + 1}`)).toEqual(stale);
    expect(await del("fresh-86400")).toEqual(stale);
    expect(await del("noauth")).toEqual(stale);
    expect(await del("fresh--600")).toEqual(stale);
  });
});
