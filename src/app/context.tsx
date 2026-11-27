import { createContext, useContext, type MutableRefObject } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { TravelDB, Workspace } from '../db/db';
import type { Ctx } from '../db/repo';
import type { Trip } from '../db/types';
import type { SyncController } from '../features/sync/useSyncController';

export interface Toast {
  id: number;
  text: string;
  action?: { label: string; run: () => void };
  kind?: 'info' | 'error';
}

export interface AppState {
  ws: Workspace;
  db: TravelDB;
  ctx: Ctx;
  trip: Trip;
  date: string;
  setDate: (d: string) => void;
  today: string;
  session: Session | null;
  sync: SyncController;
  toast: (text: string, opts?: { action?: Toast['action']; kind?: Toast['kind'] }) => void;
  switchWorkspace: (id: string) => Promise<void>;
  recordingRef: MutableRefObject<boolean>;
  device: { id: string; name: string };
  setDeviceName: (name: string) => Promise<void>;
  explicitLogout: () => Promise<void>;
  /** 「📍 現在地」の記録を開く（どの画面からでも） */
  openHere: () => void;
}

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(AppContext);
  if (!v) throw new Error('AppContext がありません');
  return v;
}
