// 日付ユーティリティ。記録対象日（localDate）は YYYY-MM-DD の文字列として扱い、
// 端末のタイムゾーンに左右されないよう、暦日の計算は UTC の 0 時で行う。

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(s: unknown): s is string {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** 指定タイムゾーンでの今日の日付 */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** 指定タイムゾーンでの時刻 HH:mm */
export function timeIn(timeZone: string, iso: string): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return '';
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function toDays(localDate: string): number {
  return Math.round(Date.parse(localDate + 'T00:00:00Z') / 86400000);
}

export function addDays(localDate: string, n: number): string {
  return new Date((toDays(localDate) + n) * 86400000).toISOString().slice(0, 10);
}

export function diffDays(a: string, b: string): number {
  return toDays(a) - toDays(b);
}

export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

const WEEKDAYS = ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'];

export function weekdayJa(localDate: string): string {
  return WEEKDAYS[new Date(localDate + 'T00:00:00Z').getUTCDay()];
}

export function shortDate(localDate: string): string {
  const [, m, d] = localDate.split('-');
  return `${Number(m)}/${Number(d)}`;
}

export interface DayLabel {
  kind: 'before' | 'during' | 'after';
  day: number; // 期間中のみ意味を持つ（1 始まり）
  total: number;
  label: string;
}

/** DAY 番号：開始日を DAY 01 とした暦日差。期間外は「出発前」「帰国後」 */
export function dayLabel(localDate: string, startDate: string, endDate: string): DayLabel {
  const total = diffDays(endDate, startDate) + 1;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (localDate < startDate) {
    const n = diffDays(startDate, localDate);
    return { kind: 'before', day: 0, total, label: `出発前（${n}日前）` };
  }
  if (localDate > endDate) {
    const n = diffDays(localDate, endDate);
    return { kind: 'after', day: 0, total, label: `帰国後（${n}日後）` };
  }
  const day = diffDays(localDate, startDate) + 1;
  return { kind: 'during', day, total, label: `DAY ${pad(day)}/${pad(total)}` };
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** ファイル名用 YYYY-MM-DD_HHmm（旅行タイムゾーン） */
export function stampIn(timeZone: string, now: Date = new Date()): string {
  const d = todayIn(timeZone, now);
  const t = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false })
    .format(now)
    .replace(':', '');
  return `${d}_${t}`;
}
