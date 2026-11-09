// ダッシュボード（ホーム）と、さがす（Requirement 4.1〜4.5, 4.8〜4.11）

import {
  CATEGORY_LABELS,
  MAYBE_CLOSED_LABEL,
  NEEDS_CHECK_LABEL,
  PROGRAM_CATEGORIES,
  applicationProgress,
  toProgramCard,
  todayJst,
  toSlashDate,
  upcomingDeadlines,
  type Application,
  type ProgramCategory,
  type ProgramMatch,
} from "@hachioji-gov/shared";
import { AnimatePresence, m } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { InstallHint } from "../components/pwa";
import { Header, Icon, easeOut } from "../components/ui";
import type { Dashboard as DashboardData } from "../services/dashboardApi";
import { toMatchHousehold } from "../state/household";
import { useSession } from "../state/session";

const layout = { type: "spring", stiffness: 400, damping: 32 } as const;

export function ProgramCardView({ match }: { match: ProgramMatch }) {
  const card = toProgramCard(match.program, match);
  return (
    <Link to={`/programs/${card.id}`} className="card">
      <div className="badges">
        <span className="badge">{card.levelLabel}</span>
        <span className="badge maybe">{card.eligibilityLabel}</span>
        {card.needsCheck && <span className="badge check">{NEEDS_CHECK_LABEL}</span>}
      </div>
      <span style={{ fontSize: 16, fontWeight: 700 }}>{card.name}</span>
      {card.summary && <span style={{ fontSize: 14, lineHeight: 1.6 }}>{card.summary}</span>}
      {card.maybeClosed && <p className="notice">{MAYBE_CLOSED_LABEL}</p>}
      <span className="small sub">
        対象：{card.targetLabel} ・ 出典：{card.sourceName}
        {card.updatedAt && ` ・ 更新 ${card.updatedAt}`}
      </span>
    </Link>
  );
}

function SectionError({ label, onRetry }: { label: string; onRetry: () => void }) {
  return (
    <div role="alert" className="card alert">
      <span className="note" style={{ color: "var(--error)" }}>
        {label}を読み込めませんでした
      </span>
      <button type="button" className="btn strong" style={{ flex: "none" }} onClick={onRetry}>
        再試行
      </button>
    </div>
  );
}

function useDashboard(category: ProgramCategory | null) {
  const { dashboard, household } = useSession();
  const [data, setData] = useState<DashboardData | null>(null);
  const today = todayJst(new Date());
  const load = useCallback(async () => {
    if (!household) return;
    setData(await dashboard.getDashboard(toMatchHousehold(household, today), today, category));
  }, [dashboard, household, today, category]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, reload: load, setData };
}

export function Home() {
  const { household, dashboard } = useSession();
  const [category, setCategory] = useState<ProgramCategory | null>(null);
  const { data, setData } = useDashboard(category);
  const today = todayJst(new Date());

  // セクションごとに再読み込みする（ほかのセクションは表示したまま）
  const retry = async (key: "programs" | "applications") => {
    if (!household || !data) return;
    const fresh = await dashboard.getDashboard(toMatchHousehold(household, today), today, category);
    setData({ ...data, [key]: fresh[key] });
  };

  const meta = household
    ? [
        household.municipalityCode === "13201" ? "八王子市" : "国の制度のみ",
        ...household.children.map((c) => `${c.ageYears}歳`),
      ].join(" ・ ")
    : undefined;
  const apps: Application[] = data?.applications.ok
    ? upcomingDeadlines(data.applications.data)
    : [];
  const programName = (id: string) =>
    (data?.programs.ok
      ? data.programs.data.find((x) => x.program.id === id)?.program.name
      : undefined) ?? id;

  return (
    <div className="screen with-tabbar">
      <Header title="ホーム" meta={meta} />
      <main className="main">
        <InstallHint />

        <section className="section" aria-labelledby="h-progress">
          <h2 id="h-progress">進行中の申請</h2>
          {!data ? (
            <p className="note sub" role="status">
              読み込んでいます…
            </p>
          ) : !data.applications.ok ? (
            <SectionError label="進行中の申請" onRetry={() => void retry("applications")} />
          ) : apps.length === 0 ? (
            <p className="note sub">
              まだありません。制度の詳細で「申請を進める」を押すと、ここに出ます。
            </p>
          ) : (
            apps.map((a) => {
              const { done, total } = applicationProgress(a);
              const left = a.tasks.filter((t) => !t.done).map((t) => t.label);
              return (
                <Link key={a.programId} to={`/programs/${a.programId}`} className="card">
                  <div className="between" style={{ alignItems: "baseline" }}>
                    <span style={{ fontSize: 15, fontWeight: 700 }}>
                      {programName(a.programId)}
                    </span>
                    {a.deadline && (
                      <span
                        className="note bold"
                        style={{ color: "var(--deadline)", flex: "none" }}
                      >
                        締切 {toSlashDate(a.deadline).slice(5)}
                      </span>
                    )}
                  </div>
                  <div
                    className="track"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={total}
                    aria-valuenow={done}
                    aria-label="完了したタスク"
                  >
                    <m.div
                      className="fill"
                      initial={{ scaleX: 0 }}
                      animate={{ scaleX: total ? done / total : 0 }}
                      transition={{ duration: 0.28, delay: 0.12, ease: easeOut }}
                    />
                  </div>
                  <span className="note sub">
                    {done} / {total} タスク完了{left.length > 0 && ` ・ 残り：${left.join("、")}`}
                  </span>
                </Link>
              );
            })
          )}
        </section>

        <section className="section" aria-labelledby="h-deadline">
          <h2 id="h-deadline">締切（近い順）</h2>
          {!data ? null : !data.applications.ok ? (
            <SectionError label="締切" onRetry={() => void retry("applications")} />
          ) : apps.filter((a) => a.deadline).length === 0 ? (
            <p className="note sub">締切のある進行中の申請はありません。</p>
          ) : (
            <ul className="list">
              {apps
                .filter((a) => a.deadline)
                .map((a) => (
                  <li key={a.programId}>
                    <Link
                      to={`/programs/${a.programId}`}
                      style={{ color: "var(--ink)", textDecoration: "none" }}
                    >
                      {programName(a.programId)}
                    </Link>
                    <span className={`bold${a.deadline! < today ? " err" : ""}`}>
                      {toSlashDate(a.deadline!)}
                    </span>
                  </li>
                ))}
            </ul>
          )}
        </section>

        <section className="section" aria-labelledby="h-programs">
          <h2 id="h-programs">あなたの世帯が対象の可能性がある制度</h2>
          <div role="group" aria-label="カテゴリで絞り込む" className="chips scroll">
            {([null, ...PROGRAM_CATEGORIES] as const).map((c) => (
              <button
                key={c ?? "all"}
                type="button"
                className="chip"
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
                style={{ fontSize: 13 }}
              >
                {c ? CATEGORY_LABELS[c] : "すべて"}
              </button>
            ))}
          </div>
          {!data ? (
            <p className="note sub" role="status">
              読み込んでいます…
            </p>
          ) : !data.programs.ok ? (
            <SectionError label="制度" onRetry={() => void retry("programs")} />
          ) : (
            <m.div layout transition={layout} className="stack">
              <AnimatePresence mode="popLayout" initial={false}>
                {data.programs.data.map((match) => (
                  <m.div
                    key={match.program.id}
                    layout
                    transition={layout}
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12 } }}
                    style={{ display: "flex", flexDirection: "column" }}
                  >
                    <ProgramCardView match={match} />
                  </m.div>
                ))}
                {data.programs.data.length === 0 && (
                  <m.div
                    key="empty"
                    layout
                    className="card"
                    style={{ alignItems: "center", textAlign: "center", gap: 12 }}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                  >
                    <span className="bold" style={{ fontSize: 15 }}>
                      {category
                        ? `「${CATEGORY_LABELS[category]}」に合う制度は見つかりませんでした`
                        : "あなたの世帯に合う制度は見つかりませんでした"}
                    </span>
                    {category && (
                      <button
                        type="button"
                        className="btn strong"
                        onClick={() => setCategory(null)}
                      >
                        絞り込みを解除
                      </button>
                    )}
                  </m.div>
                )}
              </AnimatePresence>
            </m.div>
          )}
        </section>
      </main>
    </div>
  );
}

export function Search() {
  const [category, setCategory] = useState<ProgramCategory | null>(null);
  const all = useDashboard(null).data;
  const { data, reload } = useDashboard(category);
  const count = (c: ProgramCategory) =>
    all?.programs.ok ? all.programs.data.filter((x) => x.program.category === c).length : null;
  return (
    <div className="screen with-tabbar">
      <Header title="さがす" />
      <main className="main">
        <section className="section" aria-labelledby="h-cat">
          <h2 id="h-cat">カテゴリから探す</h2>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {PROGRAM_CATEGORIES.map((c) => {
              const on = category === c;
              const n = count(c);
              return (
                <button
                  key={c}
                  type="button"
                  className="card"
                  aria-pressed={on}
                  onClick={() => setCategory(on ? null : c)}
                  style={{
                    minHeight: 72,
                    gap: 4,
                    alignItems: "flex-start",
                    justifyContent: "center",
                    fontSize: 15,
                    fontWeight: on ? 700 : 400,
                    border: on ? "2px solid var(--ink)" : undefined,
                    padding: on ? 15 : 16,
                    textAlign: "left",
                  }}
                >
                  {on && "✓ "}
                  {CATEGORY_LABELS[c]}
                  <span className="small sub" style={{ fontWeight: 400 }}>
                    {n === null ? "…" : `${n}件`}
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <AnimatePresence mode="wait">
          {category && data && (
            <m.section
              key={category}
              className="section"
              aria-live="polite"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8, transition: { duration: 0.12 } }}
              transition={{ duration: 0.24, ease: easeOut }}
            >
              {!data.programs.ok ? (
                <SectionError label="制度" onRetry={() => void reload()} />
              ) : data.programs.data.length > 0 ? (
                <>
                  <h2>
                    {CATEGORY_LABELS[category]}（{data.programs.data.length}件）
                  </h2>
                  {data.programs.data.map((x) => (
                    <ProgramCardView key={x.program.id} match={x} />
                  ))}
                </>
              ) : (
                <div
                  className="card"
                  style={{
                    alignItems: "center",
                    textAlign: "center",
                    gap: 12,
                    padding: "24px 16px",
                  }}
                >
                  <h2 style={{ fontSize: 15 }}>
                    「{CATEGORY_LABELS[category]}」に合う制度は見つかりませんでした
                  </h2>
                  <button type="button" className="btn strong" onClick={() => setCategory(null)}>
                    絞り込みを解除
                  </button>
                </div>
              )}
            </m.section>
          )}
        </AnimatePresence>

        <Link
          to="/chat"
          className="card"
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <span className="stack-4">
            <span className="bold" style={{ fontSize: 15 }}>
              何を調べればいいか分からないとき
            </span>
            <span className="note sub">AIに相談する</span>
          </span>
          <Icon name="next" size={20} />
        </Link>
      </main>
    </div>
  );
}
