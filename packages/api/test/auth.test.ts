// requireOwner と createApp の単体テスト（Emulator を使わない）
import { createLogger } from "@hachioji-gov/shared";
import { describe, expect, it } from "vitest";
import { createApp, requireOwner, type IdTokenVerifier } from "../src/index.js";
import { CANARY_QUESTION } from "./support/canaries.js";

// "token-<uid>" を uid に対応づける偽の検証器
const fakeVerifier: IdTokenVerifier = {
  verifyIdToken: async (token) => {
    if (!token.startsWith("token-")) throw new Error(`invalid token ${token}`);
    return { uid: token.slice("token-".length) };
  },
};

function setup() {
  const lines: string[] = [];
  const app = createApp({ logger: createLogger({ sink: (line) => lines.push(line) }) });
  app.use("/users/:uid/*", requireOwner(fakeVerifier));
  app.post("/users/:uid/echo", async (c) => {
    const body = await c.req.json<Record<string, unknown>>();
    c.get("logger").info("echo", body);
    return c.json({ uid: c.get("uid") });
  });
  app.get("/users/:uid/boom", () => {
    throw new Error(`failed for ${CANARY_QUESTION}`);
  });
  return { app, lines };
}

function post(app: ReturnType<typeof setup>["app"], uid: string, authHeader?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (authHeader !== undefined) headers["Authorization"] = authHeader;
  return app.request(`/users/${uid}/echo`, {
    method: "POST",
    headers,
    body: JSON.stringify({ question: CANARY_QUESTION }),
  });
}

describe("requireOwner", () => {
  it("本人は通る", async () => {
    const { app } = setup();
    const res = await post(app, "alice", "Bearer token-alice");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ uid: "alice" });
  });

  it("Authorization が無ければ 401", async () => {
    const { app } = setup();
    expect((await post(app, "alice")).status).toBe(401);
  });

  it.each(["token-alice", "Bearer ", "Basic token-alice", "Bearer bad"])(
    "形式が違う・無効なトークン（%s）は 401",
    async (header) => {
      const { app } = setup();
      expect((await post(app, "alice", header)).status).toBe(401);
    },
  );

  it("他人のトークンは 403", async () => {
    const { app } = setup();
    const res = await post(app, "alice", "Bearer token-bob");
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
  });
});

describe("createApp のログ", () => {
  it("アクセスログに入力の内容が出ない", async () => {
    const { app, lines } = setup();
    await post(app, "alice", "Bearer token-alice");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(CANARY_QUESTION);
    }
    const completed = lines
      .map((l) => JSON.parse(l))
      .find((e) => e.message === "request.completed");
    expect(completed).toMatchObject({ severity: "INFO", status: 200 });
    expect(completed.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("例外は 500 にし、メッセージを応答にもログにも出さない", async () => {
    const { app, lines } = setup();
    const res = await app.request("/users/alice/boom", {
      headers: { Authorization: "Bearer token-alice" },
    });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(CANARY_QUESTION);
    const joined = lines.join("\n");
    expect(joined).not.toContain(CANARY_QUESTION);
    expect(joined).toContain('"errorType":"Error"');
  });
});
