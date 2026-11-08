import { InstallHint } from "../components/pwa";
import { Header } from "../components/ui";

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
