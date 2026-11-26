import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { navigate } from '../../app/router';
import { getSetting, setSetting } from '../../db/db';
import { formatBytes } from '../../lib/format';
import { supabase } from '../../lib/supabase';
import { SupabaseTransport } from './supabaseTransport';
import type { DeviceInfo } from './transport';
import { useSyncStats } from './SyncStatus';
import type { SyncMode } from './useSyncController';

export function SyncSection() {
  const { ws, db, sync, toast, trip } = useApp();
  const s = useSyncStats();
  const mode = useLiveQuery(() => getSetting<SyncMode>(db, 'syncMode', 'all'), [db]) ?? 'all';
  const mediaAuto = useLiveQuery(() => getSetting<boolean>(db, 'mediaAutoUpload', true), [db]) ?? true;
  const errorOps = useLiveQuery(() => db.outbox.where('status').equals('error').toArray(), [db]) ?? [];
  const cloudBytes = useLiveQuery(async () => {
    let n = 0;
    for (const c of await db.audioClips.toArray()) if (!c.deletedAt) n += c.size;
    for (const m of await db.media.toArray()) if (!m.deletedAt) n += m.size;
    return n;
  }, [db]) ?? 0;
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);

  useEffect(() => {
    if (!sync.available || !supabase) return;
    new SupabaseTransport(supabase)
      .listDevices()
      .then(setDevices)
      .catch(() => setDevices(null));
  }, [sync.available, sync.lastReport]);

  if (ws.kind !== 'cloud') {
    return (
      <section className="card">
        <p>この領域（{ws.label}）は同期しません。</p>
        <p className="muted small">複数の端末で使うには「アカウント・端末」からログインしてください。</p>
        <button className="btn" onClick={() => navigate('settings/account')}>アカウント・端末へ</button>
      </section>
    );
  }
  const FREE_LIMIT = 1024 * 1024 * 1024;
  const ratio = cloudBytes / FREE_LIMIT;

  return (
    <div>
      <section className="card">
        <h2>状況</h2>
        {sync.reason && <p className="notice">{sync.reason}</p>}
        {s && (
          <ul className="kv">
            <li><span>未送信（テキスト）</span><span>{s.pendingText}件</span></li>
            <li><span>未送信（音声・写真）</span><span>{s.pendingMedia}件</span></li>
            <li><span>未取得の音声・写真</span><span>{s.missingMedia}件</span></li>
            <li><span>競合</span><span>{s.conflicts}件 {s.conflicts > 0 && <button className="link" onClick={() => navigate('conflicts')}>確認</button>}</span></li>
            <li><span>最終同期</span><span>{s.lastSuccess ? new Date(s.lastSuccess).toLocaleString('ja-JP', { timeZone: trip.timeZone }) : '—'}</span></li>
            <li><span>最後のエラー</span><span>{s.lastError ?? 'なし'}</span></li>
          </ul>
        )}
        <div className="actions">
          <button
            className="btn primary"
            disabled={!sync.available || sync.running}
            onClick={async () => {
              const r = await sync.runNow({ manual: true });
              if (r) toast(r.errors.length ? r.errors[0] : `同期しました（送信 ${r.pushed}・受信 ${r.pulled}・ファイル ${r.uploaded}）`, { kind: r.errors.length ? 'error' : 'info' });
            }}
          >
            {sync.running ? '同期中…' : '今すぐ同期'}
          </button>
          <button
            className="btn"
            disabled={!sync.available || sync.running}
            onClick={async () => {
              const r = await sync.runNow({ manual: true, uploadMedia: true });
              if (r) toast(r.errors.length ? r.errors[0] : `音声・写真を ${r.uploaded} 件送信しました`);
            }}
          >
            音声・写真も全件送信
          </button>
          <button
            className="btn"
            disabled={!sync.available || sync.running || !s?.missingMedia}
            onClick={async () => {
              const r = await sync.fetchMedia();
              if (r) toast(r.failed.length ? `取得できなかったファイル ${r.failed.length} 件` : `${r.fetched} 件を端末に保存しました`);
            }}
          >
            全素材を取得
          </button>
        </div>
        <p className="muted small">
          アプリを閉じている間は同期しません。次に開いたとき・画面に戻ったとき・通信が戻ったときに自動で同期します。「端末に保存済み」の記録は、同期前でも失われません。
        </p>
      </section>

      {errorOps.length > 0 && (
        <section className="card warn-card">
          <h2>送信できない変更（{errorOps.length}件）</h2>
          <ul className="small">
            {[...new Set(errorOps.map((o) => o.lastError))].map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          <p className="small">端末のデータは消していません。原因を解消してから再試行してください（大きすぎるファイルは ZIP で退避するか、写真は容量節約モードで追加し直せます）。</p>
          <button
            className="btn"
            onClick={async () => {
              await db.outbox.where('status').equals('error').modify({ status: 'pending', attempts: 0, nextAttemptAt: 0 });
              await sync.runNow({ manual: true });
            }}
          >
            再試行
          </button>
        </section>
      )}

      <section className="card">
        <h2>通信の設定（この端末）</h2>
        <label className="choice">
          <input type="radio" checked={mode === 'all'} onChange={() => void setSetting(db, 'syncMode', 'all')} /> 自動同期 ON
        </label>
        <label className="choice">
          <input type="radio" checked={mode === 'textOnly'} onChange={() => void setSetting(db, 'syncMode', 'textOnly')} /> テキストだけ自動同期（音声・写真は手動で送信）
        </label>
        <label className="choice">
          <input type="radio" checked={mode === 'off'} onChange={() => void setSetting(db, 'syncMode', 'off')} /> 自動同期を一時停止（手動の「今すぐ同期」だけ）
        </label>
        <label className="check-inline">
          <input type="checkbox" checked={mediaAuto} disabled={mode !== 'all'} onChange={(e) => void setSetting(db, 'mediaAutoUpload', e.target.checked)} />
          音声・写真を自動で送信する
        </label>
        <p className="muted small">Wi-Fi だけで送る設定は、ブラウザが回線の種類を正確に判定できないため用意していません。通信量を抑えたいときは「テキストだけ」にして、Wi-Fi のときに「音声・写真も全件送信」を押してください。</p>
      </section>

      <section className="card">
        <h2>クラウドの容量（概算）</h2>
        <p>
          音声・写真 約 {formatBytes(cloudBytes)}（無料枠の目安 1GB の {Math.round(ratio * 100)}%）
        </p>
        {ratio >= 0.9 ? (
          <p className="error-box">容量の目安の 90% を超えました。ZIP で退避し、写真は容量節約モードを検討してください。端末のデータは消しません。</p>
        ) : ratio >= 0.7 ? (
          <p className="notice">容量の目安の 70% を超えました。</p>
        ) : null}
        <p className="muted small">アプリ内の数字は記録から計算した概算です。実際の使用量は Supabase の管理画面（Storage / Usage）で確認してください。1ファイルの上限は 50MB です。</p>
      </section>

      <section className="card">
        <h2>登録端末（同期の履歴）</h2>
        {devices ? (
          <ul className="kv">
            {devices.map((d) => (
              <li key={d.device_id}>
                <span>{d.display_name}</span>
                <span className="small">{d.last_synced_at ? new Date(d.last_synced_at).toLocaleString('ja-JP', { timeZone: trip.timeZone }) : '—'}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted small">オンラインで同期すると表示します。</p>
        )}
        <p className="muted small">これは同期の履歴です。遠隔消去やログインの強制解除の機能ではありません。</p>
      </section>
    </div>
  );
}
