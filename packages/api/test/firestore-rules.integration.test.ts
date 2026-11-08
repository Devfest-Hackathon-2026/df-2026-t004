// Firestore Security Rules の統合テスト（Requirement 9.6, 9.7, 15.2）
// `npm run test:integration` で Firestore Emulator 上で実行する。
import { readFileSync } from "node:fs";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestContext,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import {
  deleteDoc,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  type DocumentData,
  type Firestore,
} from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const PROJECT_ID = "demo-hachioji-gov";
const OWNER = "owner-uid";
const OTHER = "other-uid";

const rulesPath = new URL("../../../firebase/firestore.rules", import.meta.url);

let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    // 固定パス（リポジトリ内の規則ファイル）を読むだけなので安全
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    firestore: { rules: readFileSync(rulesPath, "utf-8") },
  });
});

afterAll(async () => {
  await env?.cleanup();
});

/** 規則を無効にした管理者の立場で、初期データを入れる */
async function seed(path: string, data: DocumentData): Promise<void> {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore() as unknown as Firestore, path), data);
  });
}

/** 規則を無効にした管理者の立場で、現在のデータを読む（拒否前後の比較用） */
async function snapshot(path: string): Promise<DocumentData | undefined> {
  let data: DocumentData | undefined;
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await getDoc(doc(ctx.firestore() as unknown as Firestore, path));
    data = snap.data();
  });
  return data;
}

function db(ctx: RulesTestContext): Firestore {
  return ctx.firestore() as unknown as Firestore;
}

type Actor = "owner" | "other" | "unauthenticated";

function contextFor(actor: Actor): RulesTestContext {
  switch (actor) {
    case "owner":
      return env.authenticatedContext(OWNER);
    case "other":
      return env.authenticatedContext(OTHER);
    case "unauthenticated":
      return env.unauthenticatedContext();
  }
}

const userDoc = {
  household: {
    postalCode: "1920001",
    municipalityCode: "13201",
    children: [{ id: "c1", ageYears: 3, recordedAt: "2026-04-01" }],
  },
  createdAt: "2026-04-01",
};

type Category = {
  /** データ区分の名前 */
  name: string;
  /** 所有者のデータのパス */
  path: string;
  /** 初期データ */
  initial: DocumentData;
  /** 書き込みの操作 */
  write: (firestore: Firestore, path: string) => Promise<unknown>;
  /** 本人がクライアントから書き込めるか（要配慮情報は API 経由のみ） */
  ownerCanWrite: boolean;
};

const categories: Category[] = [
  {
    name: "世帯情報",
    path: `users/${OWNER}`,
    initial: userDoc,
    write: (f, p) => updateDoc(doc(f, p), { "household.postalCode": "1920002" }),
    ownerCanWrite: true,
  },
  {
    name: "子どもの情報",
    path: `users/${OWNER}`,
    initial: userDoc,
    write: (f, p) =>
      updateDoc(doc(f, p), {
        "household.children": [{ id: "c2", ageYears: 5, recordedAt: "2026-05-01" }],
      }),
    ownerCanWrite: true,
  },
  {
    name: "申請状況",
    path: `users/${OWNER}/applications/p1`,
    initial: { status: "inProgress", deadline: "2026-12-01" },
    write: (f, p) => setDoc(doc(f, p), { status: "done" }),
    ownerCanWrite: true,
  },
  {
    name: "医療費記録",
    path: `users/${OWNER}/expenses/e1`,
    initial: { date: "2026-04-10", amount: 1200, clinic: "テスト医院" },
    write: (f, p) => setDoc(doc(f, p), { amount: 99999 }),
    ownerCanWrite: true,
  },
  {
    name: "チャット履歴",
    path: `users/${OWNER}/chats/ch1`,
    initial: { answer: "回答", createdAt: "2026-04-10" },
    write: (f, p) => setDoc(doc(f, p), { answer: "改ざん" }),
    ownerCanWrite: true,
  },
  {
    name: "要配慮情報",
    path: `users/${OWNER}/sensitive/profile`,
    initial: { situationChips: ["sports"], updatedAt: "2026-04-01" },
    write: (f, p) => setDoc(doc(f, p), { situationChips: [] }),
    ownerCanWrite: false,
  },
];

beforeEach(async () => {
  await env.clearFirestore();
  // 要配慮情報の読み取り規則は users/{uid} の存在を前提にするため、常に用意する
  await seed(`users/${OWNER}`, userDoc);
  for (const c of categories) {
    await seed(c.path, c.initial);
  }
});

describe.each(categories)("$name ($path)", (category) => {
  it("本人は読み取れる", async () => {
    await assertSucceeds(getDoc(doc(db(contextFor("owner")), category.path)));
  });

  it(`本人の書き込みは${category.ownerCanWrite ? "許可" : "拒否"}される`, async () => {
    const op = category.write(db(contextFor("owner")), category.path);
    if (category.ownerCanWrite) {
      await assertSucceeds(op);
    } else {
      await assertFails(op);
      expect(await snapshot(category.path)).toEqual(category.initial);
    }
  });

  describe.each<Actor>(["other", "unauthenticated"])("%s", (actor) => {
    it("読み取りは拒否される", async () => {
      await assertFails(getDoc(doc(db(contextFor(actor)), category.path)));
    });

    it("書き込みは拒否され、データは変わらない", async () => {
      await assertFails(category.write(db(contextFor(actor)), category.path));
      expect(await snapshot(category.path)).toEqual(category.initial);
    });

    it("削除は拒否され、データは変わらない", async () => {
      await assertFails(deleteDoc(doc(db(contextFor(actor)), category.path)));
      expect(await snapshot(category.path)).toEqual(category.initial);
    });
  });
});

describe("API だけが変更できるフラグ", () => {
  it.each(["deleting", "sensitiveLocked"])("本人でも %s は書き込めない", async (flag) => {
    const owner = db(contextFor("owner"));
    await assertFails(updateDoc(doc(owner, `users/${OWNER}`), { [flag]: false }));
    expect(await snapshot(`users/${OWNER}`)).toEqual(userDoc);
  });

  it("sensitiveLocked が立っている間は、本人でも要配慮情報を読めない", async () => {
    await seed(`users/${OWNER}`, { ...userDoc, sensitiveLocked: true });
    await assertFails(getDoc(doc(db(contextFor("owner")), `users/${OWNER}/sensitive/profile`)));
  });
});

describe("サーバー専用のコレクション", () => {
  const serverOnly = [
    "sources/s1",
    "chunks/k1",
    "fetchLogs/l1",
    "config/operations",
    "usage/2026-04-01",
    `usageUsers/2026-04-01_${OWNER}`,
    `deletionJobs/${OWNER}`,
  ];

  describe.each(serverOnly)("%s", (path) => {
    beforeEach(async () => {
      await seed(path, { value: 1 });
    });

    it.each<Actor>(["owner", "unauthenticated"])(
      "%s の読み取り・書き込みは拒否される",
      async (actor) => {
        const f = db(contextFor(actor));
        await assertFails(getDoc(doc(f, path)));
        await assertFails(setDoc(doc(f, path), { value: 2 }));
        expect(await snapshot(path)).toEqual({ value: 1 });
      },
    );
  });
});

describe("programs", () => {
  beforeEach(async () => {
    await seed("programs/p1", { name: "制度" });
  });

  it("認証済みは読み取れる", async () => {
    await assertSucceeds(getDoc(doc(db(contextFor("owner")), "programs/p1")));
  });

  it("未認証は読み取れない", async () => {
    await assertFails(getDoc(doc(db(contextFor("unauthenticated")), "programs/p1")));
  });

  it("認証済みでも書き込めない", async () => {
    await assertFails(setDoc(doc(db(contextFor("owner")), "programs/p1"), { name: "改ざん" }));
    expect(await snapshot("programs/p1")).toEqual({ name: "制度" });
  });
});
