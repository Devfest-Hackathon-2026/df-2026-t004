import { deriveAgeBands, type MatchHousehold } from "@hachioji-gov/shared";
import type { Household } from "../services/householdApi";

/** 保存済みの世帯情報から、制度の候補判定に使う属性（自治体と年齢区分）を作る */
export function toMatchHousehold(h: Household, today: string): MatchHousehold {
  return {
    municipalityCode: h.municipalityCode,
    ageBands: deriveAgeBands(h.children, h.sensitive?.pregnancy ?? null, h.sensitiveConsent, today),
  };
}
