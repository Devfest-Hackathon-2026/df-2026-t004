// Firestore Emulator と Auth Emulator で、運営者 CLI の書き込みを確かめる
// （Requirement 3.13〜3.16, 13.4, 13.5, 13.11, 13.14）。`npm run test:integration` の中で実行する。

import { readFileSync } from "node:fs";
import { getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import {
  FieldValue,
  getFirestore,
  type Firestore,
  type WriteBatch,
} from "firebase-admin/firestore";
import { beforeEach, describe, expect, it } from "vitest";
import { FakeEmbedder, FirestoreOpsConfigStore } from "@hachioji-gov/collector";
import { decodeProgram, encodeProgram, isSearchable } from "@hachioji-gov/shared";
import { runCli, type CliDeps } from "../src/cli.js";
import { FirebaseAdminAuth, FirestoreAdminStore } from "../src/firestore.js";
import { EMBEDDING, NOW, program } from "./support/fixtures.js";

const PROJECT_ID = "demo-hachioji-gov";
const OPERATOR = "operator-1";

function requireEnv(name: "FIRESTORE_EMULATOR_HOST" | "FIREBASE_AUTH_EMULATOR_HOST"): string {
  const value =
    name === "FIRESTORE_EMULATOR_HOST"
      ? process.env["FIRESTORE_EMULATOR_HOST"]
      : process.env["FIREBASE_AUTH_EMULATOR_HOST"];
  // 実環境に接続しないよう、Emulator の設定が無ければ失敗させる
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set. Run via "npm run test:integration".`);
  }
  return value;
}

function app(): App {
  requireEnv("FIRESTORE_EMULATOR_HOST");
  requireEnv("FIREBASE_AUTH_EMULATOR_HOST");
  return getApps()[0] ?? initializeApp({ projectId: PROJECT_ID });
}

function db(): Firestore {
  return getFirestore(app());
}

async function reset(): Promise<void> {
  await fetch(
    `http://${requireEnv("FIRESTORE_EMULATOR_HOST")}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`,
    { method: "DELETE" },
  );
  await fetch(
    `http://${requireEnv("FIREBASE_AUTH_EMULATOR_HOST")}/emulator/v1/projects/${PROJECT_ID}/accounts`,
    { method: "DELETE" },
  );
}

type Run = {
  out: string[];
  err: string[];
  answers: string[];
  embedder: FakeEmbedder;
  // 次の commit を失敗させる回数
  failCommits: number;
  embedding: CliDeps["embedding"];
  exec: (...argv: string[]) => Promise<number>;
};

function cli(): Run {
  const r: Run = {
    out: [],
    err: [],
    answers: [],
    embedder: new FakeEmbedder(),
    failCommits: 0,
    embedding: EMBEDDING,
    exec: async () => 0,
  };
  const commit = async (batch: WriteBatch): Promise<unknown> => {
    if (r.failCommits > 0) {
      r.failCommits -= 1;
      throw new Error("injected commit failure");
    }
    return batch.commit();
  };
  r.exec = (...argv) =>
    runCli(["--project", PROJECT_ID, ...argv], {
      connect: () => ({
        store: new FirestoreAdminStore(db(), { fieldPrefix: "emb_", commit }),
        auth: new FirebaseAdminAuth(getAuth(app())),
        embedder: () => r.embedder,
      }),
      out: (line) => r.out.push(line),
      err: (line) => r.err.push(line),
      prompt: async () => r.answers.shift() ?? "",
      now: () => NOW,
      readFile: async () => {
        throw new Error("not used");
      },
      env: {},
      embedding: r.embedding,
      defaultIntervalHours: 24,
    });
  return r;
}

function unit(i: number): number[] {
  return Array.from({ length: EMBEDDING.dimensions }, (_, k) => (k === i % 8 ? 1 : 0));
}

async function seedProgram(chunks: number, searchable = false): Promise<void> {
  await db().collection("programs").doc("p1").set(encodeProgram(program()));
  const batch = db().batch();
  for (let i = 0; i < chunks; i += 1) {
    batch.set(
      db()
        .collection("chunks")
        .doc(`p1-${String(i).padStart(3, "0")}`),
      {
        programId: "p1",
        sourceId: "p1",
        excerpt: `原文の抜粋 ${i}`,
        sourceUrl: "https://www.city.hachioji.tokyo.jp/a.html",
        heading: `見出し${i}`,
        contentHash: "hash-1",
        fetchedAt: "2026-11-01T00:00:00.000Z",
        municipalityCode: "13201",
        level: "city",
        category: "childcare",
        searchable,
        band_age_0_2: true,
        emb_v1: FieldValue.vector(unit(i)),
        embeddingMeta: {
          v1: {
            model: EMBEDDING.model,
            dimensions: EMBEDDING.dimensions,
            createdAt: NOW.toISOString(),
          },
        },
      },
    );
  }
  await batch.commit();
}

async function chunkStates(): Promise<boolean[]> {
  const snap = await db().collection("chunks").orderBy("__name__").get();
  return snap.docs.map((d) => d.get("searchable") === true);
}

async function readProgram() {
  const snap = await db().collection("programs").doc("p1").get();
  const decoded = decodeProgram("p1", snap.data());
  if (!decoded.ok) throw new Error(decoded.errors.join(", "));
  return decoded.value;
}

async function createOperator(claims: Record<string, unknown> | null): Promise<void> {
  await getAuth(app()).createUser({ uid: OPERATOR });
  if (claims !== null) await getAuth(app()).setCustomUserClaims(OPERATOR, claims);
}

beforeEach(async () => {
  await reset();
});

describe("verify / unverify", () => {
  it("admin クレームを持つ運営者が確認すると、制度とチャンクが検索対象になる", async () => {
    await createOperator({ admin: true });
    await seedProgram(3);
    const r = cli();
    r.answers.push("yes");
    expect(await r.exec("--operator", OPERATOR, "verify", "p1")).toBe(0);
    const p = await readProgram();
    expect(p).toMatchObject({
      verified: true,
      verifiedAt: "2026-11-10",
      verifiedBy: OPERATOR,
      verifiedContentHash: "hash-1",
      needsReview: false,
    });
    expect(isSearchable(p)).toBe(true);
    expect(await chunkStates()).toEqual([true, true, true]);
    expect(r.out.join("\n")).toContain("原文の抜粋 2");
  });

  it("admin クレームが無い運営者は拒否し、何も書かない", async () => {
    await createOperator({ admin: "true", role: "editor" });
    await seedProgram(2);
    const r = cli();
    r.answers.push("yes");
    expect(await r.exec("--operator", OPERATOR, "verify", "p1")).toBe(1);
    expect((await readProgram()).verified).toBe(false);
    expect(await chunkStates()).toEqual([false, false]);
  });

  it("チャンクの更新で途中で失敗しても、再実行で完了する", async () => {
    await createOperator({ admin: true });
    await seedProgram(3);
    const r = cli();
    r.failCommits = 1;
    r.answers.push("yes");
    expect(await r.exec("--operator", OPERATOR, "verify", "p1")).toBe(1);
    expect((await readProgram()).verified).toBe(true);
    expect(await chunkStates()).toEqual([false, false, false]);
    r.answers.push("yes");
    expect(await r.exec("--operator", OPERATOR, "verify", "p1")).toBe(0);
    expect(await chunkStates()).toEqual([true, true, true]);
  });

  it("表示の後に制度が更新されていたら、確認状態を書き込まない", async () => {
    await seedProgram(1);
    const store = new FirestoreAdminStore(db(), { fieldPrefix: "emb_" });
    // 表示の後に内容が変わった状態を、updatedAt の不一致で再現する
    const saved = await store.saveVerification(
      "p1",
      {
        verified: true,
        verifiedAt: "2026-11-10",
        verifiedBy: OPERATOR,
        verifiedContentHash: "hash-1",
        needsReview: false,
        updatedAt: NOW.toISOString(),
      },
      { contentHash: "hash-1", updatedAt: "2026-10-01T00:00:00.000Z" },
    );
    expect(saved).toBe(false);
    expect((await readProgram()).verified).toBe(false);
  });

  it("unverify はチャンクを外し、確認の記録を消す", async () => {
    await createOperator({ admin: true });
    await seedProgram(2);
    const r = cli();
    r.answers.push("yes");
    await r.exec("--operator", OPERATOR, "verify", "p1");
    expect(await r.exec("--operator", OPERATOR, "unverify", "p1")).toBe(0);
    const snap = await db().collection("programs").doc("p1").get();
    expect(snap.get("verified")).toBe(false);
    expect(snap.get("verifiedAt")).toBeUndefined();
    expect(snap.get("verifiedContentHash")).toBeUndefined();
    expect(await chunkStates()).toEqual([false, false]);
  });
});

describe("ops と grant-admin", () => {
  it("config/operations を書き、collector の読み取りと同じ値になる", async () => {
    const r = cli();
    expect(await r.exec("ops", "start")).toBe(0);
    expect(await new FirestoreOpsConfigStore(db()).read()).toEqual({
      aiEnabled: true,
      collectionEnabled: true,
    });
    expect(await r.exec("ops", "stop", "ai")).toBe(0);
    const snap = await db().collection("config").doc("operations").get();
    expect(snap.data()).toMatchObject({
      aiEnabled: false,
      collectionEnabled: true,
      updatedBy: "admin-cli",
    });
  });

  it("grant-admin は既存のクレームを保って admin を付ける", async () => {
    await createOperator({ tier: 1 });
    const r = cli();
    r.answers.push(PROJECT_ID);
    expect(await r.exec("grant-admin", OPERATOR)).toBe(0);
    expect((await getAuth(app()).getUser(OPERATOR)).customClaims).toEqual({ tier: 1, admin: true });
    r.answers.push(PROJECT_ID);
    expect(await r.exec("grant-admin", "missing-user")).toBe(1);
  });
});

describe("sources", () => {
  it("add は create で書き、同じ ID・URL では既存を変えない", async () => {
    const r = cli();
    const args = [
      "--id",
      "city-a",
      "--url",
      "https://www.city.hachioji.tokyo.jp/a.html",
      "--municipality-code",
      "13201",
      "--level",
      "city",
    ];
    expect(await r.exec("sources", "add", ...args, "--title", "最初")).toBe(0);
    expect(await r.exec("sources", "add", ...args, "--title", "上書き")).toBe(1);
    const snap = await db().collection("sources").doc("city-a").get();
    expect(snap.data()).toMatchObject({
      title: "最初",
      status: "active",
      missCount: 0,
      format: "html",
    });
    // 直接 create しても上書きしない
    const store = new FirestoreAdminStore(db(), { fieldPrefix: "emb_" });
    const again = await store.createSource({
      id: "city-a",
      url: "https://example.jp/other.html",
      municipalityCode: "13201",
      level: "city",
      format: "html",
      category: null,
      ageBands: ["unknown"],
      title: "別",
      relatedSourceId: null,
      intervalHours: 24,
      status: "active",
      missCount: 0,
    });
    expect(again).toBe("exists");
    expect((await db().collection("sources").doc("city-a").get()).get("title")).toBe("最初");
  });

  it("初期の情報源リストを取り込める（再実行しても変わらない）", async () => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- リポジトリ内の固定パス
    const seed = readFileSync(
      new URL("../../../config/sources.seed.json", import.meta.url),
      "utf8",
    );
    const rows = JSON.parse(seed) as unknown[];
    const run = (dryRun: boolean) =>
      runCli(
        [
          "--project",
          PROJECT_ID,
          "sources",
          "import",
          "seed.json",
          ...(dryRun ? ["--dry-run"] : []),
        ],
        {
          connect: () => ({
            store: new FirestoreAdminStore(db(), { fieldPrefix: "emb_" }),
            auth: new FirebaseAdminAuth(getAuth(app())),
            embedder: () => new FakeEmbedder(),
          }),
          out: () => undefined,
          err: () => undefined,
          prompt: async () => "",
          now: () => NOW,
          readFile: async () => seed,
          env: {},
          embedding: EMBEDDING,
          defaultIntervalHours: 24,
        },
      );
    expect(await run(true)).toBe(0);
    expect((await db().collection("sources").get()).size).toBe(0);
    expect(await run(false)).toBe(0);
    const first = (await db().collection("sources").get()).docs.map((d) => [d.id, d.data()]);
    expect(first).toHaveLength(rows.length);
    expect(await run(false)).toBe(0);
    const second = (await db().collection("sources").get()).docs.map((d) => [d.id, d.data()]);
    expect(second).toEqual(first);
  });
});

describe("reembed と embedding set-search-version", () => {
  it("書き込み → 検証 → 切り替え → 後片付けを、既存の版を検索に残したまま進める", async () => {
    // ページの境界（300件）をまたぐ件数にする
    await seedProgram(305, true);
    await db().collection("config").doc("embedding").set({ searchVersion: "v1" });
    const r = cli();
    expect(await r.exec("ops", "stop", "collection")).toBe(0);

    // そろう前は切り替えを拒否する
    expect(await r.exec("embedding", "set-search-version", "v2")).toBe(1);
    expect((await db().collection("config").doc("embedding").get()).get("searchVersion")).toBe(
      "v1",
    );

    expect(await r.exec("reembed", "--to", "v2")).toBe(0);
    const one = await db().collection("chunks").doc("p1-000").get();
    expect(one.get("excerpt")).toBe("原文の抜粋 0");
    expect(one.get("searchable")).toBe(true);
    expect(one.get("emb_v1")).toBeDefined();
    expect(one.get("emb_v2")?.toArray()).toHaveLength(EMBEDDING.dimensions);
    expect(one.get("embeddingMeta.v2")).toMatchObject({ model: EMBEDDING.model, dimensions: 8 });
    // 再生成の間も、検索の版は v1 のまま
    expect((await db().collection("config").doc("embedding").get()).get("searchVersion")).toBe(
      "v1",
    );

    // 再実行しても埋め込みを作らない（冪等）
    const calls = r.embedder.calls;
    expect(await r.exec("reembed", "--to", "v2")).toBe(0);
    expect(r.embedder.calls).toBe(calls);

    expect(await r.exec("reembed", "--verify", "--to", "v2")).toBe(0);
    expect(await r.exec("embedding", "set-search-version", "v2")).toBe(0);
    expect((await db().collection("config").doc("embedding").get()).get("searchVersion")).toBe(
      "v2",
    );

    r.embedding = { ...EMBEDDING, version: "v2" };
    expect(await r.exec("reembed", "--cleanup", "--version", "v2")).toBe(1);
    expect(await r.exec("reembed", "--cleanup", "--version", "v1")).toBe(0);
    const after = await db().collection("chunks").doc("p1-304").get();
    expect(after.get("emb_v1")).toBeUndefined();
    expect(after.get("embeddingMeta.v1")).toBeUndefined();
    expect(after.get("emb_v2")).toBeDefined();
    expect(after.get("searchable")).toBe(true);
  });

  it("収集が動いているときは再生成しない", async () => {
    await seedProgram(1, true);
    const r = cli();
    await r.exec("ops", "start");
    expect(await r.exec("reembed", "--to", "v2")).toBe(1);
    expect(r.embedder.calls).toBe(0);
  });
});
