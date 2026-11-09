// 実行時の設定（Vite の環境変数）。Firebase の Web 設定は公開されても問題ない識別子。

export type FirebaseWebConfig = {
  readonly apiKey: string;
  readonly authDomain: string;
  readonly projectId: string;
  readonly appId: string;
};

export type AppEnv = {
  /** 未設定なら仮のログイン（モック）を使う */
  readonly firebase: FirebaseWebConfig | null;
  readonly authEmulatorUrl: string | null;
  readonly apiMode: "mock" | "http";
};

export function readEnv(raw: Record<string, string | undefined>): AppEnv {
  const v = (k: string) => {
    const s = raw[k]?.trim();
    return s ? s : null;
  };
  const apiKey = v("VITE_FIREBASE_API_KEY");
  const authDomain = v("VITE_FIREBASE_AUTH_DOMAIN");
  const projectId = v("VITE_FIREBASE_PROJECT_ID");
  const appId = v("VITE_FIREBASE_APP_ID");
  return {
    firebase:
      apiKey && authDomain && projectId && appId ? { apiKey, authDomain, projectId, appId } : null,
    authEmulatorUrl: v("VITE_AUTH_EMULATOR_URL"),
    apiMode: v("VITE_API_MODE") === "http" ? "http" : "mock",
  };
}
