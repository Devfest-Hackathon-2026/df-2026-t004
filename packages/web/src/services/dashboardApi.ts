// ダッシュボードと制度詳細の API（GET /dashboard、GET /programs/:id、PUT /applications/:programId）
// 本物の API（T20）ができるまでは仮実装（mock）で画面を動かす。

import {
  matchPrograms,
  type Application,
  type ApplicationTask,
  type MatchHousehold,
  type Program,
  type ProgramCategory,
  type ProgramMatch,
} from "@hachioji-gov/shared";
import { API_BASE, fetchCached, type CachedFetchResult } from "../lib/api";
import { MOCK_PROGRAMS } from "../mock/programs";

/** セクションごとに成功・失敗を返す（失敗しても他のセクションは表示する。Requirement 4.11） */
export type Section<T> = { readonly ok: true; readonly data: T } | { readonly ok: false };
export type Dashboard = {
  readonly programs: Section<ProgramMatch[]>;
  readonly applications: Section<Application[]>;
};
export type ApplicationUpdate = {
  readonly status: Application["status"];
  readonly tasks: readonly ApplicationTask[];
};

export interface DashboardApi {
  getDashboard(
    household: MatchHousehold,
    today: string,
    category: ProgramCategory | null,
  ): Promise<Dashboard>;
  getProgram(id: string): Promise<CachedFetchResult<Program>>;
  getApplication(programId: string): Promise<Application | null>;
  updateApplication(programId: string, update: ApplicationUpdate): Promise<Application>;
}

/** 申請のタスクは、制度の必要書類から作る */
export function tasksFromProgram(p: Program): ApplicationTask[] {
  return (p.requiredDocs ?? []).map((label, i) => ({ id: `t${i + 1}`, label, done: false }));
}

/**
 * ブラウザ内の仮実装。
 * URL に ?fail=programs / ?fail=applications を付けると、そのセクションの読み込みを1回だけ失敗させる。
 */
export function createMockDashboardApi(programs: readonly Program[] = MOCK_PROGRAMS): DashboardApi {
  const apps = new Map<string, Application>();
  const failOnce = new Set(
    typeof location === "undefined" ? [] : new URLSearchParams(location.search).getAll("fail"),
  );
  const wait = <T>(v: T, ms = 250) => new Promise<T>((r) => setTimeout(() => r(v), ms));
  const take = (k: string) => failOnce.delete(k);
  return {
    async getDashboard(household, today, category) {
      return wait({
        programs: take("programs")
          ? { ok: false }
          : { ok: true, data: matchPrograms(household, programs, today, category) },
        applications: take("applications") ? { ok: false } : { ok: true, data: [...apps.values()] },
      });
    },
    async getProgram(id) {
      const p = programs.find(
        (x) => x.id === id && x.verified && !x.needsReview && x.status === "active",
      );
      return wait(
        p ? { status: "ok", data: p, stale: false, cachedAt: null } : { status: "not-found" },
      );
    },
    async getApplication(programId) {
      return wait(apps.get(programId) ?? null, 100);
    },
    async updateApplication(programId, update) {
      const p = programs.find((x) => x.id === programId);
      const a: Application = {
        programId,
        status: update.status,
        deadline: p?.deadline ?? null,
        tasks: [...update.tasks],
      };
      apps.set(programId, a);
      return wait(a, 150);
    },
  };
}

export function createHttpDashboardApi(idToken: () => Promise<string | null>): DashboardApi {
  const headers = async (): Promise<Record<string, string>> => {
    const t = await idToken();
    return { "Content-Type": "application/json", ...(t ? { Authorization: `Bearer ${t}` } : {}) };
  };
  return {
    async getDashboard(_household, _today, category) {
      // 世帯はサーバーが保存済みの情報から導出する
      const q = category ? `?category=${encodeURIComponent(category)}` : "";
      const res = await fetch(`${API_BASE}/dashboard${q}`, { headers: await headers() });
      if (!res.ok) return { programs: { ok: false }, applications: { ok: false } };
      return (await res.json()) as Dashboard;
    },
    async getProgram(id) {
      return fetchCached<Program>(`/programs/${encodeURIComponent(id)}`, {
        headers: await headers(),
      });
    },
    async getApplication(programId) {
      const res = await fetch(`${API_BASE}/applications/${encodeURIComponent(programId)}`, {
        headers: await headers(),
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET /applications ${res.status}`);
      return (await res.json()) as Application;
    },
    async updateApplication(programId, update) {
      const res = await fetch(`${API_BASE}/applications/${encodeURIComponent(programId)}`, {
        method: "PUT",
        headers: await headers(),
        body: JSON.stringify(update),
      });
      if (!res.ok) throw new Error(`PUT /applications ${res.status}`);
      return (await res.json()) as Application;
    },
  };
}
