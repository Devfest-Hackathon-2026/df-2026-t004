// API の所有者検査の統合テスト（Requirement 15.1, 15.2）
// `npm run test:integration` で Firebase Emulator（Auth + Firestore）上で実行する。
//
// 運用: `src/routes.ts` の OWNER_ROUTES にエンドポイントを足したら、下の ROUTE_TABLE にも
// 同じ行を足す（足し忘れると「ルート一覧がすべてテスト表にある」のテストが失敗する）。
import type { Hono } from "hono";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createApi,
  OWNER_ROUTES,
  routeKey,
  type AppEnv,
  type DataCategory,
  type HttpMethod,
} from "../src/index.js";
import { CANARY_NOTE, CANARY_QUESTION } from "./support/canaries.js";
import {
  CATEGORY_STORES,
  DUMMY_METHODS,
  dummyPath,
  mountDummyRoutes,
} from "./support/dummy-routes.js";
import {
  adminDb,
  createTestUser,
  emulatorVerifier,
  resetEmulators,
  type TestUser,
} from "./support/emulator.js";

type RouteRow = {
  method: HttpMethod;
  /** Hono のパス（`:uid` を含む） */
  path: string;
  category: DataCategory;
  /** 対象データのドキュメントのパス（拒否前後の比較に使う） */
  docPath: (uid: string) => string;
  /** 送る本文（GET と DELETE では使わない） */
  body?: Record<string, unknown>;
};

// --- テスト表 ---------------------------------------------------------------
// 実際のエンドポイントを追加するたびに、ここへ1行足す。
const ROUTE_TABLE: RouteRow[] = [
  // 例: { method: "GET", path: "/users/:uid/expenses", category: "expenses", docPath: (u) => `users/${u}/expenses/e1` },
];

// エンドポイントの実装前は、ダミーのルートで同じ検査が動くことを確認する
const DUMMY_TABLE: RouteRow[] = (
  Object.entries(CATEGORY_STORES) as [DataCategory, (typeof CATEGORY_STORES)[DataCategory]][]
).flatMap(([category, store]) =>
  DUMMY_METHODS.map((method) => ({
    method,
    path: dummyPath(category),
    category,
    docPath: store.docPath,
    body: { question: CANARY_QUESTION, note: CANARY_NOTE, value: "changed" },
  })),
);

// --- 初期データ ---------------------------------------------------------------

function seedData(uid: string): Record<string, Record<string, unknown>> {
  return {
    [`users/${uid}`]: {
      household: { postalCode: "1920001", municipalityCode: "13201" },
      children: [{ id: "c1", ageYears: 3, recordedAt: "2026-04-01" }],
      createdAt: "2026-04-01",
    },
    [`users/${uid}/applications/p1`]: { status: "inProgress" },
    [`users/${uid}/expenses/e1`]: { amount: 1200, clinic: "テスト医院" },
    [`users/${uid}/chats/c1`]: { answer: "回答" },
    [`users/${uid}/sensitive/profile`]: { situationChips: ["sports"] },
  };
}

async function seed(uid: string): Promise<void> {
  const db = adminDb();
  await Promise.all(Object.entries(seedData(uid)).map(([path, data]) => db.doc(path).set(data)));
}

async function snapshot(path: string): Promise<unknown> {
  return (await adminDb().doc(path).get()).data();
}

// --- 実行 -------------------------------------------------------------------

let app: Hono<AppEnv>;
let owner: TestUser;
let other: TestUser;

beforeAll(() => {
  // 実際のミドルウェア（レート制限・ID トークン検証・認可）を通す
  const api = createApi({
    config: {
      rateLimit: {
        perUserPerMinute: 10_000,
        perIpPerMinute: 10_000,
        windowSec: 60,
        maxEntries: 1000,
      },
    },
    verifier: emulatorVerifier(),
  });
  app = api.app;
  mountDummyRoutes(app, adminDb(), api.guards.owner);
});

beforeEach(async () => {
  await resetEmulators();
  owner = await createTestUser("owner-uid");
  other = await createTestUser("other-uid");
  await seed(owner.uid);
  await seed(other.uid);
});

function request(row: RouteRow, targetUid: string, idToken?: string): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (idToken !== undefined) headers["Authorization"] = `Bearer ${idToken}`;
  const hasBody = row.method !== "GET" && row.method !== "DELETE";
  return Promise.resolve(
    app.request(row.path.replace(":uid", encodeURIComponent(targetUid)), {
      method: row.method,
      headers,
      body: hasBody ? JSON.stringify(row.body ?? {}) : undefined,
    }),
  );
}

describe("ルート一覧がすべてテスト表にある", () => {
  it("OWNER_ROUTES の各行に対応するテスト表の行がある", () => {
    const tested = new Set(ROUTE_TABLE.map(routeKey));
    const missing = OWNER_ROUTES.map(routeKey).filter((key) => !tested.has(key));
    expect(missing).toEqual([]);
  });

  it("OWNER_ROUTES のパスはすべて :uid を含む", () => {
    expect(OWNER_ROUTES.filter((r) => !r.path.includes(":uid"))).toEqual([]);
  });
});

describe.each([
  ["実際のルート", ROUTE_TABLE],
  ["ダミーのルート", DUMMY_TABLE],
] as const)("%s", (_label, table) => {
  if (table.length === 0) {
    it.skip("まだルートがない", () => {});
    return;
  }

  describe.each(table)("$category: $method $path", (row) => {
    it("未認証は 401 で、データは変わらない", async () => {
      const before = await snapshot(row.docPath(owner.uid));
      const res = await request(row, owner.uid);
      expect(res.status).toBe(401);
      expect(await snapshot(row.docPath(owner.uid))).toEqual(before);
    });

    it("無効なトークンは 401 で、データは変わらない", async () => {
      const before = await snapshot(row.docPath(owner.uid));
      const res = await request(row, owner.uid, "invalid-token");
      expect(res.status).toBe(401);
      expect(await snapshot(row.docPath(owner.uid))).toEqual(before);
    });

    it("他人は 403 で、データは変わらない", async () => {
      const before = await snapshot(row.docPath(owner.uid));
      const res = await request(row, owner.uid, other.idToken);
      expect(res.status).toBe(403);
      expect(await snapshot(row.docPath(owner.uid))).toEqual(before);
    });

    it("拒否の応答本文に入力の内容を含まない", async () => {
      const res = await request(row, owner.uid, other.idToken);
      const text = await res.text();
      expect(text).not.toContain(CANARY_QUESTION);
      expect(text).not.toContain(CANARY_NOTE);
    });

    it("本人は成功する（対照）", async () => {
      const res = await request(row, owner.uid, owner.idToken);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    });
  });
});
