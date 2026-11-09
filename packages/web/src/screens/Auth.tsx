// 登録・ログイン（Requirement 1.1〜1.7, 9.11）

import {
  EMAIL_FORMAT_MESSAGE,
  PASSWORD_LENGTH_MESSAGE,
  validateEmail,
  validatePassword,
} from "@hachioji-gov/shared";
import { m } from "motion/react";
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { authErrorView, errorCode, type AuthErrorView } from "../lib/authErrors";
import { LEGAL_VERSION } from "../legal/content";
import { useSession } from "../state/session";

type Mode = "register" | "login";

export function Auth() {
  const { auth, api } = useSession();
  const [mode, setMode] = useState<Mode>("register");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [terms, setTerms] = useState(false);
  const [policy, setPolicy] = useState(false);
  const [touched, setTouched] = useState({ email: false, password: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AuthErrorView | null>(null);

  const emailErr =
    (touched.email && !validateEmail(email) ? EMAIL_FORMAT_MESSAGE : null) ??
    (error?.field === "email" ? error.message : null);
  const pwInvalid = mode === "register" && touched.password && !validatePassword(password);
  const pwErr =
    (pwInvalid ? PASSWORD_LENGTH_MESSAGE : null) ??
    (error?.field === "password" ? error.message : null);
  const formErr = error?.field === "form" ? error.message : null;
  const agreed = terms && policy;
  const canSubmit =
    mode === "register"
      ? validateEmail(email) && validatePassword(password) && agreed
      : validateEmail(email) && password.length > 0;

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      // 画面の切り替えはログイン状態の変化で行う（App の振り分け）
    } catch (e) {
      setError(authErrorView(errorCode(e), mode));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched({ email: true, password: true });
    if (!canSubmit || busy) return;
    void run(async () => {
      if (mode === "register") {
        await auth.signUpWithEmail(email, password);
        await api.recordTermsConsent(LEGAL_VERSION);
      } else {
        await auth.signInWithEmail(email, password);
      }
    });
  };

  const google = () => {
    if (mode === "register" && !agreed) {
      setError({ field: "form", message: "利用規約とプライバシーポリシーに同意してください" });
      return;
    }
    void run(async () => {
      await auth.signInWithGoogle();
      if (mode === "register") await api.recordTermsConsent(LEGAL_VERSION);
    });
  };

  const consents = (
    <div className="stack-4" role="group" aria-label="同意">
      <label className="check-row">
        <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
        <span>
          <Link to="/terms">利用規約</Link>に同意する
        </span>
      </label>
      <label className="check-row">
        <input type="checkbox" checked={policy} onChange={(e) => setPolicy(e.target.checked)} />
        <span>
          <Link to="/privacy">プライバシーポリシー</Link>に同意する
        </span>
      </label>
    </div>
  );

  return (
    <div className="screen white">
      <main className="main roomy" style={{ paddingTop: 48 }}>
        <div className="stack" style={{ alignItems: "center", gap: 12 }}>
          <img
            src="/icons/icon-192.png"
            alt=""
            width={64}
            height={64}
            style={{ borderRadius: 16 }}
          />
          <h1 className="title-xl">hachioji-gov</h1>
          <p className="lead" style={{ textAlign: "center" }}>
            八王子市の子育て世帯むけ
            <br />
            医療・福祉の制度ナビ
          </p>
        </div>

        <div
          role="tablist"
          aria-label="登録とログインの切り替え"
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 8,
            padding: 4,
            background: "var(--fill)",
            borderRadius: 12,
          }}
        >
          {(["register", "login"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={mode === k}
              onClick={() => {
                setMode(k);
                setError(null);
              }}
              style={{
                position: "relative",
                height: 44,
                border: 0,
                borderRadius: 8,
                background: "transparent",
                fontSize: 15,
                fontWeight: mode === k ? 700 : 400,
                color: mode === k ? "var(--ink)" : "var(--sub)",
              }}
            >
              {mode === k && (
                <m.span
                  layoutId="auth-tab"
                  style={{
                    position: "absolute",
                    inset: 0,
                    background: "var(--white)",
                    border: "1px solid var(--ink)",
                    borderRadius: 8,
                  }}
                  transition={{ type: "spring", stiffness: 500, damping: 35, mass: 0.8 }}
                />
              )}
              <span style={{ position: "relative" }}>
                {k === "register" ? "新規登録" : "ログイン"}
              </span>
            </button>
          ))}
        </div>

        {mode === "register" && consents}

        <button
          type="button"
          className="btn md block"
          style={{ fontWeight: 500 }}
          onClick={google}
          disabled={busy}
        >
          <span
            aria-hidden="true"
            style={{
              width: 20,
              height: 20,
              borderRadius: "50%",
              border: "1px solid var(--control)",
              fontSize: 11,
              display: "grid",
              placeItems: "center",
            }}
          >
            G
          </span>
          Googleで{mode === "register" ? "登録" : "ログイン"}
        </button>

        <div aria-hidden="true" className="row note sub" style={{ gap: 12 }}>
          <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
          または
          <div style={{ flex: 1, height: 1, background: "var(--line)" }} />
        </div>

        <form className="stack" style={{ gap: 16 }} onSubmit={submit} noValidate>
          <div className="field">
            <label htmlFor="email">メールアドレス</label>
            <input
              id="email"
              className="input"
              type="email"
              autoComplete="email"
              inputMode="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (error?.field === "email") setError(null);
              }}
              onBlur={() => setTouched((t) => ({ ...t, email: true }))}
              aria-invalid={!!emailErr}
              aria-describedby={emailErr ? "email-err" : undefined}
            />
            {emailErr && (
              <p id="email-err" className="err">
                {emailErr}
              </p>
            )}
          </div>
          <div className="field">
            <label htmlFor="pw">パスワード</label>
            <input
              id="pw"
              className="input"
              type="password"
              autoComplete={mode === "register" ? "new-password" : "current-password"}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (error?.field === "password") setError(null);
              }}
              onBlur={() => setTouched((t) => ({ ...t, password: true }))}
              aria-invalid={!!pwErr}
              aria-describedby="pw-hint"
            />
            <p id="pw-hint" className={pwErr ? "err" : "hint"}>
              {pwErr ?? "8〜128文字"}
            </p>
          </div>

          {formErr && (
            <p role="alert" className="err">
              {formErr}
            </p>
          )}

          <div className="stack">
            <button type="submit" className="btn lg primary block" disabled={!canSubmit || busy}>
              {busy ? "確認しています…" : mode === "register" ? "登録する" : "ログイン"}
            </button>
            {mode === "register" && !agreed && (
              <p className="small sub" style={{ textAlign: "center" }}>
                利用規約とプライバシーポリシーの両方に同意すると登録できます
              </p>
            )}
          </div>
        </form>
      </main>
    </div>
  );
}
