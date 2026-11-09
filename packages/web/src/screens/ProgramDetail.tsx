// 制度詳細（Requirement 4.6〜4.8, 10.5, 10.6, 12.4〜12.6）

import {
  NEEDS_CHECK_LABEL,
  POSSIBLE_ELIGIBILITY_LABEL,
  toProgramView,
  type Application,
  type Program,
} from "@hachioji-gov/shared";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Header, useToast } from "../components/ui";
import type { CachedFetchResult } from "../lib/api";
import { UNCACHED_OFFLINE_MESSAGE, staleMessage } from "../lib/offline";
import { tasksFromProgram } from "../services/dashboardApi";
import { useSession } from "../state/session";

export function ProgramDetail() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { dashboard } = useSession();
  const { toast, show } = useToast();
  const [result, setResult] = useState<CachedFetchResult<Program> | null>(null);
  const [app, setApp] = useState<Application | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    setResult(null);
    void dashboard.getProgram(id).then((r) => alive && setResult(r));
    void dashboard.getApplication(id).then(
      (a) => alive && setApp(a),
      () => alive && setApp(null),
    );
    return () => {
      alive = false;
    };
  }, [dashboard, id, attempt]);

  const update = async (
    next: Application["status"],
    tasks: Application["tasks"],
    message?: string,
  ) => {
    setSaving(true);
    try {
      setApp(await dashboard.updateApplication(id, { status: next, tasks }));
      if (message) show(message);
    } catch {
      show("保存できませんでした。もう一度お試しください。");
    } finally {
      setSaving(false);
    }
  };

  const body = () => {
    if (result === null)
      return (
        <p className="note sub" role="status">
          読み込んでいます…
        </p>
      );
    if (result.status === "offline-uncached") {
      return (
        <section role="alert" className="card dashed">
          <p style={{ lineHeight: 1.6 }}>{UNCACHED_OFFLINE_MESSAGE}</p>
          <button
            type="button"
            className="btn strong self-start"
            onClick={() => setAttempt((n) => n + 1)}
          >
            再試行
          </button>
        </section>
      );
    }
    if (result.status === "not-found") return <p role="alert">この制度は見つかりませんでした。</p>;
    if (result.status === "error") {
      return (
        <section role="alert" className="card alert">
          <span className="note" style={{ color: "var(--error)" }}>
            制度を読み込めませんでした
          </span>
          <button type="button" className="btn strong" onClick={() => setAttempt((n) => n + 1)}>
            再試行
          </button>
        </section>
      );
    }
    const p = result.data;
    const v = toProgramView(p);
    const inProgress = app?.status === "in_progress";
    const tasks = app?.tasks.length ? app.tasks : tasksFromProgram(p);
    const done = tasks.filter((t) => t.done).length;
    const steps = (p.procedure ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    const unknownBand = p.ageBands.length === 0 || p.ageBands.includes("unknown");

    return (
      <>
        {result.stale && (
          <p role="status" className="notice gray">
            {staleMessage(result.cachedAt)}
          </p>
        )}
        <div className="stack">
          <div className="badges">
            <span className="badge">{v.levelLabel}</span>
            <span className="badge maybe">{POSSIBLE_ELIGIBILITY_LABEL}</span>
            {unknownBand && <span className="badge check">{NEEDS_CHECK_LABEL}</span>}
          </div>
          <h1 className="title-xl">{v.name}</h1>
          <p className="small sub">確定ではありません。最終的な判断は窓口で行われます。</p>
          {v.deadline && (
            <p className="note">
              締切 <span className="bold">{v.deadline}</span>
            </p>
          )}
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <button
            type="button"
            className="btn md primary"
            onClick={() => nav(`/chat?programId=${encodeURIComponent(p.id)}`)}
          >
            AIに聞く
          </button>
          {app?.status === "done" ? (
            <button
              type="button"
              className="btn md outline"
              disabled={saving}
              onClick={() => void update("in_progress", tasks, "進行中に戻しました")}
            >
              完了済み（戻す）
            </button>
          ) : inProgress ? (
            <button
              type="button"
              className="btn md outline"
              disabled={saving}
              onClick={() => void update("done", tasks, "申請を完了にしました")}
            >
              完了にする
            </button>
          ) : (
            <button
              type="button"
              className="btn md outline"
              style={{ fontWeight: 700 }}
              disabled={saving}
              onClick={() =>
                void update("in_progress", tasks, "ホームの「進行中の申請」に追加しました")
              }
            >
              申請を進める
            </button>
          )}
        </div>

        <section className="section" aria-labelledby="h-point">
          <h2 id="h-point">要点</h2>
          <ul style={{ paddingLeft: 20, fontSize: 14, lineHeight: 1.8 }}>
            <li>対象：{v.eligibility ?? v.targetLabel}</li>
            {v.summary && <li>内容：{v.summary}</li>}
            <li>締切：{v.deadline ?? "資料から読み取れません"}</li>
          </ul>
        </section>

        {steps.length > 0 && (
          <section className="section" aria-labelledby="h-flow">
            <h2 id="h-flow">手続きの流れ</h2>
            <ol
              style={{
                padding: 0,
                listStyle: "none",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {steps.map((s, i) => (
                <li key={s} className="row" style={{ gap: 12, fontSize: 14 }}>
                  <span
                    aria-hidden="true"
                    style={{
                      flex: "none",
                      width: 24,
                      height: 24,
                      borderRadius: "50%",
                      border: "1px solid var(--ink)",
                      fontSize: 12,
                      display: "grid",
                      placeItems: "center",
                    }}
                  >
                    {i + 1}
                  </span>
                  {s}
                </li>
              ))}
            </ol>
          </section>
        )}

        {tasks.length > 0 && (
          <section className="section" aria-labelledby="h-check" style={{ gap: 4 }}>
            <h2 id="h-check" style={{ marginBottom: 4 }}>
              必要なもの{" "}
              <span className="note sub" style={{ fontWeight: 400 }}>
                {done} / {tasks.length}
              </span>
            </h2>
            {tasks.map((t) => (
              <label key={t.id} className="check-row">
                <input
                  type="checkbox"
                  checked={t.done}
                  disabled={saving}
                  onChange={() =>
                    void update(
                      app?.status === "done" ? "done" : "in_progress",
                      tasks.map((x) => (x.id === t.id ? { ...x, done: !x.done } : x)),
                      inProgress || app?.status === "done"
                        ? undefined
                        : "進行中の申請に追加しました",
                    )
                  }
                />
                {t.label}
              </label>
            ))}
          </section>
        )}

        {v.contact && (
          <section className="card" aria-labelledby="h-contact" style={{ gap: 4 }}>
            <h2 id="h-contact" className="h2">
              問い合わせ窓口
            </h2>
            <span style={{ fontSize: 14 }}>{v.contact.name}</span>
            {v.contact.phone && (
              <a
                href={`tel:${v.contact.phone}`}
                style={{ fontSize: 14, minHeight: 44, display: "flex", alignItems: "center" }}
              >
                {v.contact.phone} に電話する
              </a>
            )}
          </section>
        )}

        <section className="section" aria-labelledby="h-src">
          <h2 id="h-src">出典</h2>
          {v.source.verified ? (
            <p style={{ fontSize: 13, lineHeight: 1.7 }}>
              <a href={v.source.url!} target="_blank" rel="noreferrer">
                {v.source.name ?? v.source.url}
              </a>
              <br />
              <span className="sub">取得日 {v.source.fetchedAt}</span>
            </p>
          ) : (
            <p className="badge check self-start">{v.source.label}</p>
          )}
          <p className="notice">{v.notice}</p>
        </section>
      </>
    );
  };

  return (
    <div className="screen white with-tabbar">
      <Header back title="制度の詳細" />
      <main className="main" style={{ paddingBottom: 24 }}>
        {body()}
      </main>
      {toast}
    </div>
  );
}
