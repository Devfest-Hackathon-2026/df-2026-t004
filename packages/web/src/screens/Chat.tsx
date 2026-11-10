// AI 相談（Requirement 5.2, 5.5〜5.10, 5.12, 9.14, 10.4, 12.1〜12.3, 12.7）

import { AnimatePresence, m } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Icon, easeOut, useToast } from "../components/ui";
import {
  EMPTY_ANSWER,
  MEDICAL_DISCLAIMER,
  PII_NOTE,
  QUESTION_MAX,
  applyChatEvent,
  checkQuestion,
  interruptAnswer,
  splitCitations,
  type Answer,
} from "../lib/chat";
import { tasksFromProgram } from "../services/dashboardApi";
import { useSession } from "../state/session";

type Turn = { readonly id: number; readonly question: string; readonly answer: Answer };

const rise = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.24, ease: easeOut },
};

function AnswerBody({ a, turnId }: { a: Answer; turnId: number }) {
  return (
    <p style={{ fontSize: 15, lineHeight: 1.8, whiteSpace: "pre-wrap" }}>
      {splitCitations(a.text).map((part, i) =>
        part.kind === "text" ? (
          <span key={i}>{part.text}</span>
        ) : a.status === "verified" && a.sources.some((s) => s.n === part.n) ? (
          <a key={i} href={`#src-${turnId}-${part.n}`} className="bold">
            [{part.n}]
          </a>
        ) : (
          <span key={i} className="sub">
            [{part.n}]
          </span>
        ),
      )}
    </p>
  );
}

export function Chat() {
  const [params] = useSearchParams();
  const programId = params.get("programId") ?? undefined;
  const { chat, dashboard } = useSession();
  const { toast, show } = useToast();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState("");
  const [topicName, setTopicName] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const abort = useRef<AbortController | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const busy = turns.some((t) => t.answer.status === "waiting" || t.answer.status === "draft");
  const check = checkQuestion(q);

  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    void endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [turns]);
  useEffect(() => {
    if (!programId) return;
    void dashboard
      .getProgram(programId)
      .then((r) => setTopicName(r.status === "ok" ? r.data.name : null));
  }, [dashboard, programId]);

  const send = async (question: string, retryOf?: number) => {
    if (!checkQuestion(question).ok || busy) return;
    const id = retryOf ?? Date.now();
    setTurns((ts) =>
      retryOf
        ? ts.map((t) => (t.id === id ? { ...t, answer: EMPTY_ANSWER } : t))
        : [...ts, { id, question, answer: EMPTY_ANSWER }],
    );
    if (!retryOf) setQ("");
    const patch = (f: (a: Answer) => Answer) =>
      setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, answer: f(t.answer) } : t)));
    const ctrl = new AbortController();
    abort.current = ctrl;
    try {
      await chat.ask(
        { question, ...(programId ? { programId } : {}) },
        (e) => patch((a) => applyChatEvent(a, e)),
        ctrl.signal,
      );
      patch(interruptAnswer); // 確定のイベントが来ないまま終わった
    } catch {
      if (!ctrl.signal.aborted)
        patch((a) =>
          a.status === "waiting"
            ? {
                ...a,
                status: "error",
                errorMessage: "回答を作れませんでした。もう一度お試しください。",
              }
            : interruptAnswer(a),
        );
    }
  };

  const addToDashboard = async (pid: string) => {
    try {
      const p = await dashboard.getProgram(pid);
      await dashboard.updateApplication(pid, {
        status: "in_progress",
        tasks: p.status === "ok" ? tasksFromProgram(p.data) : [],
      });
      setAdded((s) => new Set(s).add(pid));
      show("ダッシュボードに追加しました");
    } catch {
      show("追加できませんでした。もう一度お試しください。");
    }
  };

  const last = turns[turns.length - 1];
  const suggestions = !busy
    ? last?.answer.suggestions.length
      ? last.answer.suggestions
      : turns.length === 0
        ? [
            "申請に必要なものは？",
            "子どもの医療費は助成される？",
            "休日に子どもを診てもらえる場所は？",
          ]
        : []
    : [];

  return (
    <div className="screen with-tabbar">
      <header
        style={{
          position: "sticky",
          top: 0,
          zIndex: 5,
          background: "var(--white)",
          borderBottom: "1px solid var(--line-soft)",
        }}
      >
        <div className="between" style={{ height: 52, padding: "0 16px" }}>
          <h1 style={{ fontSize: 18 }}>AI相談</h1>
          {programId && (
            <Link
              to="/chat"
              className="small"
              style={{
                padding: "4px 12px",
                border: "1px solid var(--control)",
                borderRadius: 999,
                color: "var(--ink-2)",
                textDecoration: "none",
                maxWidth: 220,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              aria-label="制度の限定を外す"
            >
              {topicName ?? "この制度"}について ✕
            </Link>
          )}
        </div>
        {/* 閉じられない注意書き（Requirement 10.4） */}
        <p role="note" className="disclaimer">
          {MEDICAL_DISCLAIMER}
        </p>
      </header>

      <main className="main" style={{ gap: 16 }}>
        {turns.length === 0 && (
          <m.div {...rise} className="stack" style={{ gap: 12, paddingTop: 16 }}>
            <p className="bold" style={{ fontSize: 16 }}>
              {programId
                ? "この制度について質問できます"
                : "子育ての医療・福祉の制度について質問できます"}
            </p>
            <p className="note sub" style={{ lineHeight: 1.6 }}>
              答えには、国・東京都・八王子市の資料の出典を付けます。
            </p>
          </m.div>
        )}

        <div aria-live="polite" className="stack" style={{ gap: 16 }}>
          <AnimatePresence initial={false}>
            {turns.map((t) => (
              <m.div key={t.id} {...rise} className="stack" style={{ gap: 16 }}>
                <div className="bubble-user">{t.question}</div>
                {t.answer.status === "fallback" ? (
                  <m.article {...rise} className="bubble-ai fallback">
                    <p className="bold" style={{ fontSize: 14 }}>
                      根拠を確認できませんでした
                    </p>
                    {t.answer.notice && (
                      <p className="note" style={{ lineHeight: 1.7 }}>
                        {t.answer.notice}
                      </p>
                    )}
                    {t.answer.sources.length > 0 && (
                      <div className="stack-4 note">
                        <span>関係しそうな資料：</span>
                        {t.answer.sources.map((s) => (
                          <a key={s.n} href={s.url} target="_blank" rel="noreferrer">
                            {s.title}
                          </a>
                        ))}
                      </div>
                    )}
                    {t.answer.contact && (
                      <p className="note">くわしくは窓口へ：{t.answer.contact}</p>
                    )}
                  </m.article>
                ) : t.answer.status === "error" ? (
                  <article
                    role="alert"
                    className="bubble-ai fallback"
                    style={{ borderColor: "var(--error)" }}
                  >
                    <p className="err">{t.answer.errorMessage}</p>
                    {t.answer.contact && <p className="note">お問い合わせ：{t.answer.contact}</p>}
                    <button
                      type="button"
                      className="btn strong self-start"
                      disabled={busy}
                      onClick={() => void send(t.question, t.id)}
                    >
                      もう一度送る
                    </button>
                  </article>
                ) : (
                  <m.article layout="position" className="bubble-ai">
                    {t.answer.status === "waiting" ? (
                      <span className="typing" role="status" aria-label="回答を作成中">
                        {[0, 1, 2].map((d) => (
                          <m.span
                            key={d}
                            animate={{ opacity: [0.3, 1, 0.3] }}
                            transition={{ duration: 1, repeat: Infinity, delay: d * 0.15 }}
                          />
                        ))}
                      </span>
                    ) : (
                      <>
                        {t.answer.status === "draft" && (
                          <span className="small sub" role="status">
                            根拠を確認中…
                          </span>
                        )}
                        <AnswerBody a={t.answer} turnId={t.id} />
                        {t.answer.status === "interrupted" && (
                          <div role="alert" className="stack">
                            <p className="err">
                              回答が途中で止まりました。表示されている内容は不完全です。
                            </p>
                            <button
                              type="button"
                              className="btn strong self-start"
                              disabled={busy}
                              onClick={() => void send(t.question, t.id)}
                            >
                              もう一度送る
                            </button>
                          </div>
                        )}
                        {t.answer.status === "verified" && t.answer.sources.length > 0 && (
                          <m.div {...rise} className="sources">
                            <span className="small bold" style={{ color: "var(--ink-2)" }}>
                              出典
                            </span>
                            {t.answer.sources.map((s) => (
                              <a
                                key={s.n}
                                id={`src-${t.id}-${s.n}`}
                                href={s.url}
                                target="_blank"
                                rel="noreferrer"
                                className="note"
                              >
                                [{s.n}] {s.title}
                                {s.fetchedAt && ` ・ 取得日 ${s.fetchedAt}`}
                              </a>
                            ))}
                          </m.div>
                        )}
                        {t.answer.status === "verified" && (
                          <p className="small sub">
                            利用できるかどうかの最終的な確認は、各制度の窓口で行ってください。
                          </p>
                        )}
                        {t.answer.status === "verified" && t.answer.proposal && (
                          <button
                            type="button"
                            className="btn outline self-start"
                            disabled={added.has(t.answer.proposal.programId)}
                            onClick={() => void addToDashboard(t.answer.proposal!.programId)}
                          >
                            {added.has(t.answer.proposal.programId)
                              ? "追加済み"
                              : `＋ ${t.answer.proposal.programName}をダッシュボードに追加`}
                          </button>
                        )}
                      </>
                    )}
                  </m.article>
                )}
              </m.div>
            ))}
          </AnimatePresence>
        </div>

        {suggestions.length > 0 && (
          <div role="group" aria-label="次の質問の候補" className="stack">
            {suggestions.map((s, i) => (
              <m.button
                key={`${turns.length}-${s}`}
                type="button"
                className="chip self-start"
                style={{ fontSize: 13 }}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.24, delay: 0.08 + i * 0.04 }}
                onClick={() => void send(s)}
              >
                {s}
              </m.button>
            ))}
          </div>
        )}
        <div ref={endRef} />
      </main>

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send(q);
        }}
      >
        {/* 閉じられない注意書き（Requirement 9.14） */}
        <p role="note" className="small" style={{ color: "var(--warn-ink)" }}>
          {PII_NOTE}
        </p>
        <div className="row" style={{ alignItems: "flex-end" }}>
          <label htmlFor="q" className="sr-only">
            質問
          </label>
          <textarea
            id="q"
            className="input"
            rows={2}
            placeholder="質問を入力"
            value={q}
            aria-invalid={!!check.message}
            aria-describedby="q-count"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send(q);
            }}
            style={{ flex: 1, fontSize: 15 }}
          />
          <button
            type="submit"
            className="btn primary"
            aria-label="送信"
            disabled={!check.ok || busy}
            style={{ width: 48, height: 48, padding: 0, flex: "none" }}
          >
            <Icon name="send" />
          </button>
        </div>
        <span
          id="q-count"
          className="small"
          style={{ alignSelf: "flex-end", color: check.message ? "var(--error)" : "var(--sub)" }}
        >
          {check.message ?? `${check.count} / ${QUESTION_MAX}`}
        </span>
      </form>
      {toast}
    </div>
  );
}
