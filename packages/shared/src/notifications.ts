// 締切の通知の計画と取消（Requirement 7.1, 7.6。優先度「できれば」）

import { addDays, formatIsoDate, parseIsoDate } from "./date.js";

export type NotificationKind = "deadline_7d" | "deadline_1d";

export type NotificationTime = {
  readonly kind: NotificationKind;
  /** 送信日（YYYY-MM-DD、日本時間） */
  readonly date: string;
  /** 送信時刻（ISO 8601、UTC）。日本時間の sendHourJst 時 */
  readonly at: string;
};

export const NOTIFY_HOUR_JST = 9;

/** 締切の7日前と1日前の2つの送信時刻（日本時間の9時）を返す。締切が不正なら空 */
export function notificationTimes(
  deadline: string,
  sendHourJst: number = NOTIFY_HOUR_JST,
): NotificationTime[] {
  const d = parseIsoDate(deadline);
  if (!d) return [];
  const plan: Array<[NotificationKind, number]> = [
    ["deadline_7d", -7],
    ["deadline_1d", -1],
  ];
  return plan.map(([kind, offset]) => {
    const day = addDays(d, offset);
    const at = new Date(Date.UTC(day.year, day.month - 1, day.day, sendHourJst - 9)).toISOString();
    return { kind, date: formatIsoDate(day), at };
  });
}

export type QueuedNotification = {
  readonly id: string;
  /** 申請（= 制度）の id */
  readonly programId: string;
  readonly kind: NotificationKind;
  readonly at: string;
  /** 通知に含める制度名と締切日 */
  readonly programName: string;
  readonly deadline: string;
};

/** 申請1件分の通知をキューに入れる形にする */
export function planNotifications(
  programId: string,
  programName: string,
  deadline: string,
): QueuedNotification[] {
  return notificationTimes(deadline).map((t) => ({
    id: `${programId}:${t.kind}`,
    programId,
    kind: t.kind,
    at: t.at,
    programName,
    deadline,
  }));
}

/** 申請の完了・制度の削除で、その申請の保留中の通知をすべて取り消す（他は変えない） */
export function cancelFor(
  queue: readonly QueuedNotification[],
  programId: string,
): QueuedNotification[] {
  return queue.filter((n) => n.programId !== programId);
}
