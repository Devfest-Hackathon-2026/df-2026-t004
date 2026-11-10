// Firebase Authentication のエラーを、画面に出す文に変える（Requirement 1.4, 1.5, 1.7）
// ログインの失敗では、メールアドレスが登録済みかどうかを明かさない。

export type AuthErrorView = {
  readonly field: "email" | "password" | "form";
  readonly message: string;
};

export const LOGIN_FAILED = "メールアドレスまたはパスワードが正しくありません";
export const AUTH_INCOMPLETE = "認証が完了しませんでした。もう一度お試しください。";
export const AUTH_TIMEOUT =
  "認証サービスに接続できませんでした。通信状態を確認して、もう一度お試しください。";

export function authErrorView(code: string, mode: "register" | "login"): AuthErrorView {
  switch (code) {
    case "auth/invalid-email":
      return {
        field: "email",
        message: "メールアドレスの形式が正しくありません（例：name@example.com）",
      };
    case "auth/email-already-in-use":
      // 登録時は理由を示す（Requirement 1.4）。ログインではこのコードは出ない
      return mode === "register"
        ? {
            field: "email",
            message: "このメールアドレスはすでに登録されています。ログインしてください。",
          }
        : { field: "form", message: LOGIN_FAILED };
    case "auth/weak-password":
      return { field: "password", message: "パスワードは8〜128文字で入れてください" };
    case "auth/user-not-found":
    case "auth/wrong-password":
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":
    case "auth/user-disabled":
      return { field: "form", message: LOGIN_FAILED };
    case "auth/too-many-requests":
      return { field: "form", message: "試行回数が多すぎます。しばらくしてからお試しください。" };
    case "auth/network-request-failed":
    case "app/timeout":
      return { field: "form", message: AUTH_TIMEOUT };
    default:
      // ポップアップを閉じた・キャンセルした、などを含む（Requirement 1.5）
      return { field: "form", message: AUTH_INCOMPLETE };
  }
}

/** 10秒を超えたら app/timeout で失敗させる（Requirement 1.5） */
export function withTimeout<T>(p: Promise<T>, ms = 10_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(Object.assign(new Error("timeout"), { code: "app/timeout" })),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export function errorCode(e: unknown): string {
  return typeof e === "object" && e !== null && "code" in e && typeof e.code === "string"
    ? e.code
    : "unknown";
}

/** 再認証（アカウント削除の前）の失敗を、画面に出す文に変える（#106） */
export function reauthErrorMessage(code: string): string {
  switch (code) {
    case "auth/wrong-password":
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":
    case "auth/missing-password":
      return "パスワードが正しくありません";
    case "auth/user-mismatch":
      return "ログイン中のアカウントと違うアカウントが選ばれました。同じアカウントを選んでください。";
    case "auth/too-many-requests":
      return "試行回数が多すぎます。しばらくしてからお試しください。";
    case "auth/network-request-failed":
    case "app/timeout":
      return AUTH_TIMEOUT;
    default:
      // ポップアップを閉じた・キャンセルした、などを含む
      return AUTH_INCOMPLETE;
  }
}
