// `users/{uid}` のデータを扱うルートの一覧（Requirement 15.2）
//
// エンドポイントを追加したら、ここに1行足す。
// 所有者検査の統合テスト（test/ownership.integration.test.ts）は、この一覧のすべての行が
// テスト表に含まれていることを検査するため、テストの追加漏れがあると失敗する。

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** 所有者検査の対象となるデータ区分 */
export type DataCategory =
  "household" | "children" | "applications" | "expenses" | "chats" | "sensitive";

export type OwnerRoute = {
  readonly method: HttpMethod;
  /** Hono のパス（`:uid` を必ず含む） */
  readonly path: string;
  readonly category: DataCategory;
};

export const OWNER_ROUTES: readonly OwnerRoute[] = [
  // エンドポイントの実装（タスク 12 以降）で追加する
];

export function routeKey(route: Pick<OwnerRoute, "method" | "path">): string {
  return `${route.method} ${route.path}`;
}
