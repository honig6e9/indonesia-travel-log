// 通訳：音声（または文字）を Supabase の受付に積み、家の PC が訳した結果を受け取る。
// 音声と結果は端末にも保存する（interpretations テーブル）。

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TravelDB } from '../../db/db';
import type { Interpretation } from '../../db/types';
import { BUCKET } from '../sync/supabaseTransport';

export type Mode = Interpretation['mode'];

/** この時間より前に応答した PC は「応答なし」とみなす */
export const WORKER_STALE_MS = 90_000;
/** 受付からこの時間たっても処理が始まらなければ、代わりの方法を出す */
export const WAIT_FALLBACK_MS = 40_000;

export interface WorkerState {
  lastSeen: string | null;
  online: boolean;
}

interface JobRow {
  id: string;
  created_at: string;
  mode: Mode;
  audio_path: string | null;
  input_text: string | null;
  status: Interpretation['status'];
  source_lang: string | null;
  source_text: string | null;
  target_lang: string | null;
  target_text: string | null;
  reading: string | null;
  provider: string | null;
  error: string | null;
}

function fromJob(j: JobRow): Partial<Interpretation> {
  return {
    status: j.status,
    sourceLang: j.source_lang,
    sourceText: j.source_text ?? j.input_text,
    targetLang: j.target_lang,
    targetText: j.target_text,
    reading: j.reading,
    provider: j.provider,
    error: j.status === 'error' ? j.error : null,
  };
}

export async function workerState(sb: SupabaseClient): Promise<WorkerState> {
  const { data, error } = await sb.from('interpret_worker').select('last_seen').order('last_seen', { ascending: false }).limit(1);
  if (error) throw error;
  const lastSeen = (data?.[0]?.last_seen as string | undefined) ?? null;
  return { lastSeen, online: !!lastSeen && Date.now() - Date.parse(lastSeen) < WORKER_STALE_MS };
}

/** 未送信の 1 件を送る（音声のアップロード → 受付）。同じ ID の再送は安全 */
export async function submit(db: TravelDB, sb: SupabaseClient, ownerId: string, deviceId: string, item: Interpretation) {
  // スマホで文字にしたものは、録音も一緒に送る。家の PC が録音で話した言語を確かめ、
  // スマホの聞き取りと言語が違えば文字にし直す。録音を送れなければ文字だけで受付に出す
  if (item.inputText) {
    let path: string | null = item.audioPath ?? null;
    if (item.audio && !path) {
      try {
        await uploadAudio(db, sb, ownerId, item);
        path = `${ownerId}/interpret/${item.id}.${item.ext || 'webm'}`;
      } catch {
        path = null;
      }
    }
    const { error } = await sb.rpc('interpret_enqueue', {
      p_id: item.id,
      p_audio_path: path,
      p_input_text: item.inputText,
      p_mode: item.mode,
      p_device_id: deviceId,
    });
    if (error) throw error;
    await db.interpretations.update(item.id, { status: 'queued', via: 'pc' });
    if (item.audio && !path) void uploadAudio(db, sb, ownerId, item).catch(() => undefined);
    return;
  }
  let audioPath = item.audioPath ?? null;
  if (item.audio && !audioPath) {
    const path = `${ownerId}/interpret/${item.id}.${item.ext || 'webm'}`;
    const { error } = await sb.storage.from(BUCKET).upload(path, item.audio, { contentType: item.mimeType || 'audio/webm', upsert: false });
    if (error && !/already exists|Duplicate/i.test(error.message) && String((error as { statusCode?: string }).statusCode) !== '409') throw error;
    audioPath = path;
    await db.interpretations.update(item.id, { audioPath });
  }
  const { error } = await sb.rpc('interpret_enqueue', {
    p_id: item.id,
    p_audio_path: audioPath,
    p_input_text: item.inputText ?? null,
    p_mode: item.mode,
    p_device_id: deviceId,
  });
  if (error) throw error;
  await db.interpretations.update(item.id, { status: 'queued', via: 'pc' });
}

/** 録音を保存用に送る（訳には使わない。家の PC があとで取り寄せる） */
export async function uploadAudio(db: TravelDB, sb: SupabaseClient, ownerId: string, item: Interpretation) {
  if (!item.audio || item.audioPath) return;
  const path = `${ownerId}/interpret/${item.id}.${item.ext || 'webm'}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, item.audio, { contentType: item.mimeType || 'audio/webm', upsert: false });
  if (error && !/already exists|Duplicate/i.test(error.message) && String((error as { statusCode?: string }).statusCode) !== '409') throw error;
  await db.interpretations.update(item.id, { audioPath: path });
}

/** 送信待ちと処理中のものの状態を Supabase から取り込む */
export async function refresh(db: TravelDB, sb: SupabaseClient, ids?: string[]) {
  const pending = ids ?? (await db.interpretations.where('status').anyOf('queued', 'processing').primaryKeys());
  if (pending.length === 0) return;
  const { data, error } = await sb.from('interpret_jobs').select('*').in('id', pending as string[]);
  if (error) throw error;
  await db.transaction('rw', db.interpretations, async () => {
    for (const j of (data ?? []) as JobRow[]) {
      const cur = await db.interpretations.get(j.id);
      if (cur && cur.via !== 'google') await db.interpretations.update(j.id, fromJob(j));
    }
  });
}

/** ほかの端末から送った通訳も含め、最近の履歴を取り込む（音声は必要なときに取得） */
export async function pullHistory(db: TravelDB, sb: SupabaseClient) {
  const { data, error } = await sb.from('interpret_jobs').select('*').order('created_at', { ascending: false }).limit(100);
  if (error) throw error;
  await db.transaction('rw', db.interpretations, async () => {
    for (const j of (data ?? []) as JobRow[]) {
      const cur = await db.interpretations.get(j.id);
      if (cur) {
        if (cur.via !== 'google' && cur.status !== 'done') await db.interpretations.update(j.id, fromJob(j));
      } else {
        await db.interpretations.put({
          id: j.id,
          createdAt: j.created_at,
          mode: j.mode,
          audioPath: j.audio_path,
          inputText: j.input_text,
          via: 'pc',
          ...fromJob(j),
          status: j.status,
        });
      }
    }
  });
}

export async function fetchAudio(db: TravelDB, sb: SupabaseClient, item: Interpretation): Promise<Blob> {
  if (item.audio) return item.audio;
  if (!item.audioPath) throw new Error('音声がありません');
  const { data, error } = await sb.storage.from(BUCKET).download(item.audioPath);
  if (error || !data) throw error ?? new Error('取得できませんでした');
  await db.interpretations.update(item.id, { audio: data });
  return data;
}

// ---------- 代わりの方法（家の PC につながらないとき） ----------

type Recognition = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

export function speechRecognitionAvailable(): boolean {
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
}

/** Chrome の音声認識で 1 回だけ聞き取る（通信が必要。音声は Google に送られる） */
export function recognizeOnce(lang: 'ja' | 'id'): { promise: Promise<string>; stop: () => void } {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) return { promise: Promise.reject(new Error('この端末では音声認識が使えません')), stop: () => undefined };
  const rec = new Ctor();
  rec.lang = lang === 'ja' ? 'ja-JP' : 'id-ID';
  rec.interimResults = false;
  rec.maxAlternatives = 1;
  const promise = new Promise<string>((resolve, reject) => {
    let text = '';
    rec.onresult = (e) => {
      text = Array.from(e.results)
        .map((r) => r[0]?.transcript ?? '')
        .join('');
    };
    rec.onerror = (e) => reject(new Error(e.error === 'network' ? '通信できません' : e.error === 'not-allowed' ? 'マイクが許可されていません' : `音声認識のエラー（${e.error}）`));
    rec.onend = () => (text ? resolve(text) : reject(new Error('聞き取れませんでした')));
  });
  rec.start();
  return { promise, stop: () => rec.stop() };
}

export interface LiveRecognition {
  /** 止めて、聞き取れた文を返す（何も聞き取れなければ空文字） */
  stop: () => Promise<string>;
  /** 音声認識のエラーの種類（audio-capture＝マイクの取り合い など）。なければ null */
  error: () => string | null;
  /** 音声認識が使えなかった（マイクの取り合いなど） */
  failed: () => boolean;
}

/**
 * 話している間から文字にする（Chrome の音声認識。音声は Google に送られる。通信が必要）。
 * onText には途中経過を含めた全文を渡す。話し終えて認識が自然に終わったら onEnd を呼ぶ。
 */
export function startLiveRecognition(lang: 'ja' | 'id', onText: (text: string, settled: boolean) => void, onEnd: () => void): LiveRecognition | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition & { continuous: boolean }; webkitSpeechRecognition?: new () => Recognition & { continuous: boolean } };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = lang === 'ja' ? 'ja-JP' : 'id-ID';
  rec.continuous = true;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  let finalText = '';
  let interim = '';
  let failed = false;
  let stopping = false;
  let ended = false;
  let resolveStop: ((t: string) => void) | null = null;
  const current = () => (finalText + interim).trim();
  rec.onresult = (e) => {
    const results = e.results as unknown as ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
    let fin = '';
    let mid = '';
    for (const r of Array.from(results)) {
      if (r.isFinal) fin += r[0]?.transcript ?? '';
      else mid += r[0]?.transcript ?? '';
    }
    finalText = fin;
    interim = mid;
    // settled：途中の文がなく、確定した文だけになった
    onText(current(), !mid.trim());
  };
  let lastError: string | null = null;
  rec.onerror = (e) => {
    lastError = e.error;
    if (e.error !== 'no-speech') failed = true;
  };
  rec.onend = () => {
    ended = true;
    if (resolveStop) resolveStop(current());
    else if (!stopping) onEnd();
  };
  try {
    rec.start();
  } catch {
    return null;
  }
  return {
    failed: () => failed,
    error: () => lastError,
    stop: () =>
      new Promise<string>((resolve) => {
        stopping = true;
        if (ended) return resolve(current());
        resolveStop = resolve;
        try {
          rec.stop();
        } catch {
          resolve(current());
        }
        // 終わりの合図が来ない端末もあるので、少し待って打ち切る
        setTimeout(() => resolve(current()), 1500);
      }),
  };
}

export function googleTranslateUrl(text: string, from: 'ja' | 'id' | 'auto', to: 'ja' | 'id') {
  const p = new URLSearchParams({ sl: from, tl: to, text, op: 'translate' });
  return `https://translate.google.com/?${p.toString()}`;
}

export function guessLang(text: string): 'ja' | 'id' {
  return /[぀-ヿ㐀-鿿]/.test(text) ? 'ja' : 'id';
}

/** 端末の読み上げ（オフラインでも、端末に音声があれば使える） */
export function speak(text: string, lang: 'ja' | 'id'): boolean {
  if (!('speechSynthesis' in window)) return false;
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang === 'ja' ? 'ja-JP' : 'id-ID';
  const voice = speechSynthesis.getVoices().find((v) => v.lang.replace('_', '-').toLowerCase().startsWith(u.lang.toLowerCase().slice(0, 2)));
  if (voice) u.voice = voice;
  u.rate = 0.9;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
  return true;
}
