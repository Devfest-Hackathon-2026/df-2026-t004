// マイホーム・医療費・同意撤回・アカウント削除（Requirement 6.1〜6.7, 8.3〜8.5, 9.3, 9.4）

import {
  GUARDIAN_SUBJECT_ID,
  todayJst,
  toSlashDate,
  type ExpenseRecord,
  type FieldError,
} from "@hachioji-gov/shared";
import { AnimatePresence, m } from "motion/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Dialog, Header, Icon, easeOut, useToast } from "../components/ui";
import type { ExpenseOverview } from "../services/accountApi";
import type { Household } from "../services/householdApi";
import { toMatchHousehold } from "../state/household";
import { useSession } from "../state/session";

const yen = (n: number) => `¥${n.toLocaleString("ja-JP")}`;
const spring = { type: "spring", stiffness: 500, damping: 35, mass: 0.8 } as const;

/** 対象者の選択肢（登録済みの子どもと保護者） */
export function subjectsOf(h: Household | null | undefined): Array<{ id: string; label: string }> {
  const kids = (h?.children ?? []).map((c, i) => ({
    id: c.id,
    label: `${i + 1}人目（${c.ageYears === 0 && c.ageMonths !== undefined ? `0歳${c.ageMonths}か月` : `${c.ageYears}歳`}）`,
  }));
  return [...kids, { id: GUARDIAN_SUBJECT_ID, label: "保護者" }];
}

export function MyHome() {
  const nav = useNavigate();
  const { auth, account, household, setHousehold } = useSession();
  const { toast, show } = useToast();
  const [withdraw, setWithdraw] = useState<"closed" | "confirm" | "busy" | "failed">("closed");
  const [del, setDel] = useState<"closed" | "confirm" | "busy" | "failed">("closed");

  const doWithdraw = async () => {
    setWithdraw("busy");
    try {
      await account.withdrawSensitiveConsent();
      if (household) setHousehold({ ...household, sensitiveConsent: false, sensitive: null });
      setWithdraw("closed");
      show("同意を取り消し、健康に関する情報を削除しました");
    } catch {
      // 削除に失敗した状態では、要配慮情報を読み出さない（サーバー側でロックされる）
      if (household) setHousehold({ ...household, sensitive: null });
      setWithdraw("failed");
    }
  };

  const doDelete = async () => {
    setDel("busy");
    try {
      await account.deleteAccount();
      nav("/deleted", { replace: true });
      // 画面を移してからサインアウトする（先に消すと未認証の振り分けで "/" に戻る）
      setTimeout(() => void auth.signOut(), 0);
    } catch {
      setDel("failed"); // サインイン状態を維持して再試行させる（Requirement 8.5）
    }
  };

  const sensitive = household?.sensitive;
  const situations = sensitive?.situationChips.length ? sensitive.situationChips.join("、") : null;

  return (
    <div className="screen with-tabbar">
      <Header title="マイホーム" />
      <main className="main">
        {household && (
          <section className="card" aria-labelledby="h-house">
            <div className="between">
              <h2 id="h-house" className="h2">
                世帯の情報
              </h2>
              <Link to="/my/household" className="btn ghost">
                編集
              </Link>
            </div>
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
                  `（${subjectsOf(household)
                    .slice(0, -1)
                    .map((s) => s.label.replace(/^\d+人目/, "").replace(/[（）]/g, ""))
                    .join("・")}）`}
              </dd>
              <dt className="sub">出産予定日</dt>
              <dd style={{ margin: 0 }} className={sensitive?.pregnancy ? "" : "sub"}>
                {sensitive?.pregnancy ? toSlashDate(sensitive.pregnancy.dueDate) : "未入力"}
              </dd>
              <dt className="sub">状況</dt>
              <dd style={{ margin: 0 }} className={situations ? "" : "sub"}>
                {situations ?? "未入力"}
              </dd>
            </dl>
          </section>
        )}

        {withdraw === "failed" && (
          <section
            role="alert"
            className="card alert"
            style={{ flexDirection: "column", alignItems: "stretch" }}
          >
            <p className="err">
              健康に関する情報の削除が完了しませんでした。削除が終わるまで、この情報は使いません。
            </p>
            <button
              type="button"
              className="btn strong self-start"
              onClick={() => void doWithdraw()}
            >
              もう一度削除する
            </button>
          </section>
        )}

        <nav aria-label="マイホームのメニュー" className="menu">
          <Link to="/my/expenses">
            医療費のまとめ
            <Icon name="next" size={18} />
          </Link>
        </nav>

        <nav aria-label="プライバシーとアカウント" className="menu">
          {household?.sensitiveConsent && (
            <button type="button" onClick={() => setWithdraw("confirm")}>
              健康に関する情報の同意を取り消す
              <Icon name="next" size={18} />
            </button>
          )}
          <Link to="/terms">
            利用規約
            <Icon name="next" size={18} />
          </Link>
          <Link to="/privacy">
            プライバシーポリシー
            <Icon name="next" size={18} />
          </Link>
          <button type="button" onClick={() => void auth.signOut()}>
            ログアウト
          </button>
          <button type="button" className="danger" onClick={() => setDel("confirm")}>
            アカウントを削除
          </button>
        </nav>
      </main>

      <Dialog
        open={withdraw === "confirm" || withdraw === "busy"}
        onClose={() => withdraw !== "busy" && setWithdraw("closed")}
        labelledBy="wd-title"
        describedBy="wd-desc"
        origin="50% 60%"
      >
        <h2 id="wd-title">同意を取り消しますか？</h2>
        <p id="wd-desc" className="note" style={{ lineHeight: 1.7 }}>
          保存している健康に関する情報（状況・自由記述・出産予定日）を、ただちに削除します。
        </p>
        <div className="stack">
          <button
            type="button"
            className="btn lg primary block"
            disabled={withdraw === "busy"}
            onClick={() => void doWithdraw()}
          >
            {withdraw === "busy" ? "削除しています…" : "取り消して削除する"}
          </button>
          <button
            type="button"
            className="btn lg block"
            disabled={withdraw === "busy"}
            onClick={() => setWithdraw("closed")}
          >
            やめる
          </button>
        </div>
      </Dialog>

      <Dialog
        open={del !== "closed"}
        onClose={() => del !== "busy" && setDel("closed")}
        role="alertdialog"
        labelledBy="del-title"
        describedBy="del-desc"
        origin="50% 100%"
      >
        <h2 id="del-title">アカウントを削除しますか？</h2>
        <div id="del-desc" className="stack" style={{ fontSize: 14, lineHeight: 1.7 }}>
          <p className="bold" style={{ color: "var(--error)" }}>
            この操作は元に戻せません。
          </p>
          <p>次のデータがすべて削除されます。</p>
          <ul style={{ paddingLeft: 20 }}>
            <li>世帯の情報</li>
            <li>チャットの履歴</li>
            <li>医療費の記録</li>
            <li>ログイン用のアカウント</li>
          </ul>
        </div>
        <AnimatePresence>
          {del === "failed" && (
            <m.p
              role="alert"
              className="err"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
            >
              削除が完了しませんでした。もう一度お試しください。
            </m.p>
          )}
        </AnimatePresence>
        <div className="stack">
          <button
            type="button"
            className="btn lg danger block"
            disabled={del === "busy"}
            onClick={() => void doDelete()}
          >
            {del === "busy"
              ? "削除しています…"
              : del === "failed"
                ? "もう一度削除する"
                : "削除する"}
          </button>
          <button
            type="button"
            className="btn lg block"
            disabled={del === "busy"}
            onClick={() => setDel("closed")}
          >
            やめる
          </button>
        </div>
      </Dialog>
      {toast}
    </div>
  );
}

export function Deleted() {
  return (
    <div className="screen white">
      <main
        className="main roomy"
        style={{ justifyContent: "center", textAlign: "center", gap: 16 }}
      >
        <p role="status" style={{ fontSize: 16, lineHeight: 1.7 }}>
          アカウントとすべてのデータを削除しました。
          <br />
          ご利用ありがとうございました。
        </p>
        <Link to="/" className="btn lg block">
          最初の画面へ
        </Link>
      </main>
    </div>
  );
}

type Unit = "month" | "year" | "subject";

export function useExpenses() {
  const { account, household } = useSession();
  const [data, setData] = useState<ExpenseOverview | null>(null);
  const [failed, setFailed] = useState(false);
  const today = todayJst(new Date());
  const load = useCallback(async () => {
    if (!household) return;
    setFailed(false);
    try {
      setData(await account.getExpenses(toMatchHousehold(household, today), today));
    } catch {
      setFailed(true);
    }
  }, [account, household, today]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, failed, reload: load };
}

export function Expenses() {
  const { household } = useSession();
  const { data, failed, reload } = useExpenses();
  const [unit, setUnit] = useState<Unit>("month");
  const subjects = useMemo(
    () => new Map(subjectsOf(household).map((s) => [s.id, s.label])),
    [household],
  );
  const buckets = !data
    ? []
    : unit === "month"
      ? data.summary.byMonth
      : unit === "year"
        ? data.summary.byYear
        : data.summary.bySubject;
  const label = (k: string) =>
    unit === "month"
      ? `${k.slice(0, 4)}年${Number(k.slice(5, 7))}月`
      : unit === "year"
        ? `${k}年`
        : (subjects.get(k) ?? k);
  const max = Math.max(1, ...buckets.map((b) => b.totalYen));

  return (
    <div className="screen with-tabbar">
      <Header back="/my" title="医療費のまとめ" />
      <main className="main">
        {failed && (
          <div role="alert" className="card alert">
            <span className="note" style={{ color: "var(--error)" }}>
              医療費を読み込めませんでした
            </span>
            <button type="button" className="btn strong" onClick={() => void reload()}>
              再試行
            </button>
          </div>
        )}
        <section className="card" aria-labelledby="h-total" style={{ gap: 12 }}>
          <div className="between" style={{ alignItems: "baseline" }}>
            <h2 id="h-total" className="h2">
              合計
            </h2>
            <span style={{ fontSize: 26, fontWeight: 700 }}>
              {data ? yen(data.summary.totalYen) : "…"}
            </span>
          </div>
          <div role="tablist" aria-label="集計の単位" className="seg">
            {(
              [
                ["month", "月ごと"],
                ["year", "年ごと"],
                ["subject", "家族ごと"],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                type="button"
                role="tab"
                aria-selected={unit === k}
                onClick={() => setUnit(k)}
                style={{
                  position: "relative",
                  background: "transparent",
                  border: unit === k ? "2px solid transparent" : undefined,
                }}
              >
                {unit === k && (
                  <m.span
                    layoutId="unit-pill"
                    transition={spring}
                    style={{
                      position: "absolute",
                      inset: -2,
                      border: "2px solid var(--ink)",
                      background: "var(--fill)",
                      borderRadius: 12,
                    }}
                  />
                )}
                <span style={{ position: "relative" }}>{l}</span>
              </button>
            ))}
          </div>
          {buckets.length === 0 ? (
            <p className="note sub">記録すると、ここに集計が出ます。</p>
          ) : (
            <ul
              style={{
                listStyle: "none",
                padding: 0,
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {buckets.map((b) => (
                <li
                  key={unit + b.key}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "96px 1fr 80px",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 13,
                  }}
                >
                  <span className="sub">{label(b.key)}</span>
                  <span className="track" aria-hidden="true">
                    <m.span
                      className="fill"
                      style={{ display: "block" }}
                      initial={{ scaleX: 0 }}
                      animate={{ scaleX: b.totalYen / max }}
                      transition={{ duration: 0.28, ease: easeOut }}
                    />
                  </span>
                  <span style={{ textAlign: "right", fontWeight: 700 }}>{yen(b.totalYen)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {data && data.suggestions.length > 0 && (
          <section className="card accent" aria-labelledby="h-suggest" style={{ gap: 12 }}>
            <h2 id="h-suggest" className="h2">
              使えるかもしれない制度
            </h2>
            {data.suggestions.map((s) => (
              <Link
                key={s.programId}
                to={`/programs/${s.programId}`}
                style={{
                  textDecoration: "none",
                  color: "var(--ink)",
                  borderLeft: "1px solid var(--line)",
                  paddingLeft: 12,
                  display: "flex",
                  flexDirection: "column",
                  gap: 4,
                }}
              >
                <span className="badges">
                  <span className="badge maybe">{s.label}</span>
                  {s.needsCheck && <span className="badge check">要確認</span>}
                </span>
                <span className="bold" style={{ fontSize: 15 }}>
                  {s.name}
                </span>
                <span className="note">
                  {s.period.from.slice(0, 4)}年の合計 {yen(s.periodTotalYen)} ・ 記録{" "}
                  {s.recordIds.length}件
                </span>
                {s.missingDocs.length > 0 && (
                  <span className="note" style={{ color: "var(--deadline)" }}>
                    足りない書類：{s.missingDocs.join("、")}
                  </span>
                )}
                <span className="small sub">
                  出典：{s.source.name ?? s.source.url} ・ 取得日 {s.source.fetchedAt}
                </span>
              </Link>
            ))}
            <p className="small sub">
              申請はご自身で行ってください。このアプリが代わりに申請することはありません。
            </p>
          </section>
        )}

        <section className="section" aria-labelledby="h-list">
          <div className="between">
            <h2 id="h-list" className="h2">
              記録
            </h2>
            <Link to="/my/expenses/new" className="btn primary">
              ＋ 記録する
            </Link>
          </div>
          {data && data.records.length === 0 && (
            <p className="note sub">
              まだ記録がありません。領収書を見ながら、手で入力してください。
            </p>
          )}
          {data && data.records.length > 0 && (
            <ul className="list">
              {data.records.map((e) => (
                <li key={e.id} style={{ padding: 0 }}>
                  <Link
                    to={`/my/expenses/${e.id}`}
                    style={{
                      flex: 1,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                      padding: "12px 16px",
                      color: "var(--ink)",
                      textDecoration: "none",
                      minHeight: 44,
                    }}
                  >
                    <span className="stack-4">
                      <span style={{ fontWeight: 500 }}>{e.facility}</span>
                      <span className="small sub">
                        {toSlashDate(e.date)} ・ {subjects.get(e.subjectId) ?? e.subjectId}
                      </span>
                    </span>
                    <span className="bold" style={{ fontSize: 15 }}>
                      {yen(e.amountYen)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}

/** 医療費の追加・修正（/my/expenses/new、/my/expenses/:id） */
export function ExpenseForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const { account, household } = useSession();
  const { data } = useExpenses();
  const editing: ExpenseRecord | undefined = id
    ? data?.records.find((r) => r.id === id)
    : undefined;
  const subjects = subjectsOf(household);
  const today = todayJst(new Date());
  const [date, setDate] = useState("");
  const [facility, setFacility] = useState("");
  const [amount, setAmount] = useState("");
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? GUARDIAN_SUBJECT_ID);
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!editing) return;
    setDate(editing.date);
    setFacility(editing.facility);
    setAmount(String(editing.amountYen));
    setSubjectId(editing.subjectId);
  }, [editing]);

  const err = (f: string) => errors.find((e) => e.field === f)?.message;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setFailure(null);
    try {
      const r = await account.saveExpense(
        { date, facility, amountYen: amount, subjectId },
        today,
        subjects.map((s) => s.id),
        editing?.id,
      );
      if (r.ok) nav("/my/expenses");
      else setErrors(r.errors); // 入力した値は残す（Requirement 6.3）
    } catch {
      setFailure("保存できませんでした。入力した内容はそのままです。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!editing) return;
    setBusy(true);
    try {
      await account.deleteExpense(editing.id);
      nav("/my/expenses");
    } catch {
      setConfirmDelete(false);
      setFailure("削除できませんでした。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };

  if (id && data && !editing) {
    return (
      <div className="screen white">
        <Header back="/my/expenses" title="医療費の記録" />
        <main className="main">
          <p role="alert">この記録は見つかりませんでした。</p>
        </main>
      </div>
    );
  }

  return (
    <div className="screen white">
      <header className="header back" style={{ justifyContent: "space-between" }}>
        <button
          type="button"
          className="btn ghost"
          onClick={() => nav("/my/expenses")}
          style={{ fontSize: 15 }}
        >
          キャンセル
        </button>
        <h1 style={{ fontSize: 16 }}>{editing ? "記録を修正" : "医療費を記録"}</h1>
        <span aria-hidden="true" style={{ width: 88 }} />
      </header>
      <form
        className="main"
        style={{ padding: "24px 16px" }}
        onSubmit={(e) => void save(e)}
        noValidate
      >
        <div className="field">
          <label htmlFor="d">受診日</label>
          <input
            id="d"
            type="date"
            className="input"
            value={date}
            max={today}
            onChange={(e) => setDate(e.target.value)}
            aria-invalid={!!err("date")}
            aria-describedby="d-err"
          />
          {err("date") && (
            <p id="d-err" className="err">
              {err("date")}
            </p>
          )}
        </div>
        <div className="field">
          <label htmlFor="h">医療機関名</label>
          <input
            id="h"
            className="input"
            value={facility}
            onChange={(e) => setFacility(e.target.value)}
            aria-invalid={!!err("facility")}
            aria-describedby="h-err"
          />
          <div className="between">
            <span id="h-err" className="err">
              {err("facility")}
            </span>
            <span
              className="small"
              style={{
                color: [...facility.trim()].length > 100 ? "var(--error)" : "var(--sub)",
                flex: "none",
              }}
            >
              {[...facility.trim()].length} / 100
            </span>
          </div>
        </div>
        <div className="field">
          <label htmlFor="a">金額（円）</label>
          <input
            id="a"
            className="input"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            aria-invalid={!!err("amountYen")}
            aria-describedby="a-err"
          />
          {err("amountYen") && (
            <p id="a-err" className="err">
              {err("amountYen")}
            </p>
          )}
        </div>
        <fieldset style={{ margin: 0, padding: 0, border: 0 }}>
          <legend className="label" style={{ padding: 0, marginBottom: 8 }}>
            だれの医療費？
          </legend>
          <div role="radiogroup" className="chips">
            {subjects.map((s) => (
              <button
                type="button"
                key={s.id}
                role="radio"
                aria-checked={subjectId === s.id}
                className="chip"
                onClick={() => setSubjectId(s.id)}
              >
                {s.label}
              </button>
            ))}
          </div>
          {err("subjectId") && <p className="err">{err("subjectId")}</p>}
        </fieldset>
        <p className="notice gray">領収書の写真の読み取りは、今後対応する予定です</p>
        {err("form") && (
          <p role="alert" className="err">
            {err("form")}
          </p>
        )}
        {failure && (
          <p role="alert" className="err">
            {failure}
          </p>
        )}
        <div className="spacer" />
        <div className="stack">
          <button type="submit" className="btn lg primary block" disabled={busy}>
            {busy ? "保存しています…" : "保存"}
          </button>
          {editing && (
            <button
              type="button"
              className="btn lg block"
              style={{ color: "var(--error)" }}
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
            >
              この記録を削除
            </button>
          )}
        </div>
      </form>

      <Dialog
        open={confirmDelete}
        onClose={() => !busy && setConfirmDelete(false)}
        role="alertdialog"
        labelledBy="ed-title"
        origin="50% 100%"
      >
        <h2 id="ed-title">この記録を削除しますか？</h2>
        {editing && (
          <p className="note">
            {toSlashDate(editing.date)} ・ {editing.facility} ・ {yen(editing.amountYen)}
          </p>
        )}
        <div className="stack">
          <button
            type="button"
            className="btn lg danger block"
            disabled={busy}
            onClick={() => void remove()}
          >
            {busy ? "削除しています…" : "削除する"}
          </button>
          <button
            type="button"
            className="btn lg block"
            disabled={busy}
            onClick={() => setConfirmDelete(false)}
          >
            やめる
          </button>
        </div>
      </Dialog>
    </div>
  );
}
