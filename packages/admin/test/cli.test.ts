// 運営者 CLI のユニットテスト（Requirement 3.13〜3.16, 13.4, 13.5, 13.11, 13.14）

import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canCutover,
  isSearchable,
  planReembed,
  SOURCE_AGE_BANDS,
  validateSourceRegistration,
} from "@hachioji-gov/shared";
import { inspectVectors } from "../src/commands.js";
import {
  ADMIN_UID,
  EMBEDDING,
  chunk,
  harness,
  program,
  PROJECT,
  type Harness,
} from "./support/fixtures.js";

const V2 = { ...EMBEDDING, version: "v2" };

function withProgram(h: Harness, over = {}): void {
  h.store.programs.set("p1", program(over));
  h.store.chunks.set("c1", chunk("c1"));
  h.store.chunks.set("c2", chunk("c2", { heading: undefined, pdfPage: 3 }));
}

function searchableOf(h: Harness): boolean[] {
  return [...h.store.chunks.values()].map((c) => c.searchable);
}

describe("共通の引数", () => {
  it("--project が無ければ接続せずに使い方の誤りにする", async () => {
    const h = harness();
    const { runCli } = await import("../src/cli.js");
    expect(await runCli(["ops", "stop"], h.deps)).toBe(2);
    expect(h.connects).toBe(0);
    expect(h.err.join("\n")).toContain("--project");
  });

  it("環境変数のプロジェクトと食い違うときは止める", async () => {
    const h = harness();
    h.env["GOOGLE_CLOUD_PROJECT"] = "prod-hachioji-gov";
    expect(await h.run("ops", "stop")).toBe(2);
    expect(h.connects).toBe(0);
    expect(h.store.ops).toBeNull();
  });

  it("対象のプロジェクトを表示する", async () => {
    const h = harness();
    expect(await h.run("ops", "stop")).toBe(0);
    expect(h.out[0]).toContain(PROJECT);
  });

  it("不明なコマンド・未知のオプションは使い方の誤り", async () => {
    const h = harness();
    expect(await h.run("drop-all")).toBe(2);
    expect(await h.run("ops", "stop", "--force")).toBe(2);
    expect(await h.run("ops", "pause")).toBe(2);
    expect(await h.run("ops", "stop", "chat")).toBe(2);
    expect(h.connects).toBe(0);
  });
});

describe("verify / unverify（Requirement 3.13〜3.16）", () => {
  it("ハッシュと原文を表示し、yes の後に確認済みにしてチャンクを検索対象にする", async () => {
    const h = harness();
    withProgram(h);
    h.answers.push("yes");
    expect(await h.run("--operator", ADMIN_UID, "verify", "p1")).toBe(0);
    const text = h.out.join("\n");
    expect(text).toContain("hash-1");
    expect(text).toContain("原文 c1");
    expect(text).toContain("p.3");
    expect(h.prompts).toHaveLength(1);
    const p = h.store.programs.get("p1");
    expect(p?.verified).toBe(true);
    expect(p?.verifiedAt).toBe("2026-11-10"); // 日本時間の日付
    expect(p?.verifiedBy).toBe(ADMIN_UID);
    expect(p?.verifiedContentHash).toBe("hash-1");
    expect(p !== undefined && isSearchable(p)).toBe(true);
    expect(searchableOf(h)).toEqual([true, true]);
  });

  it("要再確認の制度も、確認し直すと検索対象に戻る", async () => {
    const h = harness();
    withProgram(h, {
      verified: true,
      needsReview: true,
      verifiedContentHash: "hash-0",
      verifiedAt: "2026-10-01",
    });
    h.answers.push("yes");
    expect(await h.run("--operator", ADMIN_UID, "verify", "p1")).toBe(0);
    const p = h.store.programs.get("p1");
    expect(p?.needsReview).toBe(false);
    expect(p?.verifiedContentHash).toBe("hash-1");
  });

  it("yes 以外の回答では何も変えない", async () => {
    const h = harness();
    withProgram(h);
    const before = structuredClone([...h.store.programs.values()]);
    for (const answer of ["", "no", "y", "YES please"]) {
      h.answers.push(answer);
      expect(await h.run("--operator", ADMIN_UID, "verify", "p1")).toBe(1);
    }
    expect([...h.store.programs.values()]).toEqual(before);
    expect(searchableOf(h)).toEqual([false, false]);
  });

  it("admin クレームのない主体は、どんなクレームでも拒否する（Property: canVerify）", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.dictionary(fc.string({ maxLength: 8 }), fc.jsonValue({ maxDepth: 1 })),
        fc.option(fc.oneof(fc.boolean(), fc.constant("true"), fc.constant(1)), { nil: undefined }),
        async (claims, admin) => {
          const h = harness();
          withProgram(h);
          const record: Record<string, unknown> = { ...claims };
          if (admin === undefined) delete record["admin"];
          else record["admin"] = admin;
          h.auth.users.set("operator", record);
          h.answers.push("yes");
          const code = await h.run("--operator", "operator", "verify", "p1");
          const allowed = record["admin"] === true;
          expect(code).toBe(allowed ? 0 : 1);
          expect(h.store.programs.get("p1")?.verified).toBe(allowed);
          // 拒否するときは、原文も表示せず確認も求めない
          if (!allowed) expect(h.prompts).toHaveLength(0);
        },
      ),
    );
  });

  it("--operator が無い・存在しないユーザーは拒否する", async () => {
    const h = harness();
    withProgram(h);
    h.answers.push("yes", "yes");
    expect(await h.run("verify", "p1")).toBe(1);
    expect(await h.run("--operator", "nobody", "verify", "p1")).toBe(1);
    expect(await h.run("--operator", "nobody", "unverify", "p1")).toBe(1);
    expect(h.store.programs.get("p1")?.verified).toBe(false);
  });

  it("除外された制度・原文の無い制度・存在しない制度は確認できない", async () => {
    const h = harness();
    h.store.programs.set("p1", program({ status: "excluded" }));
    h.store.chunks.set("c1", chunk("c1"));
    h.store.programs.set("p2", program({ id: "p2", sourceId: "p2" }));
    h.answers.push("yes", "yes", "yes");
    expect(await h.run("--operator", ADMIN_UID, "verify", "p1")).toBe(1);
    expect(await h.run("--operator", ADMIN_UID, "verify", "p2")).toBe(1);
    expect(await h.run("--operator", ADMIN_UID, "verify", "p3")).toBe(1);
    expect(h.prompts).toHaveLength(0);
    expect(searchableOf(h)).toEqual([false]);
  });

  it("表示の後に内容が変わったときは書き込まない", async () => {
    const h = harness();
    withProgram(h);
    h.deps.prompt = async () => {
      // 確認している間に収集が新しい版を書いた
      h.store.programs.set(
        "p1",
        program({ contentHash: "hash-2", updatedAt: "2026-11-09T00:00:00Z" }),
      );
      return "yes";
    };
    expect(await h.run("--operator", ADMIN_UID, "verify", "p1")).toBe(1);
    expect(h.store.programs.get("p1")?.verified).toBe(false);
    expect(searchableOf(h)).toEqual([false, false]);
  });

  it("途中で失敗しても、再実行すれば一度で成功したときと同じ状態になる（冪等）", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom("saveVerification", "setChunksSearchable", "getProgram"),
        fc.integer({ min: 1, max: 2 }),
        async (op, times) => {
          const clean = harness();
          withProgram(clean);
          clean.answers.push("yes");
          expect(await clean.run("--operator", ADMIN_UID, "verify", "p1")).toBe(0);

          const h = harness();
          withProgram(h);
          h.store.failOn.set(op, times);
          let code = 1;
          for (let attempt = 0; attempt < 4 && code !== 0; attempt += 1) {
            h.answers.push("yes");
            code = await h.run("--operator", ADMIN_UID, "verify", "p1");
          }
          expect(code).toBe(0);
          expect(h.store.programs.get("p1")).toEqual(clean.store.programs.get("p1"));
          expect(searchableOf(h)).toEqual(searchableOf(clean));
          // さらに実行しても変わらない
          h.answers.push("yes");
          expect(await h.run("--operator", ADMIN_UID, "verify", "p1")).toBe(0);
          expect(h.store.programs.get("p1")).toEqual(clean.store.programs.get("p1"));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("失敗したときは、再実行を案内する", async () => {
    const h = harness();
    withProgram(h);
    h.store.failOn.set("setChunksSearchable", 1);
    h.answers.push("yes");
    expect(await h.run("--operator", ADMIN_UID, "verify", "p1")).toBe(1);
    expect(h.err.join("\n")).toContain("再実行");
    // 制度は確認済みだが、チャンクはまだ検索対象でない（安全側）
    expect(h.store.programs.get("p1")?.verified).toBe(true);
    expect(searchableOf(h)).toEqual([false, false]);
  });

  it("unverify はチャンクを外し、確認の記録を消す", async () => {
    const h = harness();
    withProgram(h);
    h.answers.push("yes");
    await h.run("--operator", ADMIN_UID, "verify", "p1");
    expect(await h.run("--operator", ADMIN_UID, "unverify", "p1")).toBe(0);
    const p = h.store.programs.get("p1");
    expect(p?.verified).toBe(false);
    expect(p?.verifiedAt).toBeUndefined();
    expect(p?.verifiedContentHash).toBeUndefined();
    expect(p !== undefined && isSearchable(p)).toBe(false);
    expect(searchableOf(h)).toEqual([false, false]);
  });

  it("unverify の確認状態の書き込みで失敗しても、チャンクは先に外れている（安全側）", async () => {
    const h = harness();
    withProgram(h);
    h.answers.push("yes");
    await h.run("--operator", ADMIN_UID, "verify", "p1");
    h.store.failOn.set("saveVerification", 1);
    expect(await h.run("--operator", ADMIN_UID, "unverify", "p1")).toBe(1);
    expect(searchableOf(h)).toEqual([false, false]);
    expect(await h.run("--operator", ADMIN_UID, "unverify", "p1")).toBe(0);
    expect(h.store.programs.get("p1")?.verified).toBe(false);
  });
});

describe("ops（Requirement 13.11）", () => {
  it("対象を省略すると両方、指定するとその片方だけを切り替える", async () => {
    const h = harness();
    expect(await h.run("ops", "start")).toBe(0);
    expect(h.store.ops).toMatchObject({ aiEnabled: true, collectionEnabled: true });
    expect(await h.run("ops", "stop", "ai")).toBe(0);
    expect(h.store.ops).toMatchObject({ aiEnabled: false, collectionEnabled: true });
    expect(await h.run("--operator", ADMIN_UID, "ops", "stop", "collection")).toBe(0);
    expect(h.store.ops).toMatchObject({
      aiEnabled: false,
      collectionEnabled: false,
      updatedBy: ADMIN_UID,
      updatedAt: "2026-11-09T15:30:00.000Z",
    });
  });

  it("文書が無いときに片方だけ起動しても、もう片方は停止のまま", async () => {
    const h = harness();
    expect(await h.run("ops", "start", "ai")).toBe(0);
    expect(h.store.ops).toMatchObject({ aiEnabled: true, collectionEnabled: false });
  });
});

describe("grant-admin（Requirement 3.16）", () => {
  it("プロジェクト ID を入力したときだけ、既存のクレームを保って admin を付ける", async () => {
    const h = harness();
    h.auth.users.set("u1", { plan: "beta" });
    h.answers.push("other-project");
    expect(await h.run("grant-admin", "u1")).toBe(1);
    expect(h.auth.users.get("u1")).toEqual({ plan: "beta" });
    h.answers.push(PROJECT);
    expect(await h.run("grant-admin", "u1")).toBe(0);
    expect(h.auth.users.get("u1")).toEqual({ plan: "beta", admin: true });
    expect(h.prompts[0]).toContain(PROJECT);
  });

  it("存在しないユーザー・不正な uid は失敗する", async () => {
    const h = harness();
    h.answers.push(PROJECT);
    expect(await h.run("grant-admin", "missing")).toBe(1);
    expect(await h.run("grant-admin", "a/b")).toBe(2);
  });
});

const VALID_ADD = [
  "--id",
  "city-new",
  "--url",
  "https://www.city.hachioji.tokyo.jp/new.html",
  "--municipality-code",
  "13201",
  "--level",
  "city",
];

describe("sources add（Requirement 13.4, 13.5）", () => {
  it("有効な登録は active・missCount=0 で保存する", async () => {
    const h = harness();
    expect(
      await h.run(
        "sources",
        "add",
        ...VALID_ADD,
        "--age-bands",
        "age_0_2,age_3_5",
        "--interval-hours",
        "48",
      ),
    ).toBe(0);
    expect(h.store.sources.get("city-new")).toMatchObject({
      url: "https://www.city.hachioji.tokyo.jp/new.html",
      format: "html",
      ageBands: ["age_0_2", "age_3_5"],
      intervalHours: 48,
      status: "active",
      missCount: 0,
    });
  });

  it("欠落・無効な項目名をすべて表示し、何も登録しない", async () => {
    const h = harness();
    expect(
      await h.run(
        "sources",
        "add",
        "--id",
        "x",
        "--url",
        "ftp://example.com",
        "--level",
        "national",
        "--interval-hours",
        "abc",
      ),
    ).toBe(1);
    const text = h.err.join("\n");
    expect(text).toContain("url（無効）");
    expect(text).toContain("municipalityCode（欠落）");
    expect(text).toContain("intervalHours（無効）");
    expect(h.store.sources.size).toBe(0);
  });

  it("どんな入力でも、検証に失敗すれば既存の登録を変えない（Property）", async () => {
    const field = fc.option(
      fc.oneof(
        fc.string({ maxLength: 12 }),
        fc.constantFrom(
          "13201",
          "13000",
          "00000",
          "city",
          "tokyo",
          "national",
          "https://example.jp/a",
        ),
      ),
      { nil: undefined },
    );
    await fc.assert(
      fc.asyncProperty(
        fc.record({ id: field, url: field, municipalityCode: field, level: field, format: field }),
        async (input) => {
          const h = harness();
          h.store.sources.set("existing", {
            id: "existing",
            url: "https://example.jp/a",
            municipalityCode: "13201",
            level: "city",
            format: "html",
            category: null,
            ageBands: ["unknown"],
            title: null,
            relatedSourceId: null,
            intervalHours: 24,
            status: "active",
            missCount: 0,
          });
          const before = structuredClone([...h.store.sources.entries()]);
          const argv: string[] = [];
          const names = {
            id: "--id",
            url: "--url",
            municipalityCode: "--municipality-code",
            level: "--level",
            format: "--format",
          } as const;
          for (const [key, flag] of Object.entries(names)) {
            const value = input[key as keyof typeof input];
            if (value !== undefined) argv.push(`${flag}=${value}`);
          }
          const code = await h.run("sources", "add", ...argv);
          const result = validateSourceRegistration(input, 24);
          if (!result.ok) {
            expect(code).toBe(1);
            for (const e of result.errors) expect(h.err.join("\n")).toContain(e.field);
          }
          if (code !== 0) expect([...h.store.sources.entries()]).toEqual(before);
          else expect(h.store.sources.get("existing")).toEqual(before[0]?.[1]);
        },
      ),
    );
  });

  it("同じ URL・同じ ID の登録は拒否し、既存を変えない", async () => {
    const h = harness();
    await h.run("sources", "add", ...VALID_ADD, "--title", "最初");
    expect(await h.run("sources", "add", ...VALID_ADD, "--title", "上書き")).toBe(1);
    const sameId = [...VALID_ADD];
    sameId[3] = "https://www.city.hachioji.tokyo.jp/other.html";
    expect(await h.run("sources", "add", ...sameId)).toBe(1);
    expect(h.store.sources.get("city-new")?.title).toBe("最初");
    expect(h.store.sources.size).toBe(1);
  });
});

describe("sources import（Requirement 3.1, 13.4, 13.5）", () => {
  // テストが読む固定のファイル
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- リポジトリ内の固定パス
  const seed = readFileSync(new URL("../../../config/sources.seed.json", import.meta.url), "utf8");

  it("初期の情報源リストを全件登録でき、再実行では何も変えない（冪等）", async () => {
    const h = harness();
    h.files.set("seed.json", seed);
    const rows = JSON.parse(seed) as unknown[];
    expect(await h.run("sources", "import", "seed.json")).toBe(0);
    expect(h.store.sources.size).toBe(rows.length);
    const before = structuredClone([...h.store.sources.entries()]);
    expect(await h.run("sources", "import", "seed.json")).toBe(0);
    expect([...h.store.sources.entries()]).toEqual(before);
    expect(h.out.at(-1)).toContain(`登録済みのため省略 ${rows.length} 件`);
  });

  it("失敗した行と理由を一覧にし、有効な行だけを登録する", async () => {
    const h = harness();
    h.store.sources.set("old", {
      id: "old",
      url: "https://example.jp/old.html",
      municipalityCode: "13201",
      level: "city",
      format: "html",
      category: null,
      ageBands: ["unknown"],
      title: "既存",
      relatedSourceId: null,
      intervalHours: 24,
      status: "excluded",
      missCount: 2,
    });
    h.files.set(
      "rows.json",
      JSON.stringify([
        { id: "ok-1", url: "https://example.jp/1.html", municipalityCode: "13201", level: "city" },
        { id: "bad", url: "", municipalityCode: "1", level: "city" },
        {
          id: "old",
          url: "https://example.jp/old.html",
          municipalityCode: "13201",
          level: "city",
          title: "変更",
        },
        {
          id: "old",
          url: "https://example.jp/another.html",
          municipalityCode: "13201",
          level: "city",
        },
        {
          id: "ok-1",
          url: "https://example.jp/dup.html",
          municipalityCode: "13201",
          level: "city",
        },
        "not an object",
      ]),
    );
    expect(await h.run("sources", "import", "rows.json")).toBe(1);
    expect([...h.store.sources.keys()].sort()).toEqual(["ok-1", "old"]);
    expect(h.store.sources.get("old")).toMatchObject({
      title: "既存",
      status: "excluded",
      missCount: 2,
    });
    const text = h.err.join("\n");
    expect(text).toContain("2行目（bad）: url（欠落）、municipalityCode（無効）");
    expect(text).toContain("4行目（old）");
    expect(text).toContain("5行目（ok-1）");
    expect(text).toContain("6行目");
  });

  it("--dry-run は書き込まない。配列でない・読めないファイルは失敗", async () => {
    const h = harness();
    h.files.set("seed.json", seed);
    h.files.set("obj.json", "{}");
    h.files.set("broken.json", "[");
    expect(await h.run("sources", "import", "seed.json", "--dry-run")).toBe(0);
    expect(h.store.sources.size).toBe(0);
    expect(await h.run("sources", "import", "obj.json")).toBe(1);
    expect(await h.run("sources", "import", "broken.json")).toBe(1);
    expect(await h.run("sources", "import", "missing.json")).toBe(1);
  });
});

// 検索対象・非対象が混ざり、版がそろっていないチャンクの集合
const chunkSet = fc.uniqueArray(
  fc.record({
    id: fc.stringMatching(/^c[0-9a-z]{1,6}$/),
    searchable: fc.boolean(),
    meta: fc.constantFrom("none", "v1", "v2", "v2-old-model", "v2-other-dims"),
  }),
  { selector: (c) => c.id, maxLength: 30 },
);

function seedChunks(h: Harness, set: { id: string; searchable: boolean; meta: string }[]): void {
  for (const c of set) {
    const base = chunk(c.id, { searchable: c.searchable, excerpt: `抜粋 ${c.id}` });
    const meta = { ...base.embeddingMeta };
    const vectors = { ...base.vectors };
    if (c.meta === "none") {
      delete meta["v1"];
      delete vectors["v1"];
    } else if (c.meta !== "v1") {
      meta["v2"] = {
        model: c.meta === "v2-old-model" ? "old-model" : EMBEDDING.model,
        dimensions: c.meta === "v2-other-dims" ? 4 : EMBEDDING.dimensions,
        createdAt: "2026-01-01T00:00:00.000Z",
      };
      vectors["v2"] = Array.from({ length: meta["v2"].dimensions }, (_, i) => (i === 0 ? 1 : 0));
    }
    h.store.chunks.set(c.id, { ...base, embeddingMeta: meta, vectors });
  }
}

describe("reembed と embedding set-search-version（Requirement 13.13, 13.14）", () => {
  it("収集が止まっていなければ再生成しない", async () => {
    const h = harness();
    h.store.chunks.set("c1", chunk("c1"));
    expect(await h.run("reembed", "--to", "v2")).toBe(1);
    await h.run("ops", "start");
    expect(await h.run("reembed", "--to", "v2")).toBe(1);
    expect(h.embedder.calls).toBe(0);
  });

  it("検索に使用中の版には書き込まない", async () => {
    const h = harness();
    h.store.chunks.set("c1", chunk("c1"));
    h.store.searchVersion = "v2";
    await h.run("ops", "stop", "collection");
    expect(await h.run("reembed", "--to", "v2")).toBe(1);
    expect(h.embedder.calls).toBe(0);
  });

  it("再生成の後は対象が空になり、excerpt・searchable・既存の版は変わらない（Property 51）", async () => {
    await fc.assert(
      fc.asyncProperty(chunkSet, async (set) => {
        const h = harness();
        seedChunks(h, set);
        await h.run("ops", "stop", "collection");
        const before = structuredClone([...h.store.chunks.values()]);
        const planned = planReembed(await h.store.listChunksForReembed(), V2).length;
        expect(await h.run("reembed", "--to", "v2")).toBe(0);
        const after = [...h.store.chunks.values()];
        expect(planReembed(await h.store.listChunksForReembed(), V2)).toEqual([]);
        expect(canCutover(await h.store.listChunksForReembed(), V2)).toBe(true);
        for (const [i, c] of after.entries()) {
          const b = before.at(i);
          expect(c.excerpt).toBe(b?.excerpt);
          expect(c.searchable).toBe(b?.searchable);
          expect(c.embeddingMeta["v1"]).toEqual(b?.embeddingMeta["v1"]);
          expect(c.vectors["v1"]).toEqual(b?.vectors["v1"]);
        }
        // 検索に使う版は変えない
        expect(h.store.searchVersion).toBeNull();
        expect(h.embedder.calls).toBe(Math.ceil(planned / 20));
        // 再実行しても何も書かない
        const calls = h.embedder.calls;
        expect(await h.run("reembed", "--to", "v2")).toBe(0);
        expect(h.embedder.calls).toBe(calls);
      }),
    );
  });

  it("途中で止まっても、再実行で残りだけを処理する", async () => {
    const h = harness();
    for (let i = 0; i < 45; i += 1)
      h.store.chunks.set(`c${i}`, chunk(`c${i}`, { searchable: true }));
    await h.run("ops", "stop", "collection");
    h.store.failOn.set("writeEmbedding", 1);
    // 1件目の書き込みで失敗する
    expect(await h.run("reembed", "--to", "v2")).toBe(1);
    expect(await h.run("reembed", "--to", "v2")).toBe(0);
    expect(planReembed(await h.store.listChunksForReembed(), V2)).toEqual([]);
    expect(await h.run("reembed", "--verify", "--to", "v2")).toBe(0);
  });

  it("切り替えは canCutover が真のときだけ（Property）", async () => {
    await fc.assert(
      fc.asyncProperty(chunkSet, async (set) => {
        const h = harness();
        seedChunks(h, set);
        h.store.searchVersion = "v1";
        const allowed = canCutover(await h.store.listChunksForReembed(), V2);
        const code = await h.run("embedding", "set-search-version", "v2");
        expect(code).toBe(allowed ? 0 : 1);
        expect(h.store.searchVersion).toBe(allowed ? "v2" : "v1");
      }),
    );
  });

  it("書き込み → 検証 → 切り替え → 後片付けの順に進められる", async () => {
    const h = harness();
    h.store.chunks.set("c1", chunk("c1", { searchable: true }));
    h.store.chunks.set("c2", chunk("c2", { searchable: false }));
    h.store.searchVersion = "v1";
    await h.run("ops", "stop", "collection");

    expect(await h.run("reembed", "--verify", "--to", "v2")).toBe(1);
    expect(await h.run("embedding", "set-search-version", "v2")).toBe(1);
    expect(h.err.join("\n")).toContain("1 件");

    expect(await h.run("reembed", "--to", "v2")).toBe(0);
    expect(await h.run("reembed", "--verify", "--to", "v2")).toBe(0);
    // 使用中の版・設定の版は消せない
    expect(await h.run("reembed", "--cleanup", "--version", "v1")).toBe(1);
    expect(await h.run("embedding", "set-search-version", "v2")).toBe(0);
    expect(h.store.searchVersion).toBe("v2");
    expect(await h.run("reembed", "--cleanup", "--version", "v2")).toBe(1);
    expect(h.out.join("\n")).toContain("embedding.version は v1");

    // 設定の版を v2 に変えた後は、v1 を削除できる
    h.deps.embedding = V2;
    expect(await h.run("reembed", "--cleanup", "--version", "v1")).toBe(0);
    for (const c of h.store.chunks.values()) {
      expect(c.embeddingMeta["v1"]).toBeUndefined();
      expect(c.vectors["v1"]).toBeUndefined();
      expect(c.embeddingMeta["v2"]).toBeDefined();
    }
  });

  it("不正な版の名前は使い方の誤り", async () => {
    const h = harness();
    expect(await h.run("embedding", "set-search-version", "__proto__.x")).toBe(2);
    expect(await h.run("reembed", "--cleanup")).toBe(2);
    expect(await h.run("reembed", "--cleanup", "--version", "v1", "--verify")).toBe(2);
  });
});

describe("inspectVectors", () => {
  it("欠落・次元・ノルム・記録の不一致を検出し、検索対象外は無視する", () => {
    const meta = { model: EMBEDDING.model, dimensions: 8, createdAt: "" };
    const ok = Array.from({ length: 8 }, (_, i) => (i === 0 ? 1 : 0));
    const problems = inspectVectors(
      [
        { id: "a", searchable: true, meta, vector: ok },
        { id: "b", searchable: true, meta, vector: undefined },
        { id: "c", searchable: true, meta, vector: [1, 0] },
        { id: "d", searchable: true, meta, vector: ok.map((x) => x * 2) },
        { id: "e", searchable: true, meta: { ...meta, model: "x" }, vector: ok },
        { id: "f", searchable: false, meta: undefined, vector: undefined },
      ],
      { ...EMBEDDING, version: "v2" },
    );
    expect(problems.map((p) => p.split(":")[0])).toEqual(["b", "c", "d", "e"]);
  });
});

describe("年齢区分の入力", () => {
  it("--age-bands はカンマ区切りで、未知の区分は無効", async () => {
    const h = harness();
    expect(
      await h.run("sources", "add", ...VALID_ADD, "--age-bands", `${SOURCE_AGE_BANDS[0]},adult`),
    ).toBe(1);
    expect(h.err.join("\n")).toContain("ageBands（無効）");
  });
});
