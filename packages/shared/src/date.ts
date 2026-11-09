// 日付（YYYY-MM-DD）の共通処理。タイムゾーンの影響を受けないよう、暦日だけを扱う。

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export type CalendarDate = { readonly year: number; readonly month: number; readonly day: number };

/** うるう年を考慮した月の日数（month は 1〜12） */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `YYYY-MM-DD` を暦日に変換する。存在しない日付（2月30日など）は null */
export function parseIsoDate(value: string): CalendarDate | null {
  const m = ISO_DATE.exec(value);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  return { year, month, day };
}

export function isValidIsoDate(value: string): boolean {
  return parseIsoDate(value) !== null;
}

export function formatIsoDate(d: CalendarDate): string {
  return `${String(d.year).padStart(4, "0")}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` を表示用の `YYYY/MM/DD` にする */
export function toSlashDate(iso: string): string {
  return iso.replaceAll("-", "/");
}

/**
 * n か月後（n が負なら前）の同日。その日が存在しない月は月末に丸める。
 * 例: 2026-01-31 の1か月後は 2026-02-28
 */
export function addMonthsClamped(d: CalendarDate, months: number): CalendarDate {
  const index = d.year * 12 + (d.month - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return { year, month, day: Math.min(d.day, daysInMonth(year, month)) };
}

/** 暦日の差（b - a）を日数で返す */
export function diffDays(a: CalendarDate, b: CalendarDate): number {
  const ms = Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day);
  return Math.round(ms / 86_400_000);
}

export function addDays(d: CalendarDate, days: number): CalendarDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day) + days * 86_400_000);
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() };
}

/** 同じ形式の `YYYY-MM-DD` 文字列は辞書順が日付順と一致する */
export function compareIsoDate(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 日本時間（UTC+9）の今日を `YYYY-MM-DD` で返す */
export function todayJst(now: Date): string {
  const t = new Date(now.getTime() + 9 * 3_600_000);
  return formatIsoDate({
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
  });
}
