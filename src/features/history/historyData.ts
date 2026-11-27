import { TYPE_TEXT } from '../checklist/checklistRepo';
import type { TravelDB } from '../../db/db';
import { alive } from '../../db/repo';
import type {
  Answer,
  AudioClip,
  ChecklistItem,
  DailyLog,
  Expense,
  FoodExperience,
  Media,
  Note,
  Trip,
} from '../../db/types';
import { dateRange } from '../../lib/dates';

export interface TripData {
  logs: DailyLog[];
  answers: Answer[];
  clips: AudioClip[];
  items: ChecklistItem[];
  exps: FoodExperience[];
  notes: Note[];
  expenses: Expense[];
  media: Media[];
}

export async function loadTripData(db: TravelDB, tripId: string): Promise<TripData> {
  const by = async <T>(t: string) => alive((await db.table(t).where('tripId').equals(tripId).toArray()) as (T & { deletedAt?: string | null })[]);
  return {
    logs: await by<DailyLog>('dailyLogs'),
    answers: await by<Answer>('answers'),
    clips: await by<AudioClip>('audioClips'),
    items: await by<ChecklistItem>('checklistItems'),
    exps: await by<FoodExperience>('foodExperiences'),
    notes: await by<Note>('notes'),
    expenses: await by<Expense>('expenses'),
    media: await by<Media>('media'),
  };
}

export interface DaySummary {
  date: string;
  answered: number;
  clips: number;
  notes: number;
  photos: number;
  tasksDone: number;
  foodsEaten: number;
  expenses: number;
}

export function summarizeDays(trip: Trip, d: TripData): DaySummary[] {
  const map = new Map<string, DaySummary>();
  const get = (date: string) => {
    let s = map.get(date);
    if (!s) {
      s = { date, answered: 0, clips: 0, notes: 0, photos: 0, tasksDone: 0, foodsEaten: 0, expenses: 0 };
      map.set(date, s);
    }
    return s;
  };
  for (const day of dateRange(trip.startDate, trip.endDate)) get(day);
  const logDate = new Map(d.logs.map((l) => [l.id, l.localDate]));
  const answeredKeys = new Set<string>();
  for (const c of d.clips) {
    get(c.localDate).clips++;
    if (c.questionId) answeredKeys.add(`${c.dailyLogId}:${c.questionId}`);
  }
  for (const a of d.answers) if (a.note.trim()) answeredKeys.add(`${a.dailyLogId}:${a.questionId}`);
  for (const k of answeredKeys) {
    const date = logDate.get(k.split(':')[0]);
    if (date) get(date).answered++;
  }
  for (const n of d.notes) get(n.localDate).notes++;
  for (const m of d.media) get(m.localDate).photos++;
  for (const i of d.items) if (i.type === 'task' && i.status === 'done' && i.completedDate) get(i.completedDate).tasksDone++;
  for (const e of d.exps) get(e.localDate).foodsEaten++;
  for (const e of d.expenses) get(e.localDate).expenses++;
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface SearchHit {
  kind: string;
  date: string | null;
  text: string;
  go: string; // 遷移先
}

/** 文字・タグ検索。音声の中身は文字起こしがない限り検索できない（質問文・補足・タグが対象） */
export function search(d: TripData, keyword: string, tag: string): SearchHit[] {
  const kw = keyword.trim().toLowerCase();
  const tg = tag.trim().replace(/^#/, '');
  const has = (...s: (string | null | undefined)[]) => !kw || s.some((x) => x?.toLowerCase().includes(kw));
  const tagged = (tags: string[] | undefined) => !tg || (tags ?? []).includes(tg);
  const hits: SearchHit[] = [];
  const logById = new Map(d.logs.map((l) => [l.id, l]));
  for (const a of d.answers) {
    const log = logById.get(a.dailyLogId);
    const q = log?.questionSnapshots.find((x) => x.questionId === a.questionId);
    if (has(a.note, q?.title, ...a.tags) && tagged(a.tags) && (a.note || a.tags.length || kw))
      hits.push({ kind: '音声日記', date: log?.localDate ?? null, text: `${q?.title ?? a.questionId}${a.note ? '：' + a.note : ''}`, go: `day/${log?.localDate}` });
  }
  if (kw && !tg) {
    for (const l of d.logs)
      for (const q of l.questionSnapshots)
        if (q.title.toLowerCase().includes(kw) && !hits.some((h) => h.date === l.localDate && h.text.startsWith(q.title)))
          hits.push({ kind: '質問', date: l.localDate, text: q.title, go: `day/${l.localDate}` });
  }
  for (const n of d.notes) if (has(n.body, n.location, n.category, ...n.tags) && tagged(n.tags)) hits.push({ kind: 'メモ', date: n.localDate, text: n.body, go: `day/${n.localDate}` });
  if (!tg) {
    for (const i of d.items) if (has(i.title, i.localName, i.area, i.note)) hits.push({ kind: TYPE_TEXT[i.type].name, date: i.completedDate ?? i.plannedDate ?? null, text: i.title, go: `item/${i.id}` });
    for (const e of d.exps) if (has(e.shop, e.comment)) hits.push({ kind: '実食', date: e.localDate, text: `${e.shop} ${e.comment}`, go: `item/${e.checklistItemId}` });
    for (const e of d.expenses) if (has(e.shop, e.note, e.category)) hits.push({ kind: '支出', date: e.localDate, text: `${e.category} ${e.shop} ${e.note}`, go: `day/${e.localDate}` });
  }
  for (const m of d.media) if (has(m.caption, m.category, ...m.tags) && tagged(m.tags)) hits.push({ kind: '写真', date: m.localDate, text: m.caption || '（説明なし）', go: `day/${m.localDate}` });
  return hits.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '')).slice(0, 300);
}

export function allTags(d: TripData): string[] {
  return [...new Set([...d.notes.flatMap((n) => n.tags), ...d.answers.flatMap((a) => a.tags), ...d.media.flatMap((m) => m.tags)])].sort();
}

// ---------- 位置の履歴 ----------

export interface LocationEntry {
  key: string;
  /** 記録した時刻（分からなければ null） */
  at: string | null;
  localDate: string;
  kind: 'note' | 'expense' | 'food' | 'place' | 'task';
  label: string;
  location: string;
  lat: number;
  lng: number;
  /** 開く画面 */
  go: string;
}

const COORD_RE = /(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)/;

export function parseCoord(location: string | null | undefined): { lat: number; lng: number } | null {
  const m = location?.match(COORD_RE);
  return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
}

/** 場所（座標）が入っている記録を、日ごと・時刻の順に集める（新しい日が先、日の中は時刻の順） */
export function locationHistory(d: TripData, localDateOf: (iso: string) => string): LocationEntry[] {
  const out: LocationEntry[] = [];
  const push = (e: Omit<LocationEntry, 'lat' | 'lng'>) => {
    const c = parseCoord(e.location);
    if (c) out.push({ ...e, ...c });
  };
  const itemById = new Map(d.items.map((i) => [i.id, i]));
  for (const n of d.notes) {
    if (!n.location) continue;
    // 「📍 現在地（12:30）」の行は時刻と重なるので省き、メモの中身だけを出す
    const lines = n.body.split('\n').filter(Boolean);
    const head = !!lines[0] && /^📍 (現在地|場所なし)（\d{1,2}:\d{2}）$/u.test(lines[0]);
    const label = (head ? lines.slice(1) : lines).join(' ').slice(0, 80) || (head ? '現在地' : 'メモ');
    push({ key: 'n:' + n.id, at: n.createdAt || null, localDate: n.localDate, kind: 'note', label, location: n.location, go: `day/${n.localDate}` });
  }
  for (const e of d.expenses) {
    if (!e.location) continue;
    const what = [e.shop, e.category].filter(Boolean).join('・');
    push({ key: 'x:' + e.id, at: e.createdAt || null, localDate: e.localDate, kind: 'expense', label: `${what || '支出'} ${e.amount.toLocaleString('ja-JP')} ${e.currency}`, location: e.location, go: `day/${e.localDate}` });
  }
  const expLocs = new Set<string>();
  for (const x of d.exps) {
    if (!x.location) continue;
    expLocs.add(`${x.checklistItemId}|${x.location}`);
    const title = itemById.get(x.checklistItemId)?.title ?? '実食';
    push({ key: 'f:' + x.id, at: x.createdAt || null, localDate: x.localDate, kind: 'food', label: [title, x.shop].filter(Boolean).join(' @ '), location: x.location, go: `item/${x.checklistItemId}` });
  }
  for (const i of d.items) {
    if (!i.location || expLocs.has(`${i.id}|${i.location}`)) continue; // 実食と同じ場所は 1 つにする
    const at = i.locatedAt ?? null;
    const localDate = at ? localDateOf(at) : (i.completedDate ?? (i.updatedAt ? localDateOf(i.updatedAt) : ''));
    if (!localDate) continue;
    push({ key: 'i:' + i.id, at, localDate, kind: i.type === 'place' ? 'place' : i.type === 'food' ? 'food' : 'task', label: i.title, location: i.location, go: `item/${i.id}` });
  }
  return out.sort((a, b) => (a.localDate !== b.localDate ? (a.localDate < b.localDate ? 1 : -1) : (a.at ?? '￿').localeCompare(b.at ?? '￿')));
}

/** その日の地点を時刻の順にたどる Google マップの経路（地点は 10 個まで） */
export function routeUrl(entries: LocationEntry[]): string | null {
  const pts = entries.map((e) => `${e.lat},${e.lng}`).filter((p, i, a) => i === 0 || p !== a[i - 1]);
  if (pts.length === 0) return null;
  if (pts.length === 1) return `https://www.google.com/maps/search/?api=1&query=${pts[0]}`;
  return `https://www.google.com/maps/dir/${pts.slice(0, 10).join('/')}`;
}
