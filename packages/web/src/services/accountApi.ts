// 医療費・同意撤回・アカウント削除の API
// （POST/PUT/DELETE /expenses、GET /expenses/summary、DELETE /consents/sensitive、DELETE /account）
// 本物の API（T20）ができるまでは仮実装（mock）で画面を動かす。

import {
  aggregateExpenses,
  suggestProgramsFromExpenses,
  toExpenseRecord,
  validateExpense,
  type ExpenseInput,
  type ExpenseRecord,
  type ExpenseSuggestion,
  type ExpenseSummary,
  type FieldError,
  type MatchHousehold,
} from "@hachioji-gov/shared";
import { API_BASE, readFieldErrors } from "../lib/api";
import { MOCK_PROGRAMS } from "../mock/programs";

export type ExpenseOverview = {
  readonly records: readonly ExpenseRecord[];
  readonly summary: ExpenseSummary;
  readonly suggestions: readonly ExpenseSuggestion[];
};

export type ExpenseSaveResult =
  | { readonly ok: true; readonly record: ExpenseRecord }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

export interface AccountApi {
  getExpenses(household: MatchHousehold, today: string): Promise<ExpenseOverview>;
  saveExpense(
    input: ExpenseInput,
    today: string,
    subjectIds: readonly string[],
    id?: string,
  ): Promise<ExpenseSaveResult>;
  deleteExpense(id: string): Promise<void>;
  withdrawSensitiveConsent(): Promise<void>;
  deleteAccount(): Promise<void>;
}

/**
 * ブラウザ内の仮実装。
 * URL に ?fail=delete-account / ?fail=withdraw / ?fail=expense を付けると、その操作を1回だけ失敗させる。
 */
export function createMockAccountApi(): AccountApi {
  const records = new Map<string, ExpenseRecord>();
  const failOnce = new Set(
    typeof location === "undefined" ? [] : new URLSearchParams(location.search).getAll("fail"),
  );
  const wait = <T>(v: T, ms = 250) => new Promise<T>((r) => setTimeout(() => r(v), ms));
  const maybeFail = async (key: string) => {
    if (failOnce.delete(key)) {
      await wait(undefined, 400);
      throw new Error(`mock failure: ${key}`);
    }
  };
  let seq = 0;
  return {
    async getExpenses(household, today) {
      const list = [...records.values()].sort((a, b) =>
        a.date < b.date ? 1 : a.date > b.date ? -1 : 0,
      );
      return wait({
        records: list,
        summary: aggregateExpenses(list),
        suggestions: suggestProgramsFromExpenses(list, MOCK_PROGRAMS, { today, household }),
      });
    },
    async saveExpense(input, today, subjectIds, id) {
      await maybeFail("expense");
      const check = validateExpense(input, today, subjectIds);
      if (!check.ok) return wait({ ok: false, errors: check.errors });
      const now = new Date().toISOString();
      const prev = id ? records.get(id) : undefined;
      const record = toExpenseRecord(
        input,
        { id: id ?? `e${++seq}`, now, ...(prev ? { createdAt: prev.createdAt } : {}) },
        today,
        subjectIds,
      );
      if (!record) return wait({ ok: false, errors: check.errors });
      records.set(record.id, record);
      return wait({ ok: true, record });
    },
    async deleteExpense(id) {
      await maybeFail("expense");
      records.delete(id);
      await wait(undefined);
    },
    async withdrawSensitiveConsent() {
      await maybeFail("withdraw");
      await wait(undefined);
    },
    async deleteAccount() {
      await maybeFail("delete-account");
      records.clear();
      await wait(undefined, 600);
    },
  };
}

export function createHttpAccountApi(idToken: () => Promise<string | null>): AccountApi {
  const call = async (path: string, init: RequestInit = {}) => {
    const t = await idToken();
    return fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(t ? { Authorization: `Bearer ${t}` } : {}),
      },
    });
  };
  const ok = async (res: Response, label: string) => {
    if (!res.ok) throw new Error(`${label} ${res.status}`);
    return res;
  };
  return {
    async getExpenses() {
      const res = await ok(await call("/expenses/summary"), "GET /expenses/summary");
      return (await res.json()) as ExpenseOverview;
    },
    async saveExpense(input, _today, _subjects, id) {
      const res = await call(id ? `/expenses/${encodeURIComponent(id)}` : "/expenses", {
        method: id ? "PUT" : "POST",
        body: JSON.stringify(input),
      });
      if (res.status === 400) return { ok: false, errors: await readFieldErrors(res) };
      if (res.status === 409)
        return {
          ok: false,
          errors: [
            {
              field: "form",
              message: "記録できる件数の上限に達しました。古い記録を削除してください。",
            },
          ],
        };
      await ok(res, "save expense");
      return { ok: true, record: (await res.json()) as ExpenseRecord };
    },
    async deleteExpense(id) {
      await ok(
        await call(`/expenses/${encodeURIComponent(id)}`, { method: "DELETE" }),
        "DELETE /expenses",
      );
    },
    async withdrawSensitiveConsent() {
      await ok(
        await call("/consents/sensitive", { method: "DELETE" }),
        "DELETE /consents/sensitive",
      );
    },
    async deleteAccount() {
      await ok(await call("/account", { method: "DELETE" }), "DELETE /account");
    },
  };
}
