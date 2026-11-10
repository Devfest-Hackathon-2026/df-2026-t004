// テスト用の制度・チャンクと、CLI を動かすための部品

import { FakeEmbedder } from "@hachioji-gov/collector";
import type { Program } from "@hachioji-gov/shared";
import { runCli, type CliDeps } from "../../src/cli.js";
import { MemoryAdminAuth, MemoryAdminStore, type MemoryChunk } from "../../src/memory.js";

export const PROJECT = "demo-hachioji-gov";
export const NOW = new Date("2026-11-09T15:30:00.000Z"); // 日本時間では 2026-11-10
export const EMBEDDING = { model: "gemini-embedding-001", dimensions: 8, version: "v1" };
export const ADMIN_UID = "admin-user";

export function program(over: Partial<Program> = {}): Program {
  return {
    id: "p1",
    sourceId: "p1",
    name: "児童手当",
    level: "city",
    municipalityCode: "13201",
    category: "childcare",
    ageBands: ["age_0_2"],
    summary: "子どもを育てる世帯への手当",
    eligibility: "中学生までの子どもを養育する人",
    procedure: null,
    requiredDocs: ["申請書"],
    deadline: null,
    contact: null,
    sourceName: "八王子市",
    sourceUrl: "https://www.city.hachioji.tokyo.jp/a.html",
    fetchedAt: "2026-11-01T00:00:00.000Z",
    verified: false,
    contentHash: "hash-1",
    needsReview: false,
    status: "active",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

function unit(dimensions: number, seed: number): number[] {
  return Array.from({ length: dimensions }, (_, i) => (i === seed % dimensions ? 1 : 0));
}

export function chunk(id: string, over: Partial<MemoryChunk> = {}): MemoryChunk {
  return {
    id,
    programId: "p1",
    excerpt: `原文 ${id}`,
    sourceUrl: "https://www.city.hachioji.tokyo.jp/a.html",
    heading: "対象",
    searchable: false,
    embeddingMeta: {
      v1: {
        model: EMBEDDING.model,
        dimensions: EMBEDDING.dimensions,
        createdAt: NOW.toISOString(),
      },
    },
    vectors: { v1: unit(EMBEDDING.dimensions, id.length) },
    ...over,
  };
}

export type Harness = {
  store: MemoryAdminStore;
  auth: MemoryAdminAuth;
  embedder: FakeEmbedder;
  out: string[];
  err: string[];
  prompts: string[];
  answers: string[];
  files: Map<string, string>;
  env: Record<string, string | undefined>;
  deps: CliDeps;
  connects: number;
  run: (...argv: string[]) => Promise<number>;
};

export function harness(): Harness {
  const h = {
    store: new MemoryAdminStore(),
    auth: new MemoryAdminAuth(),
    embedder: new FakeEmbedder(),
    out: [] as string[],
    err: [] as string[],
    prompts: [] as string[],
    answers: [] as string[],
    files: new Map<string, string>(),
    env: {} as Record<string, string | undefined>,
    connects: 0,
  } as Harness;
  h.deps = {
    connect: () => {
      h.connects += 1;
      return { store: h.store, auth: h.auth, embedder: () => h.embedder };
    },
    out: (line) => h.out.push(line),
    err: (line) => h.err.push(line),
    prompt: async (q) => {
      h.prompts.push(q);
      return h.answers.shift() ?? "";
    },
    now: () => NOW,
    readFile: async (path) => {
      const text = h.files.get(path);
      if (text === undefined) throw new Error("ENOENT");
      return text;
    },
    env: h.env,
    embedding: EMBEDDING,
    defaultIntervalHours: 24,
  };
  h.run = (...argv) => runCli(["--project", PROJECT, ...argv], h.deps);
  h.auth.users.set(ADMIN_UID, { admin: true });
  return h;
}
