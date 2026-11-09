// インストール案内の判定（Requirement 11.2, 11.9）。ブラウザの API に触れない純粋関数。

export type InstallHint = "prompt" | "ios" | null;

/** iPhone / iPad の Safari 系か（iPadOS はデスクトップの UA を名乗るのでタッチ点数で見分ける） */
export function isIos(userAgent: string, maxTouchPoints = 0): boolean {
  if (/iPhone|iPad|iPod/.test(userAgent)) return true;
  return /Macintosh/.test(userAgent) && maxTouchPoints > 1;
}

/** ホーム画面から起動したスタンドアロン表示か */
export function isStandalone(
  displayModeStandalone: boolean,
  navigatorStandalone?: boolean,
): boolean {
  return displayModeStandalone || navigatorStandalone === true;
}

/**
 * どの案内を出すか。
 * - すでにスタンドアロンで起動している、または閉じられたあとは出さない
 * - beforeinstallprompt を受け取っていればインストールボタン
 * - iOS は beforeinstallprompt が無いので「共有 → ホーム画面に追加」の説明
 */
export function installHint(input: {
  readonly userAgent: string;
  readonly maxTouchPoints?: number;
  readonly standalone: boolean;
  readonly hasPrompt: boolean;
  readonly dismissed: boolean;
}): InstallHint {
  if (input.standalone || input.dismissed) return null;
  if (input.hasPrompt) return "prompt";
  if (isIos(input.userAgent, input.maxTouchPoints)) return "ios";
  return null;
}
