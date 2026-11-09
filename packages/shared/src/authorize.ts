// 所有者検査（Requirement 9.6, 9.7, 15.2）
// API のすべての `users/{uid}` 系ルートは、この関数の結果に従って許可・拒否する。

export type AccessDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly status: 401 | 403 };

/**
 * 認証済みで、トークンの uid とパスの uid が等しいときだけ許可する。
 * - 未認証（または uid が空）は 401
 * - uid の不一致は 403
 */
export function authorizeAccess(
  tokenUid: string | null | undefined,
  pathUid: string,
  authenticated: boolean,
): AccessDecision {
  if (!authenticated || typeof tokenUid !== "string" || tokenUid.length === 0) {
    return { allowed: false, status: 401 };
  }
  // パスの uid が空のときは、どのトークンとも一致させない
  if (pathUid.length === 0 || tokenUid !== pathUid) {
    return { allowed: false, status: 403 };
  }
  return { allowed: true };
}
