// 世帯情報の編集（Requirement 8.1, 8.2, 11.8。優先度「できれば」）
// 「あとで入力する」にした項目も、ここから入力できる。保存に失敗したときは以前の情報を保つ。

import {
  CHILDREN_MAX,
  FREE_TEXT_MAX,
  charCount,
  dueDateMax,
  todayJst,
  type FieldError,
} from "@hachioji-gov/shared";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog, Header } from "../components/ui";
import type { Household } from "../services/householdApi";
import { draftChildren, useSession, type OnboardingDraft } from "../state/session";
import { SITUATIONS } from "./Onboarding";

/** 保存済みの世帯情報を、編集フォームの値にする */
export function draftFromHousehold(h: Household): OnboardingDraft {
  return {
    postalCode: h.postalCode,
    nationalOnly: h.municipalityCode !== "13201",
    children: h.children.map((c) =>
      c.ageYears === 0 && c.ageMonths !== undefined
        ? { mode: "months" as const, value: String(c.ageMonths) }
        : { mode: "years" as const, value: String(c.ageYears) },
    ),
    dueDate: h.sensitive?.pregnancy?.dueDate ?? "",
    situationChips: [...(h.sensitive?.situationChips ?? [])],
    freeText: h.sensitive?.childNote ?? "",
    sensitiveConsent: h.sensitiveConsent,
    deferred: [...h.onboardingDeferred],
  };
}

export function HouseholdEdit() {
  const nav = useNavigate();
  const { api, household, setHousehold } = useSession();
  const [form, setForm] = useState<OnboardingDraft | null>(() =>
    household ? draftFromHousehold(household) : null,
  );
  const [errors, setErrors] = useState<readonly FieldError[]>([]);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [askConsent, setAskConsent] = useState(false);
  const today = todayJst(new Date());
  if (!form || !household) return null;

  const set = (p: Partial<OnboardingDraft>) => setForm({ ...form, ...p });
  const err = (prefix: string) => errors.find((e) => e.field.startsWith(prefix))?.message;
  const hasSensitive =
    form.dueDate !== "" || form.situationChips.length > 0 || form.freeText.trim() !== "";

  const save = async (consent: boolean) => {
    const input = {
      postalCode: form.postalCode,
      children: draftChildren(form),
      ...(form.dueDate ? { dueDate: form.dueDate } : {}),
      situationChips: consent ? form.situationChips : [],
      ...(consent && form.freeText.trim() ? { freeText: form.freeText.trim() } : {}),
      sensitiveConsent: consent,
      // 入力した項目は「あとで入力する」から外す
      onboardingDeferred: form.deferred.filter((d) =>
        d === "dueDate"
          ? form.dueDate === ""
          : d === "situationChips"
            ? form.situationChips.length === 0
            : d === "freeText"
              ? form.freeText.trim() === ""
              : true,
      ),
    };
    setErrors([]);
    setBusy(true);
    setFailure(null);
    try {
      const r = await api.saveHousehold(input, today);
      if (!r.ok) return setErrors(r.errors);
      setHousehold(r.household); // ダッシュボードは次に開いたときに新しい世帯情報で候補を出し直す
      nav("/my", { replace: true });
    } catch {
      // 以前の情報とおすすめはそのまま（Requirement 8.2）
      setFailure("保存できませんでした。以前の情報はそのままです。もう一度お試しください。");
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (hasSensitive && !form.sensitiveConsent) return setAskConsent(true);
    void save(form.sensitiveConsent);
  };

  const deferredLabel = (d: string) =>
    ({ dueDate: "出産予定日", situationChips: "お子さんの状況", freeText: "そのほか気になること" })[
      d as "dueDate"
    ] ?? d;
  const pendingDeferred = form.deferred.filter((d) =>
    ["dueDate", "situationChips", "freeText"].includes(d),
  );

  return (
    <div className="screen white">
      <Header back="/my" title="世帯の情報を編集" />
      <main className="main">
        {pendingDeferred.length > 0 && (
          <p className="notice gray">
            「あとで入力する」にした項目：{pendingDeferred.map(deferredLabel).join("、")}
          </p>
        )}

        <div className="field">
          <label htmlFor="zip">郵便番号（7桁）</label>
          <input
            id="zip"
            className="input"
            inputMode="numeric"
            value={form.postalCode}
            onChange={(e) => set({ postalCode: e.target.value })}
            aria-invalid={!!err("postalCode")}
            aria-describedby="zip-err"
          />
          {err("postalCode") ? (
            <p id="zip-err" className="err">
              {err("postalCode")}
            </p>
          ) : (
            <p className="hint">
              いま：{household.prefecture} {household.city} {household.town}
            </p>
          )}
        </div>

        <fieldset className="group">
          <legend>子ども（{form.children.length}人）</legend>
          {form.children.map((c, i) => (
            <div key={i} className="row" style={{ alignItems: "flex-end" }}>
              <div className="field" style={{ flex: 1 }}>
                <label htmlFor={`age${i}`} className="note sub" style={{ fontWeight: 400 }}>
                  {i + 1}人目（{c.mode === "years" ? "歳" : "0歳・月齢"}）
                </label>
                <input
                  id={`age${i}`}
                  className="input"
                  inputMode="numeric"
                  value={c.value}
                  aria-invalid={!!err(`children.${i}.`)}
                  onChange={(e) =>
                    set({
                      children: form.children.map((x, j) =>
                        j === i
                          ? { ...x, value: e.target.value.replace(/[^0-9]/g, "").slice(0, 2) }
                          : x,
                      ),
                    })
                  }
                />
              </div>
              <button
                type="button"
                className="btn"
                style={{ minWidth: 88 }}
                onClick={() =>
                  set({
                    children: form.children.map((x, j) =>
                      j === i
                        ? {
                            mode: x.mode === "years" ? ("months" as const) : ("years" as const),
                            value: "",
                          }
                        : x,
                    ),
                  })
                }
              >
                {c.mode === "years" ? "月齢で" : "歳で"}
              </button>
              <button
                type="button"
                className="icon-btn"
                aria-label={`${i + 1}人目を削除`}
                onClick={() => set({ children: form.children.filter((_, j) => j !== i) })}
              >
                ✕
              </button>
            </div>
          ))}
          {form.children.map(
            (_, i) =>
              err(`children.${i}.`) && (
                <p key={`e${i}`} className="err">
                  {i + 1}人目：{err(`children.${i}.`)}
                </p>
              ),
          )}
          {form.children.length < CHILDREN_MAX && (
            <button
              type="button"
              className="btn dashed self-start"
              onClick={() => set({ children: [...form.children, { mode: "years", value: "" }] })}
            >
              ＋ 子どもを追加
            </button>
          )}
        </fieldset>

        <div className="field">
          <label htmlFor="due">
            出産予定日{" "}
            <span className={form.children.length === 0 ? "req" : "opt"}>
              {form.children.length === 0 ? "必須" : "任意"}
            </span>
          </label>
          <input
            id="due"
            type="date"
            className="input"
            min={today}
            max={dueDateMax(today) ?? undefined}
            value={form.dueDate}
            onChange={(e) => set({ dueDate: e.target.value })}
            aria-invalid={!!err("dueDate")}
          />
          {err("dueDate") && <p className="err">{err("dueDate")}</p>}
        </div>

        <div className="stack">
          <span className="label">お子さんの状況</span>
          <div className="chips">
            {SITUATIONS.map((s) => {
              const on = form.situationChips.includes(s.id);
              return (
                <button
                  key={s.id}
                  type="button"
                  className="chip"
                  aria-pressed={on}
                  onClick={() =>
                    set({
                      situationChips: on
                        ? form.situationChips.filter((x) => x !== s.id)
                        : [...form.situationChips, s.id],
                    })
                  }
                >
                  {on && "✓ "}
                  {s.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="field">
          <label htmlFor="free">そのほか気になること</label>
          <textarea
            id="free"
            className="input"
            rows={3}
            value={form.freeText}
            onChange={(e) => set({ freeText: e.target.value })}
            aria-invalid={charCount(form.freeText) > FREE_TEXT_MAX}
          />
          <span className="small sub" style={{ alignSelf: "flex-end" }}>
            {charCount(form.freeText)} / {FREE_TEXT_MAX}
          </span>
        </div>

        {failure && (
          <p role="alert" className="err">
            {failure}
          </p>
        )}
        <div className="spacer" />
        <button type="button" className="btn lg primary block" disabled={busy} onClick={submit}>
          {busy ? "保存しています…" : failure ? "もう一度保存する" : "保存"}
        </button>
      </main>

      <Dialog
        open={askConsent}
        onClose={() => setAskConsent(false)}
        labelledBy="hc-title"
        describedBy="hc-desc"
      >
        <h2 id="hc-title" style={{ fontSize: 16 }}>
          健康に関する情報の取り扱い
        </h2>
        <p id="hc-desc" className="note" style={{ lineHeight: 1.7 }}>
          出産予定日・お子さんの状況・自由記述は要配慮個人情報です。あなたの世帯に合う制度を探すためだけに使い、AIには送りません。
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setAskConsent(false);
              set({ dueDate: "", situationChips: [], freeText: "" });
            }}
          >
            同意しない
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              setAskConsent(false);
              set({ sensitiveConsent: true });
              void save(true);
            }}
          >
            同意して保存
          </button>
        </div>
      </Dialog>
    </div>
  );
}
