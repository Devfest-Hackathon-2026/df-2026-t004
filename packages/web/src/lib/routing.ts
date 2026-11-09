// ログイン状態と世帯情報から、表示してよい画面を決める（Requirement 1.1）。
// 未認証では、ダッシュボード・チャット・世帯データの画面を一切表示しない。

export type SessionState =
  "checking" | "signed-out" | "loading-household" | "needs-onboarding" | "ready";

const PUBLIC = new Set(["/", "/terms", "/privacy", "/deleted"]);
const isOnboarding = (p: string) => p.startsWith("/onboarding/");
const isLegal = (p: string) => p === "/terms" || p === "/privacy";

/** 表示してよければ null、だめなら移動先を返す。確認中は "wait" */
export function routeFor(state: SessionState, pathname: string): string | null | "wait" {
  if (isLegal(pathname)) return null;
  switch (state) {
    case "checking":
      return PUBLIC.has(pathname) ? null : "wait";
    case "signed-out":
      return PUBLIC.has(pathname) ? null : "/";
    case "loading-household":
      return "wait";
    case "needs-onboarding":
      return isOnboarding(pathname) ? null : "/onboarding/postal";
    case "ready":
      return pathname === "/" || isOnboarding(pathname) ? "/home" : null;
  }
}
