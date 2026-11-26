import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { navigate } from '../../app/router';
import { Field } from '../../components/ui';
import {
  LOCAL_WORKSPACE_ID,
  deleteWorkspace,
  ensureCloudWorkspace,
  ensureLocalWorkspace,
  metaDb,
  openWorkspaceDb,
} from '../../db/db';
import { cloudConfigured, supabase } from '../../lib/supabase';
import { copyTripAsNew } from '../settings/backup';
import { listTrips } from '../daily/tripRepo';
import { RECORD_TABLES } from '../../db/db';

export function AccountSection() {
  const { ws, session, device, setDeviceName, explicitLogout, switchWorkspace, db, toast } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState(device.name);
  const workspaces = useLiveQuery(() => metaDb.workspaces.toArray(), []) ?? [];
  const pending = useLiveQuery(() => db.outbox.count(), [db]) ?? 0;

  const login = async () => {
    if (!supabase) return;
    setBusy(true);
    window.dispatchEvent(new Event('itl-login-intent'));
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    setPassword('');
    if (error) toast(/fetch|network/i.test(error.message) ? 'ログインには通信が必要です' : 'ログインできませんでした：' + error.message, { kind: 'error' });
    else toast('ログインしました。アカウントの記録を取得します');
  };

  const logout = async () => {
    if (pending > 0) {
      const ok = confirm(
        `まだクラウドに送っていない変更が ${pending} 件あります。\n\n先に「同期」で送信するか、「バックアップ」で ZIP を退避してください。\nこのままログアウトしても端末のデータは消しませんが、次に同じアカウントでログインするまで送信されません。\n\nログアウトしますか？`,
      );
      if (!ok) return;
    } else if (!confirm('ログアウトしますか？（端末のデータは消しません。同じアカウントで再ログインすると続きから使えます）')) return;
    await explicitLogout();
    toast('ログアウトしました。記録はこのアカウントで再ログインするまで表示しません');
  };

  return (
    <div>
      <section className="card">
        <h2>この端末</h2>
        <Field label="端末名（端末一覧に表示）">
          <input value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && void setDeviceName(name.trim().slice(0, 60))} />
        </Field>
        <p className="muted small">表示中の領域：{ws.label}</p>
      </section>

      <section className="card">
        <h2>アカウント</h2>
        {!cloudConfigured ? (
          <p className="muted">このビルドには Supabase の設定がないため、ローカル専用で動いています（README の「Supabase の設定」を参照）。</p>
        ) : session ? (
          <>
            <p>ログイン中：{session.user.email}</p>
            {ws.kind !== 'cloud' && (
              <button
                className="btn"
                onClick={async () => {
                  const cw = await ensureCloudWorkspace(session.user.id, session.user.email ?? null);
                  await switchWorkspace(cw.id);
                }}
              >
                このアカウントの記録を表示する
              </button>
            )}
            <button className="btn ghost" onClick={() => void logout()}>ログアウト</button>
          </>
        ) : (
          <>
            {ws.kind === 'cloud' && <p className="notice">ログインの有効期限が切れています。端末への記録は続けられます。再ログインすると同期を再開します。</p>}
            <Field label="メールアドレス">
              <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label="パスワード">
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <button className="btn primary" disabled={busy || !email || !password} onClick={() => void login()}>
              {busy ? 'ログイン中…' : 'ログイン'}
            </button>
            <p className="muted small">本人用のアカウントでログインします。初回のログインと同期には通信が必要です。ローカルで記録した内容は、自動では送りません。</p>
          </>
        )}
      </section>

      {session && <MoveLocalToCloud />}

      <section className="card">
        <h2>この端末の領域</h2>
        <p className="muted small">アカウントごと・ローカル専用・復元用で保存場所を分けています。ほかのアカウントのデータは送信しません。</p>
        <ul className="list">
          {workspaces.map((w) => (
            <li key={w.id} className="ws-row">
              <span>
                {w.label}
                {w.id === ws.id && <span className="pill ok">表示中</span>}
              </span>
              <span className="actions">
                {w.id !== ws.id && (
                  <button className="btn small" onClick={() => void switchWorkspace(w.id)}>
                    表示
                  </button>
                )}
                {w.id !== LOCAL_WORKSPACE_ID && w.id !== ws.id && (
                  <button
                    className="btn small danger ghost"
                    onClick={async () => {
                      const wdb = openWorkspaceDb(w);
                      const p = await wdb.outbox.count();
                      if (p > 0 && w.kind === 'cloud') {
                        alert(`この領域には未送信の変更が ${p} 件あります。先に同期するか、バックアップしてから削除してください。`);
                        return;
                      }
                      const typed = prompt(
                        `「${w.label}」をこの端末から削除します。元に戻せません。${w.kind === 'cloud' ? 'クラウドのデータは消えません。' : ''}\n確認のため「削除」と入力してください。`,
                      );
                      if (typed !== '削除') return;
                      await deleteWorkspace(w);
                      toast('この端末から削除しました');
                    }}
                  >
                    端末から削除
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
        <p className="muted small">端末をなくしたときは、Supabase の管理画面でパスワードを変更し、ログイン中のセッションを無効にしてください（README 参照）。オフラインの端末を遠隔で消去することはできません。</p>
      </section>
    </div>
  );
}

/** ローカル専用の記録を、件数を確認したうえでアカウントへ新しい旅行として移す（自動置換しない） */
function MoveLocalToCloud() {
  const { session, toast, switchWorkspace } = useApp();
  const counts = useLiveQuery(async () => {
    const local = await ensureLocalWorkspace();
    const ldb = openWorkspaceDb(local);
    const trips = await listTrips(ldb);
    let total = 0;
    for (const t of RECORD_TABLES) if (t !== 'trips' && t !== 'questionTemplates') total += await ldb.table(t).filter((r) => !r.deletedAt).count();
    return { trips, total, ldb };
  }, []);
  if (!counts || counts.total === 0 || !session) return null;
  return (
    <section className="card">
      <h2>ローカルの記録をアカウントへ移す</h2>
      <p className="small">
        この端末のローカル領域に {counts.total} 件の記録があります（旅行 {counts.trips.length} 件）。アカウントには「新しい旅行」として追加します。既存のクラウドの記録は上書きしません。
      </p>
      <button
        className="btn"
        onClick={async () => {
          if (!confirm(`ローカルの記録 ${counts.total} 件を、アカウント ${session.user.email} に新しい旅行として送ります。よろしいですか？\n（ローカル領域の記録は消しません）`)) return;
          const cw = await ensureCloudWorkspace(session.user.id, session.user.email ?? null);
          const cdb = openWorkspaceDb(cw);
          for (const t of counts.trips) await copyTripAsNew(counts.ldb, t.id, { db: cdb, ownerId: session.user.id }, `${t.name}（ローカルから移行）`);
          toast('アカウントの領域に追加しました。同期で送信します');
          await switchWorkspace(cw.id);
          navigate('settings/trip');
        }}
      >
        件数を確認してアカウントへ移す
      </button>
    </section>
  );
}
