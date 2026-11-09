// POST /chat（SSE）と GET /users/:uid/chats（Requirement 5, 9.7, 12.1, 15.2, 15.3）

import { SOURCE_CATEGORIES, type SourceCategory } from "@hachioji-gov/shared";
import { streamSSE } from "hono/streaming";
import type { Api } from "../server.js";
import { runChat, type ChatDeps } from "./pipeline.js";
import type { ChatEvents, Emit } from "./types.js";

export const CHAT_HISTORY_LIMIT = 20;
const PROGRAM_ID = /^[A-Za-z0-9_-]{1,128}$/;

type ParsedBody = {
  question: string;
  category: SourceCategory | null;
  programId: string | null;
};

function parseBody(raw: unknown): ParsedBody | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const question: unknown = Reflect.get(raw, "question");
  const category: unknown = Reflect.get(raw, "category") ?? null;
  const programId: unknown = Reflect.get(raw, "programId") ?? null;
  if (typeof question !== "string") return null;
  if (category !== null && !SOURCE_CATEGORIES.some((c) => c === category)) return null;
  if (programId !== null && (typeof programId !== "string" || !PROGRAM_ID.test(programId))) {
    return null;
  }
  return {
    question,
    category: category as SourceCategory | null,
    programId: programId as string | null,
  };
}

export function mountChat(api: Api, deps: ChatDeps): void {
  const { app, guards } = api;

  app.use("/chat", ...guards.signedIn);
  app.post("/chat", async (c) => {
    let raw: unknown = null;
    try {
      raw = await c.req.json();
    } catch {
      raw = null;
    }
    const body = parseBody(raw);
    if (body === null) return c.json({ error: "invalid_request" }, 400);
    const uid = c.get("uid");
    const logger = c.get("logger");
    const requestId = c.get("requestId");

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      const emit: Emit = async <K extends keyof ChatEvents>(event: K, data: ChatEvents[K]) => {
        if (controller.signal.aborted) return;
        await stream.writeSSE({ event, data: JSON.stringify(data) });
      };
      const started = performance.now();
      try {
        const outcome = await runChat({ uid, ...body }, deps, emit, controller.signal);
        // 質問文や回答はログに出さない。結果の種類だけを出す
        logger.info(`chat.${outcome}`, { requestId, durationMs: performance.now() - started });
      } catch (error) {
        logger.error("chat.failed", { requestId, error });
        await emit("error", {
          reason: "internal",
          message: "エラーが発生しました。時間をおいて、もう一度送信してください。",
        });
      }
    });
  });

  app.use("/users/:uid/chats", ...guards.owner);
  app.get("/users/:uid/chats", async (c) => {
    const chats = await deps.store.listChats(c.get("uid"), CHAT_HISTORY_LIMIT);
    return c.json({ chats });
  });
}
