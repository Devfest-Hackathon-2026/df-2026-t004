// 下部タブバーの項目（Requirement 11.5）。順序はホーム／さがす／AI相談／マイホームで固定。
export const TAB_ITEMS = [
  { key: "home", to: "/home", label: "ホーム" },
  { key: "search", to: "/search", label: "さがす" },
  { key: "chat", to: "/chat", label: "AI相談" },
  { key: "my", to: "/my", label: "マイホーム" },
] as const;
export type TabKey = (typeof TAB_ITEMS)[number]["key"];

/** 下部タブバーを出す画面（主要画面すべて） */
export const TAB_ROUTES = /^\/(home|search|chat|my|programs)(\/|$)/;

export function showsTabBar(pathname: string): boolean {
  return TAB_ROUTES.test(pathname);
}
