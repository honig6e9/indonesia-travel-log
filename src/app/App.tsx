import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Session } from '@supabase/supabase-js';
import {
  LOCAL_WORKSPACE_ID,
  ensureCloudWorkspace,
  ensureLocalWorkspace,
  getActiveWorkspaceId,
  metaDb,
  openWorkspaceDb,
  setActiveWorkspaceId,
  type Workspace,
} from '../db/db';
import { createTrip, getActiveTrip } from '../features/daily/tripRepo';
import { useSyncController } from '../features/sync/useSyncController';
import { supabase } from '../lib/supabase';
import { todayIn } from '../lib/dates';
import { newId } from '../lib/ids';
import { AppContext, type AppState, type Toast } from './context';
import { navigate, useRoute } from './router';
import { TodayScreen } from '../features/daily/TodayScreen';
import { DiaryScreen } from '../features/diary/DiaryScreen';
import { ListsScreen } from '../features/checklist/ListsScreen';
import { ItemDetailScreen } from '../features/checklist/ItemDetailScreen';
import { HistoryScreen } from '../features/history/HistoryScreen';
import { DayScreen } from '../features/history/DayScreen';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { ConflictsScreen } from '../features/sync/ConflictsScreen';
import { UpdateBanner } from '../components/UpdateBanner';
import { ErrorBoundary } from '../components/ErrorBoundary';

function defaultDeviceName() {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'Android スマホ';
  if (/iPhone|iPad/i.test(ua)) return 'iPhone';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Mac/i.test(ua)) return 'Mac';
  return 'この端末';
}

async function loadDevice() {
  let id = (await metaDb.kv.get('deviceId'))?.value as string | undefined;
  if (!id) {
    id = newId();
    await metaDb.kv.put({ key: 'deviceId', value: id });
  }
  const name = ((await metaDb.kv.get('deviceName'))?.value as string | undefined) ?? defaultDeviceName();
  return { id, name };
}

export function App() {
  const [ws, setWs] = useState<Workspace | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [device, setDevice] = useState<{ id: string; name: string } | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const loginIntent = useRef(false);
  const logoutIntent = useRef(false);

  const toast = useCallback<AppState['toast']>((text, opts) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, text, ...opts }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), opts?.action ? 6000 : 3500);
  }, []);

  useEffect(() => {
    const on = (e: Event) => toast((e as CustomEvent<string>).detail);
    window.addEventListener('itl-toast', on);
    return () => window.removeEventListener('itl-toast', on);
  }, [toast]);

  // 起動：領域・端末・セッション
  useEffect(() => {
    (async () => {
      try {
        if (!('indexedDB' in window)) throw new Error('このブラウザは IndexedDB が使えません');
        const local = await ensureLocalWorkspace();
        const activeId = await getActiveWorkspaceId();
        const active = (activeId && (await metaDb.workspaces.get(activeId))) || local;
        setDevice(await loadDevice());
        if (supabase) {
          const { data } = await supabase.auth.getSession();
          setSession(data.session);
        }
        setWs(active);
      } catch (e) {
        setFatal(String((e as Error).message ?? e));
      }
    })();
  }, []);

  useEffect(() => {
    if (!supabase) return;
    const { data } = supabase.auth.onAuthStateChange((event, s) => {
      setSession(s);
      if (event === 'SIGNED_IN' && s && loginIntent.current) {
        loginIntent.current = false;
        void (async () => {
          const cw = await ensureCloudWorkspace(s.user.id, s.user.email ?? null);
          await setActiveWorkspaceId(cw.id);
          setWs(cw);
        })();
      }
      if (event === 'SIGNED_OUT' && logoutIntent.current) {
        logoutIntent.current = false;
        void (async () => {
          const local = await ensureLocalWorkspace();
          await setActiveWorkspaceId(local.id);
          setWs(local);
        })();
      }
    });
    const onLoginIntent = () => (loginIntent.current = true);
    window.addEventListener('itl-login-intent', onLoginIntent);
    return () => {
      data.subscription.unsubscribe();
      window.removeEventListener('itl-login-intent', onLoginIntent);
    };
  }, []);

  if (fatal) return <div className="fatal">起動できませんでした：{fatal}</div>;
  if (!ws || !device) return <div className="splash">読み込み中…</div>;
  return (
    <Workspaced
      key={ws.id}
      ws={ws}
      session={session}
      device={device}
      setDevice={setDevice}
      toast={toast}
      toasts={toasts}
      dismissToast={(id) => setToasts((t) => t.filter((x) => x.id !== id))}
      onSwitch={async (id) => {
        const next = (await metaDb.workspaces.get(id)) ?? (await ensureLocalWorkspace());
        await setActiveWorkspaceId(next.id);
        setWs(next);
      }}
      onLogout={async () => {
        logoutIntent.current = true;
        await supabase?.auth.signOut({ scope: 'local' });
        // オフラインなどでイベントが来ない場合も、ローカル領域に切り替える
        const local = await ensureLocalWorkspace();
        await setActiveWorkspaceId(local.id);
        setWs(local);
      }}
    />
  );
}

function Workspaced(props: {
  ws: Workspace;
  session: Session | null;
  device: { id: string; name: string };
  setDevice: (d: { id: string; name: string }) => void;
  toast: AppState['toast'];
  toasts: Toast[];
  dismissToast: (id: number) => void;
  onSwitch: (id: string) => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const { ws, session, device } = props;
  const db = useMemo(() => openWorkspaceDb(ws), [ws]);
  const ctx = useMemo(() => ({ db, ownerId: ws.kind === 'cloud' ? ws.ownerId : null }), [db, ws]);
  const sync = useSyncController(ws, db, session, device);
  const trip = useLiveQuery(() => getActiveTrip(db), [db]);
  const tripLoaded = trip !== undefined;
  const recordingRef = useRef(false);
  const [creating, setCreating] = useState(false);
  const route = useRoute();

  // 旅行がなければ作る。クラウド領域では、初回の取得を済ませてから（既存の記録を先に受け取る）
  // 自動同期（起動時に走る）が一度成功していれば、クラウド側の記録は受け取り済み
  const lastSync = useLiveQuery(async () => (await db.syncMeta.get('lastSuccessfulSync')) ?? null, [db]);
  const { runNow } = sync;
  const retryFirstSync = useCallback(async () => {
    const r = await runNow({ manual: true, uploadMedia: false });
    if (r && r.errors.length) props.toast(r.errors[0], { kind: 'error' });
  }, [runNow, props]);
  useEffect(() => {
    if (!tripLoaded || trip || creating) return;
    if (ws.kind === 'restore') return;
    if (ws.kind === 'cloud' && !lastSync) return;
    setCreating(true);
    void createTrip(ctx).finally(() => setCreating(false));
  }, [tripLoaded, trip, creating, ws.kind, lastSync, ctx]);

  const [date, setDateState] = useState<string | null>(() => sessionStorage.getItem('itl-date'));
  const today = trip ? todayIn(trip.timeZone) : '';
  const effectiveDate = date ?? today;
  const setDate = useCallback((d: string) => {
    sessionStorage.setItem('itl-date', d);
    setDateState(d);
  }, []);

  useEffect(() => {
    const onUnload = (e: BeforeUnloadEvent) => {
      if (recordingRef.current) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  if (!trip) {
    return (
      <div className="splash">
        {ws.kind === 'cloud' ? (
          <>
            <p>初回同期中です…（初回はインターネット接続が必要です）</p>
            {sync.reason && <p className="muted">{sync.reason}</p>}
            <button className="btn" onClick={() => void retryFirstSync()} disabled={sync.running}>{sync.running ? "同期中…" : "再試行"}</button>
            <button className="btn ghost" onClick={() => void props.onSwitch(LOCAL_WORKSPACE_ID)}>ローカル領域に戻る</button>
          </>
        ) : ws.kind === 'restore' ? (
          <>
            <p>この復元領域には旅行がありません。</p>
            <button className="btn" onClick={() => void props.onSwitch(LOCAL_WORKSPACE_ID)}>ローカル領域に戻る</button>
          </>
        ) : (
          <p>準備中…</p>
        )}
      </div>
    );
  }

  const state: AppState = {
    ws,
    db,
    ctx,
    trip,
    date: effectiveDate,
    setDate,
    today,
    session,
    sync,
    toast: props.toast,
    switchWorkspace: props.onSwitch,
    recordingRef,
    device,
    setDeviceName: async (name) => {
      await metaDb.kv.put({ key: 'deviceName', value: name });
      props.setDevice({ ...device, name });
    },
    explicitLogout: props.onLogout,
  };

  let screen;
  switch (route.name) {
    case 'diary':
      screen = <DiaryScreen initialQuestion={route.query.get('q')} />;
      break;
    case 'lists':
      screen = <ListsScreen type={route.param === 'food' ? 'food' : 'task'} />;
      break;
    case 'item':
      screen = <ItemDetailScreen id={route.param ?? ''} />;
      break;
    case 'history':
      screen = <HistoryScreen />;
      break;
    case 'day':
      screen = <DayScreen date={route.param ?? effectiveDate} />;
      break;
    case 'settings':
      screen = <SettingsScreen section={route.param} />;
      break;
    case 'conflicts':
      screen = <ConflictsScreen />;
      break;
    default:
      screen = <TodayScreen />;
  }
  const tab = route.name === 'diary' || route.name === 'today' ? 'today' : route.name === 'item' ? 'lists' : route.name === 'day' ? 'history' : route.name === 'conflicts' ? 'settings' : route.name;

  return (
    <AppContext.Provider value={state}>
      <div className="app">
        {ws.kind !== 'cloud' && ws.kind !== 'local' && (
          <div className="ws-banner">
            復元領域を表示中：{ws.label}（同期しません）
            <button className="link" onClick={() => void props.onSwitch(LOCAL_WORKSPACE_ID)}>戻る</button>
          </div>
        )}
        <UpdateBanner />
        <main className="main">
          <ErrorBoundary resetKey={location.hash}>{screen}</ErrorBoundary>
        </main>
        <nav className="tabbar" aria-label="メイン">
          {(
            [
              ['today', '今日', '📅'],
              ['lists', 'リスト', '☑'],
              ['history', '履歴', '🗂'],
              ['settings', '設定', '⚙'],
            ] as const
          ).map(([name, label, icon]) => (
            <button
              key={name}
              className={'tab' + (tab === name ? ' active' : '')}
              aria-current={tab === name ? 'page' : undefined}
              onClick={() => navigate(name === 'lists' ? 'lists/task' : name)}
            >
              <span aria-hidden>{icon}</span>
              {label}
            </button>
          ))}
        </nav>
        <div className="toasts" role="status" aria-live="polite">
          {props.toasts.map((t) => (
            <div key={t.id} className={'toast' + (t.kind === 'error' ? ' error' : '')}>
              <span>{t.text}</span>
              {t.action && (
                <button
                  className="link"
                  onClick={() => {
                    t.action!.run();
                    props.dismissToast(t.id);
                  }}
                >
                  {t.action.label}
                </button>
              )}
            </div>
          ))}
        </div>
      </div>
    </AppContext.Provider>
  );
}
