// エンドポイントの実装前に、所有者検査のテストを動かすためのダミーのルート。
// 実際のルートと同じく createApi の guards.owner を通し、Admin SDK で Firestore を読み書きする。
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import type { Hono, MiddlewareHandler } from "hono";
import type { AppEnv, DataCategory, HttpMethod } from "../../src/index.js";

type CategoryStore = {
  /** 対象のドキュメントのパス */
  docPath: (uid: string) => string;
  /** ドキュメント内のフィールドに保存する区分（世帯情報・子どもの情報） */
  field?: string;
};

export const CATEGORY_STORES: Readonly<Record<DataCategory, CategoryStore>> = {
  household: { docPath: (uid) => `users/${uid}`, field: "household" },
  children: { docPath: (uid) => `users/${uid}`, field: "children" },
  applications: { docPath: (uid) => `users/${uid}/applications/p1` },
  expenses: { docPath: (uid) => `users/${uid}/expenses/e1` },
  chats: { docPath: (uid) => `users/${uid}/chats/c1` },
  sensitive: { docPath: (uid) => `users/${uid}/sensitive/profile` },
};

export const DUMMY_METHODS: readonly HttpMethod[] = ["GET", "POST", "PATCH", "DELETE"];

export function dummyPath(category: DataCategory): string {
  return `/__dummy/users/:uid/${category}`;
}

export function mountDummyRoutes(
  app: Hono<AppEnv>,
  db: Firestore,
  // 実際のルートと同じ所有者検査（createApi の guards.owner）
  owner: MiddlewareHandler<AppEnv>[],
): void {
  for (const [category, store] of Object.entries(CATEGORY_STORES) as [
    DataCategory,
    CategoryStore,
  ][]) {
    const path = dummyPath(category);
    app.use(path, ...owner);

    app.get(path, async (c) => {
      const snap = await db.doc(store.docPath(c.get("uid"))).get();
      const data = snap.data();
      return c.json({ data: store.field ? data?.[store.field] : data });
    });

    // POST と PATCH では、質問文などを含む入力をあえてロガーに渡す
    // （許可リストで落ちることを、ログのスキャンで確認する）
    const write = async (body: Record<string, unknown>, uid: string, merge: boolean) => {
      const ref = db.doc(store.docPath(uid));
      if (store.field) {
        await ref.set({ [store.field]: body }, { merge: true });
      } else {
        await ref.set(body, { merge });
      }
    };

    app.post(path, async (c) => {
      const body = await c.req.json<Record<string, unknown>>();
      c.get("logger").info("dummy.write", { ...body, count: 1 });
      await write(body, c.get("uid"), false);
      return c.json({ ok: true }, 201);
    });

    app.patch(path, async (c) => {
      const body = await c.req.json<Record<string, unknown>>();
      c.get("logger").info("dummy.update", { ...body, count: 1 });
      await write(body, c.get("uid"), true);
      return c.json({ ok: true });
    });

    app.delete(path, async (c) => {
      const ref = db.doc(store.docPath(c.get("uid")));
      if (store.field) {
        await ref.update({ [store.field]: FieldValue.delete() });
      } else {
        await ref.delete();
      }
      return c.body(null, 204);
    });
  }
}
