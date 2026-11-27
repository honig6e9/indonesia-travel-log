// やることの期間（予定日〜終了日）と「予定を過ぎた」の判定。
// 終了日が入っていない項目は、タイトルやメモの「12/4〜6」「12/26・27」「12/25〜1/5」から読み取る
// （取り込んだ原本のように、期間が文字で書かれているものに対応するため）。

import type { ChecklistItem } from '../../db/types';
import { shortDate } from '../../lib/dates';

export interface Period {
  start: string;
  end: string; // 1 日だけなら start と同じ
}

const pad = (n: number) => String(n).padStart(2, '0');

/** 文字から、予定日（start）で始まる期間の終わりを読む。読めなければ null */
export function endFromText(text: string, start: string): string | null {
  const [y, sm, sd] = start.split('-').map(Number);
  const re = /(\d{1,2})\/(\d{1,2})\s*(?:[〜~～\-－]|・)\s*(?:(\d{1,2})\/)?(\d{1,2})(?:\s*または\s*(\d{1,2}))?/g;
  for (const m of text.matchAll(re)) {
    if (Number(m[1]) !== sm || Number(m[2]) !== sd) continue;
    const em = m[3] ? Number(m[3]) : sm;
    const ed = Number(m[5] ?? m[4]);
    if (!(em >= 1 && em <= 12 && ed >= 1 && ed <= 31)) continue;
    const ey = em < sm ? y + 1 : y;
    const end = `${ey}-${pad(em)}-${pad(ed)}`;
    if (end > start) return end;
  }
  return null;
}

export function periodOf(item: ChecklistItem): Period | null {
  if (!item.plannedDate) return null;
  const start = item.plannedDate;
  const end = item.plannedEndDate && item.plannedEndDate >= start ? item.plannedEndDate : endFromText(`${item.title} ${item.note}`, start);
  return { start, end: end ?? start };
}

/** 選んだ日がその項目の予定（期間）に入るか */
export function isPlannedOn(item: ChecklistItem, date: string): boolean {
  const p = periodOf(item);
  return !!p && p.start <= date && date <= p.end;
}

/** チェックを付けずに、予定（期間の終わり）を過ぎた */
export function isOverdue(item: ChecklistItem, today: string): boolean {
  if (item.status !== 'open') return false;
  const p = periodOf(item);
  return !!p && p.end < today;
}

/** 表示用：12/4、12/4〜6、12/25〜1/5 */
export function formatPeriod(p: Period): string {
  if (p.end === p.start) return shortDate(p.start);
  const [, sm] = p.start.split('-');
  const [, em, ed] = p.end.split('-');
  return em === sm ? `${shortDate(p.start)}〜${Number(ed)}` : `${shortDate(p.start)}〜${shortDate(p.end)}`;
}

/** 時系列の並び：予定日（期間の始まり）→ 期間の終わり → 登録の並び。予定日のないものは最後に登録の並びで */
export function byPlanned(a: ChecklistItem, b: ChecklistItem): number {
  const pa = a.plannedDate ?? '';
  const pb = b.plannedDate ?? '';
  if (pa && !pb) return -1;
  if (!pa && pb) return 1;
  if (pa !== pb) return pa < pb ? -1 : 1;
  const ea = periodOf(a)?.end ?? '';
  const eb = periodOf(b)?.end ?? '';
  if (ea !== eb) return ea < eb ? -1 : 1;
  return a.sortOrder - b.sortOrder;
}
