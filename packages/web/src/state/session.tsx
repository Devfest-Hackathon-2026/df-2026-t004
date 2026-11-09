// ログイン状態と世帯情報。認証が済むまで世帯データを読み込まない（Requirement 1.1）。

import type { ChildInput } from "@hachioji-gov/shared";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { readEnv } from "../lib/env";
import {
  createFirebaseAuth,
  createMockAuth,
  type AuthService,
  type AuthUser,
} from "../services/auth";
import {
  createHttpHouseholdApi,
  createMockHouseholdApi,
  type Household,
  type HouseholdApi,
} from "../services/householdApi";

/** オンボーディングの入力途中の値（画面を戻っても消えないように保持する） */
export type OnboardingDraft = {
  postalCode: string;
  /** 市外で「国の制度だけで続ける」を選んだ */
  nationalOnly: boolean;
  children: Array<{ mode: "years" | "months"; value: string }>;
  dueDate: string;
  situationChips: string[];
  freeText: string;
  sensitiveConsent: boolean;
  deferred: string[];
};

export const EMPTY_DRAFT: OnboardingDraft = {
  postalCode: "",
  nationalOnly: false,
  children: [{ mode: "years", value: "" }],
  dueDate: "",
  situationChips: [],
  freeText: "",
  sensitiveConsent: false,
  deferred: [],
};

export function draftChildren(d: OnboardingDraft): ChildInput[] {
  return d.children.map((c) =>
    c.mode === "months"
      ? { ageYears: 0, ageMonths: c.value === "" ? Number.NaN : Number(c.value) }
      : { ageYears: c.value === "" ? Number.NaN : Number(c.value) },
  );
}

type Session = {
  auth: AuthService;
  api: HouseholdApi;
  /** undefined は確認中 */
  user: AuthUser | null | undefined;
  /** undefined は読み込み中、null は未登録（オンボーディングが必要） */
  household: Household | null | undefined;
  setHousehold: (h: Household | null) => void;
  reloadHousehold: () => Promise<void>;
  draft: OnboardingDraft;
  setDraft: (f: (d: OnboardingDraft) => OnboardingDraft) => void;
};

const Ctx = createContext<Session | null>(null);

export function SessionProvider({
  children,
  auth: authOverride,
  api: apiOverride,
}: {
  children: ReactNode;
  auth?: AuthService;
  api?: HouseholdApi;
}) {
  const env = useMemo(() => readEnv(import.meta.env as Record<string, string | undefined>), []);
  const auth = useMemo(
    () => authOverride ?? (env.firebase ? createFirebaseAuth(env) : createMockAuth()),
    [authOverride, env],
  );
  const api = useMemo(
    () =>
      apiOverride ??
      (env.apiMode === "http"
        ? createHttpHouseholdApi(() => auth.idToken())
        : createMockHouseholdApi()),
    [apiOverride, env, auth],
  );
  const [user, setUser] = useState<AuthUser | null | undefined>(undefined);
  const [household, setHousehold] = useState<Household | null | undefined>(undefined);
  const [draft, setDraftState] = useState<OnboardingDraft>(EMPTY_DRAFT);

  useEffect(() => auth.onChange(setUser), [auth]);

  const reloadHousehold = useCallback(async () => {
    setHousehold(undefined);
    try {
      setHousehold(await api.getHousehold());
    } catch {
      setHousehold(null);
    }
  }, [api]);

  useEffect(() => {
    if (user) void reloadHousehold();
    else {
      setHousehold(undefined);
      setDraftState(EMPTY_DRAFT);
    }
  }, [user, reloadHousehold]);

  const value = useMemo<Session>(
    () => ({
      auth,
      api,
      user,
      household,
      setHousehold,
      reloadHousehold,
      draft,
      setDraft: (f) => setDraftState((d) => f(d)),
    }),
    [auth, api, user, household, reloadHousehold, draft],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error("SessionProvider がありません");
  return s;
}
