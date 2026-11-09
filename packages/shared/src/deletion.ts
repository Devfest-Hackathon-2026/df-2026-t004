// アカウント削除の計画（Requirement 8.3, 8.5）
// 削除対象は `users/{uid}` 配下と、その uid の利用回数ドキュメントだけ。他のユーザーには触れない。

const USAGE_USER_DOC = /^usageUsers\/\d{4}-\d{2}-\d{2}_(.+)$/;

/** Firebase の uid として扱える文字列か（空・パス区切りを含むものは不可） */
function isSafeUid(uid: string): boolean {
  return uid.length > 0 && uid.length <= 128 && !uid.includes("/");
}

/** そのパスが、この uid のアカウント削除の対象か */
export function isDeletionTarget(uid: string, path: string): boolean {
  if (!isSafeUid(uid)) return false;
  if (path === `users/${uid}` || path.startsWith(`users/${uid}/`)) return true;
  const m = USAGE_USER_DOC.exec(path);
  return m !== null && m[1] === uid;
}

/**
 * 既存のドキュメントパスから、削除すべきものを選ぶ（Property 47）。
 * uid が不正なら何も削除しない。
 */
export function planAccountDeletion(uid: string, allPaths: readonly string[]): string[] {
  return [...new Set(allPaths.filter((p) => isDeletionTarget(uid, p)))].sort();
}

/** 削除の計画を適用した後に残るパス（テストと Emulator での確認用） */
export function applyDeletionPlan(allPaths: readonly string[], plan: readonly string[]): string[] {
  const del = new Set(plan);
  return allPaths.filter((p) => !del.has(p));
}

export type DeletionStepOutcome = "ok" | "failed" | "timeout";
export type AuthDeletionOutcome = "ok" | "user-not-found" | "failed";

export type DeletionResult = {
  readonly state: "done" | "failed";
  /** 完了したときだけサインアウトする。失敗時はサインイン状態を維持して再試行させる */
  readonly signOut: boolean;
};

/**
 * Firestore と Auth の削除結果から、ジョブの状態を決める。
 * Auth ユーザーが既に無い（user-not-found）は成功として扱う（冪等）。
 */
export function deletionResult(
  firestore: DeletionStepOutcome,
  auth: AuthDeletionOutcome | "skipped",
): DeletionResult {
  const done = firestore === "ok" && (auth === "ok" || auth === "user-not-found");
  return { state: done ? "done" : "failed", signOut: done };
}
