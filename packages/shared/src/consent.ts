// 要配慮個人情報の同意と撤回（Requirement 2.6, 2.7, 9.1〜9.4）
// 同意がない要配慮情報は、保存ペイロードに一切入れない。

import type { ChildInput, HouseholdInput } from "./validation.js";

/** `users/{uid}/sensitive/profile` に保存する内容 */
export type SensitiveData = {
  readonly situationChips: readonly string[];
  readonly childNote?: string;
  readonly pregnancy?: { readonly dueDate: string };
};

/** `users/{uid}` の household に保存する、要配慮でない項目 */
export type NonSensitiveHousehold = {
  readonly postalCode: string;
  readonly children: readonly ChildInput[];
};

export type ConsentSplit = {
  readonly household: NonSensitiveHousehold;
  /** 同意がないときは null（要配慮情報を保存しない） */
  readonly sensitive: SensitiveData | null;
};

/**
 * 世帯入力を、要配慮でない項目と要配慮情報に分ける。
 * 同意がなければ状況チップ・自由記述・出産予定日を捨てる（Property 6）。
 */
export function splitByConsent(input: HouseholdInput, consent: boolean): ConsentSplit {
  const household: NonSensitiveHousehold = {
    postalCode: input.postalCode,
    children: input.children.map((c) =>
      c.ageMonths === undefined
        ? { ageYears: c.ageYears }
        : { ageYears: c.ageYears, ageMonths: c.ageMonths },
    ),
  };
  if (!consent) return { household, sensitive: null };
  const dueDate = input.dueDate === "" ? undefined : input.dueDate;
  const freeText = input.freeText === "" ? undefined : input.freeText;
  return {
    household,
    sensitive: {
      situationChips: [...(input.situationChips ?? [])],
      ...(freeText === undefined ? {} : { childNote: freeText }),
      ...(dueDate === undefined ? {} : { pregnancy: { dueDate } }),
    },
  };
}

/** 要配慮情報の保存状態 */
export type SensitiveState = {
  readonly consent: boolean;
  readonly sensitive: SensitiveData | null;
  /** 撤回時に削除が失敗した。再試行で成功するまで読み出しを拒否する */
  readonly sensitiveLocked: boolean;
};

/**
 * 同意の撤回を適用する。要配慮情報は空になり、同意は無くなる。
 * 削除に失敗したときは `sensitiveLocked` を立て、読み出しを止める（Property 50）。
 * 再試行で削除が成功すれば、ロックを外す。
 */
export function applyConsentWithdrawal(
  _state: SensitiveState,
  deletion: "succeeded" | "failed",
): SensitiveState {
  return { consent: false, sensitive: null, sensitiveLocked: deletion === "failed" };
}

/** 同意があり、ロックされていないときだけ要配慮情報を読み出せる */
export function canReadSensitive(state: SensitiveState): boolean {
  return state.consent && !state.sensitiveLocked;
}

/** 読み出してよい要配慮情報（読めないときは null） */
export function readSensitive(state: SensitiveState): SensitiveData | null {
  return canReadSensitive(state) ? state.sensitive : null;
}
