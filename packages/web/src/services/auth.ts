// 認証。登録・ログインは Firebase Authentication の SDK で直接行う（独自のログイン API は作らない）。
// Firebase の設定が無い開発環境では、ブラウザ内だけで動く仮の認証（モック）を使う。

import { initializeApp } from "@firebase/app";
import {
  EmailAuthProvider,
  GoogleAuthProvider,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getAuth,
  onAuthStateChanged,
  reauthenticateWithCredential,
  reauthenticateWithPopup,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut as fbSignOut,
} from "@firebase/auth";
import { withTimeout } from "../lib/authErrors";
import type { AppEnv } from "../lib/env";

export type AuthUser = { readonly uid: string; readonly email: string | null };

/** 再認証の方法。パスワードで登録した人はパスワード、Google の人はポップアップ */
export type ReauthMethod = "password" | "google";

export interface AuthService {
  readonly kind: "firebase" | "mock";
  onChange(listener: (user: AuthUser | null) => void): () => void;
  signUpWithEmail(email: string, password: string): Promise<AuthUser>;
  signInWithEmail(email: string, password: string): Promise<AuthUser>;
  signInWithGoogle(): Promise<AuthUser>;
  signOut(): Promise<void>;
  /** API の Authorization ヘッダーに付ける ID トークン */
  idToken(): Promise<string | null>;
  /** 今のユーザーの再認証の方法（ログインしていなければ null） */
  reauthMethod(): ReauthMethod | null;
  /**
   * 元に戻せない操作（アカウント削除）の前に再認証する（#106）。
   * 成功すると ID トークンの auth_time が新しくなる。password は reauthMethod が "password" のとき使う
   */
  reauthenticate(password?: string): Promise<void>;
}

export function createFirebaseAuth(env: AppEnv): AuthService {
  if (!env.firebase) throw new Error("Firebase の設定がありません");
  const auth = getAuth(initializeApp(env.firebase));
  auth.languageCode = "ja";
  if (env.authEmulatorUrl)
    connectAuthEmulator(auth, env.authEmulatorUrl, { disableWarnings: true });
  const toUser = (u: { uid: string; email: string | null }): AuthUser => ({
    uid: u.uid,
    email: u.email,
  });
  return {
    kind: "firebase",
    onChange: (l) => onAuthStateChanged(auth, (u) => l(u ? toUser(u) : null)),
    signUpWithEmail: async (e, p) =>
      toUser((await withTimeout(createUserWithEmailAndPassword(auth, e, p))).user),
    signInWithEmail: async (e, p) =>
      toUser((await withTimeout(signInWithEmailAndPassword(auth, e, p))).user),
    signInWithGoogle: async () =>
      toUser((await signInWithPopup(auth, new GoogleAuthProvider())).user),
    signOut: () => fbSignOut(auth),
    idToken: async () => (auth.currentUser ? auth.currentUser.getIdToken() : null),
    reauthMethod: () => {
      const u = auth.currentUser;
      if (!u) return null;
      return u.providerData.some((p) => p.providerId === "password") ? "password" : "google";
    },
    reauthenticate: async (password) => {
      const u = auth.currentUser;
      if (!u) throw Object.assign(new Error("no user"), { code: "auth/no-current-user" });
      if (u.providerData.some((p) => p.providerId === "password")) {
        const credential = EmailAuthProvider.credential(u.email ?? "", password ?? "");
        await withTimeout(reauthenticateWithCredential(u, credential));
      } else {
        await reauthenticateWithPopup(u, new GoogleAuthProvider());
      }
      // 再認証の応答で SDK が ID トークンを置き換えるので、次の getIdToken は auth_time が新しい
    },
  };
}

/**
 * 仮の認証（開発・デモ用）。ページを再読み込みするとログアウトする。
 * - "fail@" で始まるメールのログインは失敗する（エラー表示の確認用）
 * - 同じメールで2回登録すると email-already-in-use になる
 */
export function createMockAuth(): AuthService {
  let user: AuthUser | null = null;
  let method: ReauthMethod | null = null;
  const accounts = new Map<string, string>();
  const listeners = new Set<(u: AuthUser | null) => void>();
  const set = (u: AuthUser | null, m: ReauthMethod | null = "password") => {
    user = u;
    method = u ? m : null;
    listeners.forEach((l) => l(u));
  };
  const fail = (code: string) => Promise.reject(Object.assign(new Error(code), { code }));
  const wait = () => new Promise((r) => setTimeout(r, 300));
  return {
    kind: "mock",
    onChange(l) {
      listeners.add(l);
      l(user);
      return () => listeners.delete(l);
    },
    async signUpWithEmail(email, password) {
      await wait();
      if (accounts.has(email)) return fail("auth/email-already-in-use");
      accounts.set(email, password);
      const u = { uid: `mock-${accounts.size}`, email };
      set(u);
      return u;
    },
    async signInWithEmail(email, password) {
      await wait();
      if (email.startsWith("fail@") || (accounts.has(email) && accounts.get(email) !== password)) {
        return fail("auth/invalid-credential");
      }
      const u = { uid: `mock-${email}`, email };
      set(u);
      return u;
    },
    async signInWithGoogle() {
      await wait();
      const u = { uid: "mock-google", email: "google-user@example.com" };
      set(u, "google");
      return u;
    },
    async signOut() {
      set(null);
    },
    async idToken() {
      return user ? `mock-token-${user.uid}` : null;
    },
    reauthMethod: () => method,
    async reauthenticate(password) {
      await wait();
      if (!user) return fail("auth/no-current-user");
      if (method !== "password") return;
      const saved = user.email === null ? undefined : accounts.get(user.email);
      if (!password || (saved !== undefined && saved !== password)) {
        return fail("auth/invalid-credential");
      }
    },
  };
}
