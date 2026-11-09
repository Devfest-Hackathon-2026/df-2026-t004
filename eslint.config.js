import js from "@eslint/js";
import tseslint from "typescript-eslint";
import security from "eslint-plugin-security";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default tseslint.config(
  // 対象外
  { ignores: ["**/dist/**", "**/coverage/**", "**/node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  security.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  // Web（PWA）はブラウザで、Service Worker はワーカーで動く
  {
    files: ["packages/web/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    files: ["packages/web/src/sw.ts"],
    languageOptions: {
      globals: { ...globals.serviceworker },
    },
  },
  // 最後に置き、Prettier と衝突する整形ルールを無効化する
  prettier,
);
