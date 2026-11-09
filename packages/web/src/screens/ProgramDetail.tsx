// 制度詳細の土台。オフライン時の表示（Requirement 12.5, 12.6）をここで受け持つ。
// 中身（要点・手続き・チェックリスト・出典）は T23 で実装する。

import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Header } from "../components/ui";
import { fetchCached, type CachedFetchResult } from "../lib/api";
import { UNCACHED_OFFLINE_MESSAGE, staleMessage } from "../lib/offline";

type ProgramPayload = { name?: string };

export function ProgramDetail() {
  const { id = "" } = useParams();
  const [result, setResult] = useState<CachedFetchResult<ProgramPayload> | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setResult(null);
    void fetchCached<ProgramPayload>(`/programs/${encodeURIComponent(id)}`).then((r) => {
      if (alive) setResult(r);
    });
    return () => {
      alive = false;
    };
  }, [id, attempt]);

  return (
    <div className="screen white with-tabbar">
      <Header back title="制度の詳細" />
      <main className="main">
        {result === null && (
          <p className="note sub" role="status">
            読み込んでいます…
          </p>
        )}
        {result?.status === "ok" && (
          <>
            {result.stale && (
              <p role="status" className="notice gray">
                {staleMessage(result.cachedAt)}
              </p>
            )}
            <h1 className="title-xl">{result.data.name ?? "[制度名]"}</h1>
          </>
        )}
        {result?.status === "offline-uncached" && (
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
        )}
        {result?.status === "not-found" && <p role="alert">この制度は見つかりませんでした。</p>}
        {result?.status === "error" && (
          <section role="alert" className="card alert">
            <span className="note" style={{ color: "var(--error)" }}>
              制度を読み込めませんでした
            </span>
            <button type="button" className="btn strong" onClick={() => setAttempt((n) => n + 1)}>
              再試行
            </button>
          </section>
        )}
      </main>
    </div>
  );
}
