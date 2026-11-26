// PC で手動起動した WhatsApp 取り込み（worker/whatsapp_importer.py）との通信。
// 127.0.0.1 だけで待ち受けるので、PC のブラウザでアプリを開いたときだけ使える。

export const DEFAULT_IMPORTER_URL = 'http://127.0.0.1:8787';
const URL_KEY = 'itl-wa-importer-url';

export function importerUrl(): string {
  return localStorage.getItem(URL_KEY) || DEFAULT_IMPORTER_URL;
}
export function setImporterUrl(u: string) {
  if (u.trim()) localStorage.setItem(URL_KEY, u.trim().replace(/\/+$/, ''));
  else localStorage.removeItem(URL_KEY);
}

export type WaCategory =
  | 'task'
  | 'food'
  | 'restaurant'
  | 'place'
  | 'sightseeing'
  | 'meetup'
  | 'schedule'
  | 'shopping'
  | 'souvenir'
  | 'note_idea'
  | 'research'
  | 'language'
  | 'change';

export const WA_CATEGORY_LABEL: Record<WaCategory, string> = {
  task: 'やること',
  food: '食べたい料理',
  restaurant: '飲食店',
  place: '行きたい場所',
  sightseeing: '観光地',
  meetup: '会う約束',
  schedule: '日程調整',
  shopping: '買い物',
  souvenir: 'お土産',
  note_idea: 'note 記事ネタ',
  research: '現地調査事項',
  language: 'インドネシア語学習メモ',
  change: '既存予定の変更・中止',
};
export const WA_CATEGORIES = Object.keys(WA_CATEGORY_LABEL) as WaCategory[];

export const WA_STATUS_LABEL: Record<string, string> = {
  proposal: '提案',
  wish: '希望',
  scheduling: '日程調整中',
  agreed: '合意済み',
  done: '実施済み',
  negated: '取りやめ',
};
export const WA_ACTION_LABEL: Record<string, string> = { new: '新規', append: '追記', change: '変更', cancel: '中止' };

export interface WaCandidate {
  id: string;
  category: WaCategory;
  title_ja: string;
  name_id: string | null;
  description: string;
  place: string | null;
  shop: string | null;
  price_idr: number | null;
  datetime_text: string | null;
  date: string | null;
  url: string | null;
  translation_ja: string | null;
  /** 提案・希望・調整中・合意など（AI の判定） */
  certainty: string;
  /** レビューの状態 */
  status: 'pending' | 'held' | 'registered' | 'rejected';
  action: string;
  source_message_ids: string[];
  chat_id: string;
  chat_title: string;
  partner: string;
  message_at: string | null;
  key: string;
}
export type CandidateDecision = 'registered' | 'rejected' | 'held' | 'pending';

export interface WaChat {
  chat_id: string;
  title: string;
  group: boolean;
  in_range: number;
  unanalyzed: number;
  last_at: string | null;
  error?: string | null;
}

export interface WaJob {
  id: string;
  state: 'running' | 'done' | 'cancelled' | 'failed';
  files: number;
  target: number;
  analyzed: number;
  percent: number;
  elapsed_sec: number;
  eta_sec: number | null;
  candidates: number;
  duplicates: number;
  errors: number;
  dropped: number;
  windows_total: number;
  windows_done: number;
  message: string;
  cancelling?: boolean;
}

export interface WaHistory extends Omit<WaJob, 'percent' | 'eta_sec' | 'dropped' | 'windows_total' | 'windows_done'> {
  started_at: string;
  model: string;
  params: { from?: string; to?: string; label?: string; chat_ids?: string[] };
}

export interface WaConfig {
  log_folder: string;
  llm: { api: 'ollama' | 'openai'; base_url: string; model: string };
}

export interface WaContextMessage {
  id: string;
  at: string;
  from: string;
  text: string;
  source: boolean;
}

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(importerUrl() + path, {
      method: init?.method ?? 'GET',
      headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new Error('PC の取り込みプログラムにつながりません');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `エラー（${res.status}）`);
  return data as T;
}

export const waApi = {
  health: () => call<{ ok: boolean; version: string }>('/health'),
  config: () => call<{ config: WaConfig; models: string[]; data_dir: string }>('/config'),
  saveConfig: (patch: Partial<{ log_folder: string; llm: Partial<WaConfig['llm']> }>) => call<{ config: WaConfig }>('/config', { method: 'POST', body: patch }),
  chats: (from?: string, to?: string) => {
    const q = new URLSearchParams();
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    return call<{ root: string; files: number; chats: WaChat[] }>('/chats?' + q.toString());
  },
  analyze: (p: { from?: string; to?: string; chat_ids: string[]; categories: WaCategory[]; exclude_analyzed: boolean; force: boolean; label: string }) =>
    call<{ job: WaJob }>('/analyze', { method: 'POST', body: p }),
  job: () => call<{ job: WaJob | null }>('/job'),
  cancel: () => call<{ job: WaJob | null }>('/job/cancel', { method: 'POST', body: {} }),
  candidates: (status = 'pending,held') => call<{ candidates: WaCandidate[] }>('/candidates?status=' + status),
  update: (id: string, patch: Partial<WaCandidate>) => call('/candidates/update', { method: 'POST', body: { id, patch } }),
  decide: (ids: string[], decision: CandidateDecision) => call<{ updated: number }>('/candidates/decide', { method: 'POST', body: { ids, decision } }),
  context: (id: string) => call<{ messages: WaContextMessage[]; note?: string }>('/context?id=' + encodeURIComponent(id)),
  history: () => call<{ history: WaHistory[] }>('/history'),
};

// ---------- 期間 ----------

export type RangeKey = 'today' | 'yesterday' | '7d' | '30d' | '90d' | 'all' | 'custom';
export const RANGE_LABEL: Record<RangeKey, string> = {
  today: '今日',
  yesterday: '昨日',
  '7d': '過去 7 日間',
  '30d': '過去 30 日間',
  '90d': '過去 90 日間',
  all: '全期間',
  custom: '日付を指定',
};

/** 期間を、旅行のタイムゾーンの日付の境目で ISO の範囲にする（to は含まない） */
export function rangeToIso(key: RangeKey, today: string, offset: string, custom?: { from: string; to: string }): { from?: string; to?: string } {
  const at = (d: string) => `${d}T00:00:00${offset}`;
  const add = (d: string, n: number) => {
    const x = new Date(d + 'T00:00:00Z');
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };
  switch (key) {
    case 'today':
      return { from: at(today), to: at(add(today, 1)) };
    case 'yesterday':
      return { from: at(add(today, -1)), to: at(today) };
    case '7d':
      return { from: at(add(today, -6)), to: at(add(today, 1)) };
    case '30d':
      return { from: at(add(today, -29)), to: at(add(today, 1)) };
    case '90d':
      return { from: at(add(today, -89)), to: at(add(today, 1)) };
    case 'custom':
      return { from: custom?.from ? at(custom.from) : undefined, to: custom?.to ? at(add(custom.to, 1)) : undefined };
    default:
      return {};
  }
}

/** タイムゾーンの UTC からのずれ（+07:00 など） */
export function tzOffset(timeZone: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' }).formatToParts(now);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+00:00';
  const m = name.match(/GMT([+-]\d{2}):?(\d{2})?/);
  return m ? `${m[1]}:${m[2] ?? '00'}` : '+00:00';
}
