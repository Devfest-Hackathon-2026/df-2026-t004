// オンボーディング（Requirement 2.1〜2.14, 9.1, 9.2, 11.7, 11.8）
// 必須は3項目（郵便番号・子どもの人数・年齢または出産予定日）。任意の項目には「あとで入力する」を付ける。

import {
  CHILDREN_MAX,
  FREE_TEXT_MAX,
  POSTAL_MESSAGES,
  charCount,
  dueDateMax,
  dueDateRangeMessage,
  normalizePostalCode,
  todayJst,
  validateChildren,
  validateDueDate,
  type PostalClassification,
} from "@hachioji-gov/shared";
import { useEffect, useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog, Header } from "../components/ui";
import { draftChildren, useSession, type OnboardingDraft } from "../state/session";

/** 状況チップ。値は保存用の識別子（要配慮情報として sensitive/profile に入る） */
export const SITUATIONS = [
  { id: "disability", label: "障がいがある", health: true },
  { id: "sports", label: "スポーツをしたい", health: false },
  { id: "study_abroad", label: "留学を考えている", health: false },
] as const;

function Step({ n, children }: { n: 1 | 2 | 3; children: ReactNode }) {
  return (
    <div className="screen white">
      <Header
        back={n === 1 ? undefined : true}
        plain
        title={
          <span style={{ fontSize: 14, color: "var(--sub)", paddingLeft: n === 1 ? 8 : 0 }}>
            ステップ {n} / 3{n === 3 ? "（任意）" : ""}
          </span>
        }
      />
      <div style={{ padding: "0 24px" }}>
        <div className="track thin" aria-hidden="true">
          <div className="fill" style={{ width: `${(n / 3) * 100}%` }} />
        </div>
      </div>
      <main className="main roomy">{children}</main>
    </div>
  );
}

const SOURCES: Record<string, string[]> = {
  hachioji: ["国", "東京都", "八王子市"],
  outside: ["国"],
};

export function OnbPostal() {
  const nav = useNavigate();
  const { api, draft, setDraft } = useSession();
  const [result, setResult] = useState<PostalClassification | null>(null);
  const [touched, setTouched] = useState(false);
  const [lookupFailed, setLookupFailed] = useState(false);
  const code = normalizePostalCode(draft.postalCode);

  useEffect(() => {
    setResult(null);
    setLookupFailed(false);
    if (!/^\d{7}$/.test(code)) return;
    let alive = true;
    api.lookupPostal(code).then(
      (r) => alive && setResult(r),
      () => alive && setLookupFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [api, code]);

  const err = lookupFailed
    ? "住所を確認できませんでした。通信状態を確認してください。"
    : result?.kind === "notFound"
      ? POSTAL_MESSAGES.notFound
      : touched && !/^\d{7}$/.test(code)
        ? POSTAL_MESSAGES.invalidFormat
        : null;

  const next = (nationalOnly: boolean) => {
    setTouched(true);
    if (result?.kind !== "hachioji" && !(result?.kind === "outside" && nationalOnly)) return;
    setDraft((d) => ({ ...d, nationalOnly }));
    nav("/onboarding/children");
  };

  return (
    <Step n={1}>
      <div className="stack">
        <h1 className="title-xl">お住まいの郵便番号</h1>
        <p className="lead">住んでいる地域で使える制度を探すために使います。</p>
      </div>
      <div className="field">
        <label htmlFor="zip">
          郵便番号（7桁） <span className="req">必須</span>
        </label>
        <input
          id="zip"
          className="input"
          inputMode="numeric"
          autoComplete="postal-code"
          placeholder="例：192-0083"
          value={draft.postalCode}
          onChange={(e) => setDraft((d) => ({ ...d, postalCode: e.target.value }))}
          onBlur={() => setTouched(true)}
          aria-invalid={!!err}
          aria-describedby={err ? "zip-err" : undefined}
          style={{ height: 52, fontSize: 20, letterSpacing: 1 }}
        />
        {err && (
          <p id="zip-err" className="err" role="alert">
            {err}
          </p>
        )}
      </div>

      {(result?.kind === "hachioji" || result?.kind === "outside") && (
        <section aria-label="住所の確認" aria-live="polite" className="card" style={{ gap: 12 }}>
          <p style={{ fontSize: 16, fontWeight: 500 }}>
            {result.entry.prefecture} {result.entry.city} {result.entry.town}
          </p>
          <div className="stack" style={{ gap: 6 }}>
            <span className="note sub">あなたに届く制度の情報源</span>
            <div className="chips">
              {(SOURCES[result.kind] ?? []).map((s) => (
                <span key={s} className="chip static">
                  {s}
                </span>
              ))}
            </div>
          </div>
          {result.kind === "outside" && (
            <>
              <p style={{ fontSize: 14, lineHeight: 1.6 }}>{POSTAL_MESSAGES.outside}</p>
              <button type="button" className="btn outline self-start" onClick={() => next(true)}>
                国の制度だけで続ける
              </button>
            </>
          )}
        </section>
      )}

      <div className="spacer" />
      <button
        type="button"
        className="btn lg primary block"
        onClick={() => next(false)}
        disabled={result?.kind === "outside"}
      >
        次へ
      </button>
    </Step>
  );
}

export function OnbChildren() {
  const nav = useNavigate();
  const { draft, setDraft } = useSession();
  const [tried, setTried] = useState(false);
  const today = todayJst(new Date());
  const kids = draft.children;
  const dueDeferred = draft.deferred.includes("dueDate");
  const showDue =
    kids.length === 0 ||
    draft.dueDate !== "" ||
    (!dueDeferred && draft.deferred.includes("dueDate:open"));

  const setKids = (f: (k: OnboardingDraft["children"]) => OnboardingDraft["children"]) =>
    setDraft((d) => ({ ...d, children: f(d.children) }));
  const setCount = (n: number) =>
    setKids((k) =>
      n > k.length
        ? [
            ...k,
            ...Array.from({ length: n - k.length }, () => ({ mode: "years" as const, value: "" })),
          ]
        : k.slice(0, n),
    );

  const childErrors = validateChildren(draftChildren(draft)).errors;
  const errFor = (i: number) =>
    childErrors.find((e) => e.field.startsWith(`children.${i}.`))?.message;
  const dueErr =
    kids.length === 0 && draft.dueDate === ""
      ? "子どもが0人のときは、出産予定日を入れてください"
      : draft.dueDate !== "" && !validateDueDate(draft.dueDate, today)
        ? dueDateRangeMessage(today)
        : null;

  const next = () => {
    setTried(true);
    if (childErrors.length > 0 || dueErr) return;
    nav("/onboarding/consent");
  };

  return (
    <Step n={2}>
      <h1 className="title-xl">お子さんについて</h1>
      <div className="stack">
        <span id="count-label" className="label">
          子どもの人数 <span className="req">必須</span>
        </span>
        <div role="group" aria-labelledby="count-label" className="row" style={{ gap: 16 }}>
          <button
            type="button"
            className="btn"
            style={{ width: 48, height: 48, fontSize: 22, padding: 0 }}
            aria-label="1人減らす"
            disabled={kids.length === 0}
            onClick={() => setCount(kids.length - 1)}
          >
            −
          </button>
          <output
            aria-live="polite"
            style={{ minWidth: 48, textAlign: "center", fontSize: 24, fontWeight: 700 }}
          >
            {kids.length}人
          </output>
          <button
            type="button"
            className="btn"
            style={{ width: 48, height: 48, fontSize: 22, padding: 0 }}
            aria-label="1人増やす"
            disabled={kids.length >= CHILDREN_MAX}
            onClick={() => setCount(kids.length + 1)}
          >
            ＋
          </button>
        </div>
      </div>

      {kids.map((c, i) => {
        const e = (tried || c.value !== "") && errFor(i);
        const set = (p: Partial<(typeof kids)[number]>) =>
          setKids((k) => k.map((x, j) => (j === i ? { ...x, ...p } : x)));
        return (
          <fieldset key={i} className="group">
            <legend>{i + 1}人目</legend>
            <div role="radiogroup" aria-label="年齢の入れ方" className="seg">
              <button
                type="button"
                role="radio"
                aria-checked={c.mode === "years"}
                onClick={() => set({ mode: "years", value: "" })}
              >
                歳で入れる
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={c.mode === "months"}
                onClick={() => set({ mode: "months", value: "" })}
              >
                月齢（0歳）
              </button>
            </div>
            <div className="row" style={{ alignItems: "flex-end" }}>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor={`age${i}`} className="note sub" style={{ fontWeight: 400 }}>
                  {c.mode === "years" ? "年齢（0〜18歳）" : "月齢（0〜11か月）"}
                </label>
                <input
                  id={`age${i}`}
                  className="input"
                  inputMode="numeric"
                  value={c.value}
                  onChange={(ev) =>
                    set({ value: ev.target.value.replace(/[^0-9]/g, "").slice(0, 2) })
                  }
                  aria-invalid={!!e}
                  aria-describedby={e ? `age${i}-err` : undefined}
                />
              </div>
              <span style={{ height: 48, display: "flex", alignItems: "center", fontSize: 15 }}>
                {c.mode === "years" ? "歳" : "か月"}
              </span>
            </div>
            {e && (
              <p id={`age${i}-err`} className="err">
                {e}
              </p>
            )}
          </fieldset>
        );
      })}

      <div className="stack">
        <div className="between">
          <span className="label">
            妊娠中・出産予定{" "}
            <span className={kids.length === 0 ? "req" : "opt"}>
              {kids.length === 0 ? "必須" : "任意"}
            </span>
          </span>
          {kids.length > 0 && !dueDeferred && (
            <button
              type="button"
              className="btn ghost"
              onClick={() =>
                setDraft((d) => ({
                  ...d,
                  dueDate: "",
                  deferred: [...d.deferred.filter((x) => !x.startsWith("dueDate")), "dueDate"],
                }))
              }
            >
              あとで入力する
            </button>
          )}
        </div>
        {showDue ? (
          <div className="field">
            <label htmlFor="due" className="sr-only">
              出産予定日
            </label>
            <input
              id="due"
              type="date"
              className="input"
              min={today}
              max={dueDateMax(today) ?? undefined}
              value={draft.dueDate}
              onChange={(e) => setDraft((d) => ({ ...d, dueDate: e.target.value }))}
              aria-invalid={tried && !!dueErr}
              aria-describedby="due-err"
            />
            {tried && dueErr && (
              <p id="due-err" className="err">
                {dueErr}
              </p>
            )}
          </div>
        ) : (
          <button
            type="button"
            className="btn md dashed block"
            onClick={() =>
              setDraft((d) => ({
                ...d,
                deferred: [...d.deferred.filter((x) => !x.startsWith("dueDate")), "dueDate:open"],
              }))
            }
          >
            ＋ 出産予定日を追加{dueDeferred ? "（あとで入力するを取り消す）" : ""}
          </button>
        )}
        <p className="small sub" style={{ lineHeight: 1.6 }}>
          子どもが0人のときは、出産予定日が必須になります（今日から10か月後まで）
        </p>
      </div>

      <div className="spacer" />
      <button type="button" className="btn lg primary block" onClick={next}>
        次へ
      </button>
    </Step>
  );
}

export function OnbConsent() {
  const { api, draft, setDraft, setHousehold } = useSession();
  const [dialog, setDialog] = useState<
    null | { reason: "chip"; chip: string } | { reason: "save" }
  >(null);
  const [declined, setDeclined] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = todayJst(new Date());

  const sensitiveItems = (d: OnboardingDraft, skipOptional: boolean) => [
    ...(d.dueDate ? ["出産予定日"] : []),
    ...(skipOptional
      ? []
      : d.situationChips.map((id) => SITUATIONS.find((s) => s.id === id)?.label ?? id)),
    ...(!skipOptional && d.freeText.trim() ? ["そのほか気になること"] : []),
  ];

  const toggle = (id: string) => {
    if (draft.situationChips.includes(id))
      return setDraft((d) => ({ ...d, situationChips: d.situationChips.filter((x) => x !== id) }));
    const health = SITUATIONS.find((s) => s.id === id)?.health;
    if (health && !draft.sensitiveConsent) return setDialog({ reason: "chip", chip: id });
    setDraft((d) => ({ ...d, situationChips: [...d.situationChips, id] }));
  };

  const save = async (skipOptional: boolean, consent: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.saveHousehold(
        {
          postalCode: draft.postalCode,
          children: draftChildren(draft),
          ...(draft.dueDate ? { dueDate: draft.dueDate } : {}),
          situationChips: skipOptional ? [] : draft.situationChips,
          ...(skipOptional || !draft.freeText.trim() ? {} : { freeText: draft.freeText.trim() }),
          sensitiveConsent: consent,
          onboardingDeferred: [
            ...draft.deferred.filter((x) => x === "dueDate"),
            ...(skipOptional ? ["situationChips", "freeText"] : []),
          ],
        },
        today,
      );
      if (r.ok) setHousehold(r.household);
      else setError(r.errors.map((e) => e.message).join("\n"));
    } catch {
      setError("保存できませんでした。通信状態を確認して、もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };

  const finish = (skipOptional: boolean) => {
    const needsConsent =
      sensitiveItems(draft, skipOptional).length > 0 && !draft.sensitiveConsent && !declined;
    if (needsConsent) return setDialog({ reason: "save" });
    void save(skipOptional, draft.sensitiveConsent && !declined);
  };

  const agree = () => {
    const d = dialog;
    setDialog(null);
    setDeclined(false);
    setDraft((x) => ({
      ...x,
      sensitiveConsent: true,
      situationChips: d?.reason === "chip" ? [...x.situationChips, d.chip] : x.situationChips,
    }));
    if (d?.reason === "save") void save(false, true);
  };
  const decline = () => {
    const d = dialog;
    setDialog(null);
    if (d?.reason === "save") {
      // 同意しない場合は要配慮情報を保存しない（Requirement 2.7, 9.2）
      setDeclined(true);
      setDraft((x) => ({ ...x, sensitiveConsent: false }));
    }
  };
  const items =
    dialog?.reason === "chip"
      ? [SITUATIONS.find((s) => s.id === dialog.chip)?.label ?? ""]
      : sensitiveItems(draft, false);

  return (
    <Step n={3}>
      <div className="stack" style={{ gap: 6 }}>
        <h1 className="title-xl">お子さんの状況</h1>
        <p className="lead">入れると、合う制度を探しやすくなります。</p>
      </div>
      <div className="stack">
        <span className="label" id="sit-label">
          当てはまるもの（いくつでも）
        </span>
        <div className="chips" role="group" aria-labelledby="sit-label">
          {SITUATIONS.map((s) => {
            const on = draft.situationChips.includes(s.id);
            return (
              <button
                key={s.id}
                type="button"
                className="chip"
                aria-pressed={on}
                onClick={() => toggle(s.id)}
              >
                {on && "✓ "}
                {s.label}
              </button>
            );
          })}
        </div>
      </div>
      <div className="field">
        <label htmlFor="free">
          そのほか気になること <span className="opt">任意</span>
        </label>
        <textarea
          id="free"
          className="input"
          rows={3}
          placeholder="例：保育園に入れるか心配"
          value={draft.freeText}
          aria-invalid={charCount(draft.freeText) > FREE_TEXT_MAX}
          aria-describedby="free-count"
          onChange={(e) => setDraft((d) => ({ ...d, freeText: e.target.value }))}
        />
        <span
          id="free-count"
          className="small"
          style={{
            alignSelf: "flex-end",
            color: charCount(draft.freeText) > FREE_TEXT_MAX ? "var(--error)" : "var(--sub)",
          }}
        >
          {charCount(draft.freeText)} / {FREE_TEXT_MAX}
        </span>
      </div>

      {declined && (
        <p role="status" className="notice gray">
          健康に関する情報（{sensitiveItems(draft, false).join("、")}
          ）は保存しません。ほかの機能はそのまま使えます。
        </p>
      )}
      {error && (
        <p role="alert" className="err" style={{ whiteSpace: "pre-line" }}>
          {error}
        </p>
      )}

      <div className="spacer" />
      <div className="stack">
        <button
          type="button"
          className="btn lg primary block"
          disabled={busy || charCount(draft.freeText) > FREE_TEXT_MAX}
          onClick={() => finish(false)}
        >
          {busy ? "保存しています…" : "はじめる"}
        </button>
        <button
          type="button"
          className="btn ghost block"
          style={{ fontSize: 15 }}
          disabled={busy}
          onClick={() => finish(true)}
        >
          あとで入力する
        </button>
      </div>

      <Dialog
        open={dialog !== null}
        onClose={decline}
        labelledBy="consent-title"
        describedBy="consent-desc"
        origin="30% 40%"
      >
        <h2 id="consent-title" style={{ fontSize: 16 }}>
          健康に関する情報の取り扱い
        </h2>
        <div id="consent-desc" className="stack note" style={{ lineHeight: 1.7 }}>
          <p>次の情報は要配慮個人情報です：{items.join("、")}</p>
          <p>
            利用目的：あなたの世帯に合う制度を探すためだけに使います。AIには送りません。同意はマイホームからいつでも取り消せます。
          </p>
        </div>
        <a href="/privacy" target="_blank" rel="noreferrer" className="note">
          くわしく（プライバシーポリシー）
        </a>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <button type="button" className="btn" onClick={decline}>
            同意しない
          </button>
          <button type="button" className="btn primary" onClick={agree}>
            同意して保存
          </button>
        </div>
      </Dialog>
    </Step>
  );
}
