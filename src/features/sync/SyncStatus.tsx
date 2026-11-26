import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { navigate } from '../../app/router';
import type { TravelDB } from '../../db/db';
import { timeIn } from '../../lib/dates';
import { missingBlobs } from './engine';

export interface SyncStats {
  pendingText: number;
  pendingMedia: number;
  errors: number;
  conflicts: number;
  missingMedia: number;
  lastSuccess: string | null;
  lastError: string | null;
  lastErrorKind: string | null;
}

export async function loadSyncStats(db: TravelDB): Promise<SyncStats> {
  const ops = await db.outbox.toArray();
  const notUploaded = new Set((await db.blobs.where('uploaded').equals(0).primaryKeys()) as string[]);
  let pendingText = 0;
  let pendingMedia = 0;
  let errors = 0;
  for (const o of ops) {
    if (o.status === 'error') errors++;
    if (o.status === 'conflict') continue;
    if (o.blobIds.some((b) => notUploaded.has(b))) pendingMedia++;
    else pendingText++;
  }
  const meta = async (k: string) => ((await db.syncMeta.get(k))?.value as string | null | undefined) ?? null;
  return {
    pendingText,
    pendingMedia,
    errors,
    conflicts: await db.conflicts.where('status').equals('open').count(),
    missingMedia: (await missingBlobs(db)).filter((m) => m.kind !== 'thumbnail').length,
    lastSuccess: await meta('lastSuccessfulSync'),
    lastError: await meta('lastError'),
    lastErrorKind: await meta('lastErrorKind'),
  };
}

export function useSyncStats() {
  const { db } = useApp();
  return useLiveQuery(() => loadSyncStats(db), [db]);
}

/** 今日画面の上部に出す状態行。タップで詳細へ */
export function SyncStatusLine() {
  const { ws, sync, trip } = useApp();
  const s = useSyncStats();
  if (ws.kind !== 'cloud') {
    return (
      <button className="status-line" onClick={() => navigate('settings/account')}>
        💾 端末に保存（同期なし・ローカル専用）
      </button>
    );
  }
  if (!s) return null;
  const pending = s.pendingText + s.pendingMedia;
  let text: string;
  let cls = '';
  if (s.conflicts > 0) {
    text = `! 競合 ${s.conflicts}件  [内容を確認]`;
    cls = 'warn';
  } else if (s.lastErrorKind === 'quota' || s.lastErrorKind === 'too-large') {
    text = `! ${s.lastErrorKind === 'quota' ? '容量不足' : 'ファイルが大きすぎます'}  [詳細]`;
    cls = 'warn';
  } else if (!sync.available) {
    text = `⏳ 未送信 ${pending}件  ${sync.reason ?? ''}`;
    cls = 'warn';
  } else if (sync.running) {
    text = `☁ 同期中…${s.pendingMedia ? `  音声・写真 残り${s.pendingMedia}` : ''}`;
  } else if (s.errors > 0) {
    text = `! 送信できない変更 ${s.errors}件  [詳細]`;
    cls = 'warn';
  } else if (pending > 0) {
    text = `⏳ 未送信 ${pending}件  ${s.lastErrorKind === 'network' ? '通信待ち' : '送信待ち'}（端末に保存済み）`;
  } else {
    text = `☁ 同期済み  最終 ${s.lastSuccess ? timeIn(trip.timeZone, s.lastSuccess) : '—'}`;
    cls = 'ok';
  }
  return (
    <button className={'status-line ' + cls} onClick={() => navigate(s.conflicts > 0 ? 'conflicts' : 'settings/sync')}>
      {text}
    </button>
  );
}
