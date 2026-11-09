import { InstallHint } from "../components/pwa";
import { Link } from "react-router-dom";
import { Header } from "../components/ui";
import { useSession } from "../state/session";

/** 画面の土台だけを置いておく仮の画面（中身は各タスクで実装する） */
export function Placeholder({
  title,
  task,
  withInstallHint,
}: {
  title: string;
  task: string;
  withInstallHint?: boolean;
}) {
  return (
    <div className="screen with-tabbar">
      <Header title={title} />
      <main className="main">
        {withInstallHint && <InstallHint />}
        <section className="card dashed" aria-label="準備中">
          <p className="bold">この画面は準備中です</p>
          <p className="note sub">{task} で実装します。</p>
        </section>
      </main>
    </div>
  );
}

/** マイホームの仮の画面。世帯情報の表示・ログアウト・規約へのリンクだけを置く（中身は T25） */
export function MyHomePlaceholder() {
  const { auth, household } = useSession();
  return (
    <div className="screen with-tabbar">
      <Header title="マイホーム" />
      <main className="main">
        {household && (
          <section className="card" aria-labelledby="h-house">
            <h2 id="h-house" className="h2">
              世帯の情報
            </h2>
            <dl
              style={{
                margin: 0,
                display: "grid",
                gridTemplateColumns: "96px 1fr",
                rowGap: 8,
                fontSize: 14,
              }}
            >
              <dt className="sub">住所</dt>
              <dd style={{ margin: 0 }}>
                {household.prefecture} {household.city} {household.town}
              </dd>
              <dt className="sub">子ども</dt>
              <dd style={{ margin: 0 }}>
                {household.children.length}人
                {household.children.length > 0 &&
                  `（${household.children.map((c) => (c.ageYears === 0 && c.ageMonths !== undefined ? `0歳${c.ageMonths}か月` : `${c.ageYears}歳`)).join("・")}）`}
              </dd>
              <dt className="sub">健康の情報</dt>
              <dd style={{ margin: 0 }}>
                {household.sensitiveConsent ? "同意して保存済み" : "保存していません"}
              </dd>
            </dl>
          </section>
        )}
        <nav aria-label="プライバシーとアカウント" className="menu">
          <Link to="/terms">利用規約</Link>
          <Link to="/privacy">プライバシーポリシー</Link>
          <button type="button" onClick={() => void auth.signOut()}>
            ログアウト
          </button>
        </nav>
        <p className="note sub">ほかのメニューは T25（#26）で実装します。</p>
      </main>
    </div>
  );
}
