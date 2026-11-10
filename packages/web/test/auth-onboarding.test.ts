import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AUTH_INCOMPLETE,
  LOGIN_FAILED,
  authErrorView,
  reauthErrorMessage,
  withTimeout,
} from "../src/lib/authErrors.js";
import { readEnv } from "../src/lib/env.js";
import { routeFor, type SessionState } from "../src/lib/routing.js";
import { createMockAuth } from "../src/services/auth.js";
import { createMockHouseholdApi } from "../src/services/householdApi.js";

describe("画面の振り分け（Requirement 1.1）", () => {
  const protectedPaths = ["/home", "/search", "/chat", "/my", "/programs/p1", "/onboarding/postal"];

  it("未認証・確認中は、ダッシュボード・チャット・世帯データの画面を表示しない", () => {
    for (const p of protectedPaths) {
      expect(routeFor("signed-out", p)).toBe("/");
      expect(routeFor("checking", p)).toBe("wait");
      expect(routeFor("loading-household", p)).toBe("wait");
    }
    expect(routeFor("signed-out", "/")).toBeNull();
  });

  it("規約とポリシーは、どの状態でも読める", () => {
    const states: SessionState[] = [
      "checking",
      "signed-out",
      "loading-household",
      "needs-onboarding",
      "ready",
    ];
    for (const s of states) {
      expect(routeFor(s, "/terms")).toBeNull();
      expect(routeFor(s, "/privacy")).toBeNull();
    }
  });

  it("世帯が未登録ならオンボーディングへ、登録済みならオンボーディングとログイン画面からホームへ", () => {
    expect(routeFor("needs-onboarding", "/home")).toBe("/onboarding/postal");
    expect(routeFor("needs-onboarding", "/onboarding/children")).toBeNull();
    expect(routeFor("ready", "/")).toBe("/home");
    expect(routeFor("ready", "/onboarding/consent")).toBe("/home");
    expect(routeFor("ready", "/chat")).toBeNull();
  });
});

describe("認証のエラー表示（Requirement 1.4, 1.5, 1.7）", () => {
  it("ログインの失敗は、メールアドレスが登録済みかどうかを明かさない同じ文になる", () => {
    for (const code of [
      "auth/user-not-found",
      "auth/wrong-password",
      "auth/invalid-credential",
      "auth/email-already-in-use",
    ]) {
      expect(authErrorView(code, "login")).toEqual({ field: "form", message: LOGIN_FAILED });
    }
  });

  it("登録の失敗は、入力欄ごとに理由を示す", () => {
    expect(authErrorView("auth/email-already-in-use", "register").field).toBe("email");
    expect(authErrorView("auth/invalid-email", "register").field).toBe("email");
    expect(authErrorView("auth/weak-password", "register").field).toBe("password");
  });

  it("キャンセル・不明なエラーは「認証が完了しませんでした」", () => {
    fc.assert(
      fc.property(fc.string(), (code) => {
        fc.pre(!code.startsWith("auth/") && code !== "app/timeout");
        expect(authErrorView(code, "login").message).toBe(AUTH_INCOMPLETE);
      }),
    );
    expect(authErrorView("auth/popup-closed-by-user", "register").message).toBe(AUTH_INCOMPLETE);
  });

  it("10秒を超えたら app/timeout で失敗する", async () => {
    await expect(withTimeout(new Promise(() => {}), 10)).rejects.toMatchObject({
      code: "app/timeout",
    });
    await expect(withTimeout(Promise.resolve(1), 10)).resolves.toBe(1);
  });
});

describe("設定", () => {
  it("Firebase の設定が欠けていればモックを使い、API の既定は mock", () => {
    expect(readEnv({}).firebase).toBeNull();
    expect(readEnv({}).apiMode).toBe("mock");
    const full = {
      VITE_FIREBASE_API_KEY: "k",
      VITE_FIREBASE_AUTH_DOMAIN: "d",
      VITE_FIREBASE_PROJECT_ID: "p",
      VITE_FIREBASE_APP_ID: "a",
      VITE_API_MODE: "http",
    };
    expect(readEnv(full).firebase).toEqual({
      apiKey: "k",
      authDomain: "d",
      projectId: "p",
      appId: "a",
    });
    expect(readEnv(full).apiMode).toBe("http");
    expect(readEnv({ ...full, VITE_FIREBASE_APP_ID: " " }).firebase).toBeNull();
  });
});

describe("世帯の保存（モック。Requirement 2.5〜2.7, 9.1, 9.2）", () => {
  const base = { postalCode: "192-0083", children: [{ ageYears: 4 }], onboardingDeferred: [] };

  it("同意しないと、出産予定日・状況・自由記述は保存されない", async () => {
    const api = createMockHouseholdApi();
    const r = await api.saveHousehold(
      {
        ...base,
        dueDate: "2027-01-10",
        situationChips: ["disability"],
        freeText: "メモ",
        sensitiveConsent: false,
      },
      "2026-11-09",
    );
    expect(r.ok && r.household.sensitive).toBeNull();
    expect(JSON.stringify(await api.getHousehold())).not.toMatch(/disability|2027-01-10|メモ/);
  });

  it("同意すると保存され、必須項目だけでも保存できる", async () => {
    const api = createMockHouseholdApi();
    const r = await api.saveHousehold(
      { ...base, dueDate: "2027-01-10", sensitiveConsent: true },
      "2026-11-09",
    );
    expect(r.ok && r.household.sensitive?.pregnancy?.dueDate).toBe("2027-01-10");
    const minimal = await api.saveHousehold({ ...base, sensitiveConsent: false }, "2026-11-09");
    expect(minimal.ok).toBe(true);
    if (minimal.ok)
      expect(minimal.household).toMatchObject({
        city: "八王子市",
        children: [{ ageYears: 4, recordedAt: "2026-11-09" }],
      });
  });

  it("人数0で出産予定日が無いときは保存しない", async () => {
    const r = await createMockHouseholdApi().saveHousehold(
      { ...base, children: [], sensitiveConsent: false },
      "2026-11-09",
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.field)).toContain("dueDate");
  });
});

describe("アカウント削除の前の再認証（#106）", () => {
  it("仮の認証: パスワードの人は正しいパスワードでだけ再認証でき、Google の人はそのまま通る", async () => {
    const auth = createMockAuth();
    expect(auth.reauthMethod()).toBeNull();
    await auth.signUpWithEmail("a@example.com", "right-password-1");
    expect(auth.reauthMethod()).toBe("password");
    await expect(auth.reauthenticate("wrong-password")).rejects.toMatchObject({
      code: "auth/invalid-credential",
    });
    await expect(auth.reauthenticate("")).rejects.toMatchObject({
      code: "auth/invalid-credential",
    });
    await expect(auth.reauthenticate("right-password-1")).resolves.toBeUndefined();

    await auth.signInWithGoogle();
    expect(auth.reauthMethod()).toBe("google");
    await expect(auth.reauthenticate()).resolves.toBeUndefined();
  });

  it("失敗の理由を画面の文に変える。キャンセルは「完了しませんでした」", () => {
    expect(reauthErrorMessage("auth/invalid-credential")).toBe("パスワードが正しくありません");
    expect(reauthErrorMessage("auth/wrong-password")).toBe("パスワードが正しくありません");
    expect(reauthErrorMessage("auth/popup-closed-by-user")).toBe(AUTH_INCOMPLETE);
    expect(reauthErrorMessage("auth/user-mismatch")).toMatch("同じアカウント");
  });
});
