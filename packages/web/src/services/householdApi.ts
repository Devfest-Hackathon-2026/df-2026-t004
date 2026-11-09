// 世帯情報の API（GET/PUT /household、GET /postal/:code、POST /consents/*）
// 本物の API（T20）ができるまでは、ブラウザ内の仮実装（mock）で画面を動かす。

import {
  SAMPLE_POSTAL_TABLE,
  classifyPostalCode,
  splitByConsent,
  validateHouseholdInput,
  type ChildInput,
  type FieldError,
  type PostalClassification,
  type SensitiveData,
  type StoredChild,
} from "@hachioji-gov/shared";
import { API_BASE } from "../lib/api";

export type Household = {
  readonly postalCode: string;
  readonly municipalityCode: string;
  readonly prefecture: string;
  readonly city: string;
  readonly town: string;
  readonly children: readonly StoredChild[];
  /** 「あとで入力する」を選んだ項目 */
  readonly onboardingDeferred: readonly string[];
  readonly sensitiveConsent: boolean;
  /** 同意があるときだけ返る */
  readonly sensitive: SensitiveData | null;
};

export type SaveHouseholdInput = {
  readonly postalCode: string;
  readonly children: readonly ChildInput[];
  readonly dueDate?: string;
  readonly situationChips?: readonly string[];
  readonly freeText?: string;
  readonly sensitiveConsent: boolean;
  readonly onboardingDeferred: readonly string[];
};

export type SaveResult =
  | { readonly ok: true; readonly household: Household }
  | { readonly ok: false; readonly errors: readonly FieldError[] };

export interface HouseholdApi {
  getHousehold(): Promise<Household | null>;
  lookupPostal(code: string): Promise<PostalClassification>;
  saveHousehold(input: SaveHouseholdInput, today: string): Promise<SaveResult>;
  recordTermsConsent(version: string): Promise<void>;
}

/** ブラウザ内の仮実装。保存は検証と同意による分離（splitByConsent）を本物と同じ関数で行う */
export function createMockHouseholdApi(): HouseholdApi {
  let saved: Household | null = null;
  const wait = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 250));
  return {
    getHousehold: () => wait(saved),
    lookupPostal: (code) => wait(classifyPostalCode(code, SAMPLE_POSTAL_TABLE)),
    async saveHousehold(input, today) {
      const check = validateHouseholdInput(input, today, SAMPLE_POSTAL_TABLE);
      if (!check.ok) return wait({ ok: false, errors: check.errors });
      const postal = classifyPostalCode(input.postalCode, SAMPLE_POSTAL_TABLE);
      if (postal.kind !== "hachioji" && postal.kind !== "outside")
        return wait({
          ok: false,
          errors: [{ field: "postalCode", message: "郵便番号を確認してください" }],
        });
      const split = splitByConsent(input, input.sensitiveConsent);
      saved = {
        postalCode: postal.postalCode,
        ...postal.entry,
        children: split.household.children.map((c, i) => ({
          ...c,
          id: `c${i + 1}`,
          recordedAt: today,
        })),
        onboardingDeferred: [...input.onboardingDeferred],
        sensitiveConsent: input.sensitiveConsent,
        sensitive: split.sensitive,
      };
      return wait({ ok: true, household: saved });
    },
    recordTermsConsent: () => wait(undefined),
  };
}

/** 本物の API。ID トークンを Authorization ヘッダーに付ける */
export function createHttpHouseholdApi(idToken: () => Promise<string | null>): HouseholdApi {
  const call = async (path: string, init: RequestInit = {}) => {
    const token = await idToken();
    return fetch(`${API_BASE}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  };
  return {
    async getHousehold() {
      const res = await call("/household");
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GET /household ${res.status}`);
      return (await res.json()) as Household;
    },
    async lookupPostal(code) {
      const res = await call(`/postal/${encodeURIComponent(code)}`);
      if (!res.ok) throw new Error(`GET /postal ${res.status}`);
      return (await res.json()) as PostalClassification;
    },
    async saveHousehold(input) {
      const res = await call("/household", { method: "PUT", body: JSON.stringify(input) });
      if (res.status === 400)
        return { ok: false, errors: ((await res.json()) as { errors: FieldError[] }).errors };
      if (!res.ok) throw new Error(`PUT /household ${res.status}`);
      return { ok: true, household: (await res.json()) as Household };
    },
    async recordTermsConsent(version) {
      const res = await call("/consents/terms", {
        method: "POST",
        body: JSON.stringify({ version }),
      });
      if (!res.ok) throw new Error(`POST /consents/terms ${res.status}`);
    },
  };
}
