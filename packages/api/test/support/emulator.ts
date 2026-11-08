// Firebase Emulator を使う統合テストのヘルパー
// `npm run test:integration`（firebase emulators:exec）の中で使う。
import { getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import type { IdTokenVerifier } from "../../src/index.js";

export const PROJECT_ID = "demo-hachioji-gov";

// テスト用の固定ダミー値（.gitleaks.toml で許可している）
const DUMMY_PASSWORD = "dummy-password-for-emulator";
const DUMMY_API_KEY = "fake-api-key";

function requireEnv(name: "FIRESTORE_EMULATOR_HOST" | "FIREBASE_AUTH_EMULATOR_HOST"): string {
  const value =
    name === "FIRESTORE_EMULATOR_HOST"
      ? process.env["FIRESTORE_EMULATOR_HOST"]
      : process.env["FIREBASE_AUTH_EMULATOR_HOST"];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is not set. Run via "npm run test:integration".`);
  }
  return value;
}

export function adminApp(): App {
  // 実環境に接続しないよう、Emulator の設定が無ければ失敗させる
  requireEnv("FIRESTORE_EMULATOR_HOST");
  requireEnv("FIREBASE_AUTH_EMULATOR_HOST");
  return getApps()[0] ?? initializeApp({ projectId: PROJECT_ID });
}

export function adminDb(): Firestore {
  return getFirestore(adminApp());
}

/** 本番と同じく Admin SDK で ID トークンを検証する */
export function emulatorVerifier(): IdTokenVerifier {
  const auth = getAuth(adminApp());
  return { verifyIdToken: (token) => auth.verifyIdToken(token) };
}

export type TestUser = { uid: string; idToken: string };

/** 指定した uid のテスト用ユーザーを作り、ID トークンを取得する */
export async function createTestUser(uid: string): Promise<TestUser> {
  const email = `${uid}@example.com`;
  await getAuth(adminApp()).createUser({ uid, email, password: DUMMY_PASSWORD });
  const host = requireEnv("FIREBASE_AUTH_EMULATOR_HOST");
  const res = await fetch(
    `http://${host}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${DUMMY_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: DUMMY_PASSWORD, returnSecureToken: true }),
    },
  );
  if (!res.ok) {
    throw new Error(`signInWithPassword failed: ${res.status}`);
  }
  const body = (await res.json()) as { idToken: string; localId: string };
  return { uid: body.localId, idToken: body.idToken };
}

/** Emulator の Firestore と Auth のデータを消す */
export async function resetEmulators(): Promise<void> {
  const fsHost = requireEnv("FIRESTORE_EMULATOR_HOST");
  const authHost = requireEnv("FIREBASE_AUTH_EMULATOR_HOST");
  await Promise.all([
    fetch(`http://${fsHost}/emulator/v1/projects/${PROJECT_ID}/databases/(default)/documents`, {
      method: "DELETE",
    }),
    fetch(`http://${authHost}/emulator/v1/projects/${PROJECT_ID}/accounts`, { method: "DELETE" }),
  ]);
}
