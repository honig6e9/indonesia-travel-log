import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Session } from '@supabase/supabase-js';
import type { TravelDB, Workspace } from '../../db/db';
import { getSetting } from '../../db/db';
import { supabase } from '../../lib/supabase';
import { SyncEngine, type SyncReport } from './engine';
import { SupabaseTransport } from './supabaseTransport';

export type SyncMode = 'all' | 'textOnly' | 'off';

export interface SyncController {
  /** この領域・セッションで同期できるか */
  available: boolean;
  reason: string | null;
  running: boolean;
  progress: string | null;
  lastReport: SyncReport | null;
  runNow: (opts?: { uploadMedia?: boolean; manual?: boolean }) => Promise<SyncReport | null>;
  fetchMedia: (filter?: { localDate?: string; blobIds?: string[] }) => Promise<{ fetched: number; failed: string[] } | null>;
  engine: SyncEngine | null;
}

const INTERVAL_MS = 30_000;

export function useSyncController(
  ws: Workspace,
  db: TravelDB,
  session: Session | null,
  device: { id: string; name: string },
): SyncController {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [lastReport, setLastReport] = useState<SyncReport | null>(null);
  const runningRef = useRef(false);

  const mode = useLiveQuery(() => getSetting<SyncMode>(db, 'syncMode', 'all'), [db]) ?? 'all';
  const mediaAuto = useLiveQuery(() => getSetting<boolean>(db, 'mediaAutoUpload', true), [db]) ?? true;

  let reason: string | null = null;
  if (ws.kind !== 'cloud') reason = 'この領域は同期しません（ローカル専用）';
  else if (!supabase) reason = 'このビルドには Supabase が設定されていません';
  else if (!session) reason = '再ログインが必要です（端末への記録は続けられます）';
  else if (session.user.id !== ws.ownerId) reason = 'ログイン中のアカウントがこの領域と違うため同期しません';

  const engine = useMemo(() => {
    if (reason || !supabase || !ws.ownerId) return null;
    return new SyncEngine(db, ws.ownerId, device.id, device.name, new SupabaseTransport(supabase));
  }, [db, ws.ownerId, device.id, device.name, reason]);

  const withLock = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | null> => {
      if (runningRef.current) return null;
      const run = async () => {
        runningRef.current = true;
        setRunning(true);
        try {
          return await fn();
        } finally {
          runningRef.current = false;
          setRunning(false);
          setProgress(null);
        }
      };
      // 複数タブで同時に送信しないよう、端末内で排他する
      if (typeof navigator !== 'undefined' && navigator.locks) {
        return navigator.locks.request(`itl-sync-${ws.id}`, { ifAvailable: true }, async (lock) => (lock ? run() : null));
      }
      return run();
    },
    [ws.id],
  );

  const runNow = useCallback(
    async (opts: { uploadMedia?: boolean; manual?: boolean } = {}) => {
      if (!engine) return null;
      if (!opts.manual && mode === 'off') return null;
      const uploadMedia = opts.uploadMedia ?? (mode === 'all' && mediaAuto);
      const r = await withLock(async () => {
        setProgress('同期中');
        return engine.sync({ uploadMedia });
      });
      if (r) setLastReport(r);
      return r;
    },
    [engine, mode, mediaAuto, withLock],
  );

  const fetchMedia = useCallback(
    async (filter?: { localDate?: string; blobIds?: string[] }) => {
      if (!engine) return null;
      return withLock(async () => {
        setProgress('素材を取得中');
        return engine.fetchMissing(filter);
      });
    },
    [engine, withLock],
  );

  // トリガー：起動・前景復帰・online・保存後のデバウンス・前景中 30 秒ごと
  const pendingCount = useLiveQuery(() => db.outbox.where('status').equals('pending').count(), [db]) ?? 0;
  const runRef = useRef(runNow);
  runRef.current = runNow;

  useEffect(() => {
    if (!engine) return;
    void runRef.current();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void runRef.current();
    };
    const onOnline = () => void runRef.current();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') void runRef.current();
    }, INTERVAL_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
      window.clearInterval(t);
    };
  }, [engine]);

  useEffect(() => {
    if (!engine || pendingCount === 0) return;
    const t = window.setTimeout(() => void runRef.current(), 3000);
    return () => window.clearTimeout(t);
  }, [engine, pendingCount]);

  return { available: !!engine, reason, running, progress, lastReport, runNow, fetchMedia, engine };
}
