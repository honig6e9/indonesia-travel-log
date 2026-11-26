import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { navigate } from '../../app/router';
import {
  createRestoreWorkspace,
  ensureCloudWorkspace,
  ensureLocalWorkspace,
  getSetting,
  openWorkspaceDb,
  setSetting,
} from '../../db/db';
import { formatBytes } from '../../lib/format';
import { stampIn } from '../../lib/dates';
import { downloadBlob, shareBlob } from '../../lib/download';
import { listTrips } from '../daily/tripRepo';
import { backupPreflight, buildBackup, copyTripAsNew, restoreInto, validateBackup, type ValidatedBackup } from './backup';

export function BackupSection() {
  const { db, trip, sync, toast } = useApp();
  const pre = useLiveQuery(() => backupPreflight(db), [db]);
  const lastBackup = useLiveQuery(() => getSetting<string | null>(db, 'lastBackupAt', null), [db]);
  const lastExternal = useLiveQuery(() => getSetting<string | null>(db, 'lastExternalSaveAt', null), [db]);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ blob: Blob; name: string; partial: boolean } | null>(null);

  const create = async () => {
    setResult(null);
    if (pre && pre.missing.length && sync.available) {
      if (confirm(`この端末にない音声・写真が ${pre.missing.length} 件あります。先に取得して完全なバックアップにしますか？\n「キャンセル」で、取得せずに部分バックアップを作ります。`)) {
        setBusy('未取得のファイルを取得中…');
        await sync.fetchMedia();
      }
    }
    setBusy('ZIP を作成中…（容量によっては時間がかかります）');
    try {
      const { blob, manifest } = await buildBackup(db);
      const name = `indonesia-log-backup_${stampIn(trip.timeZone)}${manifest.partial ? '_partial' : ''}.zip`;
      setResult({ blob, name, partial: manifest.partial });
      await setSetting(db, 'lastBackupAt', new Date().toISOString());
      toast(manifest.partial ? `部分バックアップを作成しました（欠落 ${manifest.missing.length} 件）` : 'バックアップを作成しました。端末の外に保存してください');
    } catch (e) {
      toast('バックアップを作成できませんでした：' + (e as Error).message, { kind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <section className="card">
        <h2>全データ ZIP（復元用）</h2>
        <p className="small">同期はバックアップの代わりになりません（誤って消すと、それも同期されます）。数日ごとに ZIP を作り、PC やクラウドドライブに退避してください。</p>
        {pre && (
          <ul className="kv">
            <li><span>端末にある音声・写真</span><span>{formatBytes(pre.totalBytes)}</span></li>
            <li><span>未送信の変更</span><span>{pre.pending}件（ZIP に含めます）</span></li>
            <li><span>未解決の競合</span><span>{pre.conflicts}件（両方の版を含めます）</span></li>
            <li><span>この端末にないファイル</span><span>{pre.missing.length}件</span></li>
          </ul>
        )}
        {pre && pre.totalBytes > 300 * 1024 * 1024 && <p className="notice">容量が大きいため、端末によっては作成に失敗することがあります。その場合は「記事素材の出力」で日単位に分けて取り出してください。</p>}
        <button className="btn primary" disabled={!!busy} onClick={() => void create()}>
          {busy ?? 'バックアップ ZIP を作成'}
        </button>
        {result && (
          <div className="result">
            <p>
              {result.name}（{formatBytes(result.blob.size)}）{result.partial && <strong>部分バックアップ</strong>}
            </p>
            <div className="actions">
              <button className="btn" onClick={() => downloadBlob(result.blob, result.name)}>ダウンロード</button>
              <button
                className="btn"
                onClick={async () => {
                  if (!(await shareBlob(result.blob, result.name))) toast('この端末では共有できません。ダウンロードを使ってください');
                }}
              >
                共有（ドライブなどへ）
              </button>
            </div>
            <p className="muted small">ダウンロードを始めただけでは、PC やクラウドへの退避は終わっていません。保存先で確かめたら、下のボタンで記録してください。ZIP は暗号化していないので、安全な場所に保管してください。</p>
          </div>
        )}
        <ul className="kv">
          <li><span>最終バックアップ作成</span><span>{lastBackup ? new Date(lastBackup).toLocaleString('ja-JP', { timeZone: trip.timeZone }) : '未作成'}</span></li>
          <li><span>外部保存を確認した日時</span><span>{lastExternal ? new Date(lastExternal).toLocaleString('ja-JP', { timeZone: trip.timeZone }) : '未記録'}</span></li>
        </ul>
        <button
          className="btn ghost"
          onClick={async () => {
            await setSetting(db, 'lastExternalSaveAt', new Date().toISOString());
            toast('外部保存済みとして記録しました');
          }}
        >
          外部に保存できたことを記録する
        </button>
      </section>
      <p className="muted small">出発前に一度、実機でバックアップを作り、別のブラウザ（または PC）の「復元」で読み込んで、音声が再生できるところまで確かめてください。</p>
    </div>
  );
}

export function RestoreSection() {
  const { ws, db, session, switchWorkspace, toast, trip } = useApp();
  const [v, setV] = useState<ValidatedBackup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const existing = useLiveQuery(async () => (await listTrips(db)).length, [db]) ?? 0;

  const pick = async (file: File | undefined) => {
    setV(null);
    setError(null);
    if (!file) return;
    setBusy('検証中…');
    try {
      setV(await validateBackup(file));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const toRestoreArea = async () => {
    if (!v) return;
    setBusy('復元用の領域に読み込み中…');
    try {
      const rws = await createRestoreWorkspace(`復元 ${v.manifest.createdAt.slice(0, 16).replace('T', ' ')}`);
      await restoreInto(openWorkspaceDb(rws), v);
      toast('復元用の領域に読み込みました。件数と音声の再生を確認してください');
      await switchWorkspace(rws.id);
      navigate('history');
    } catch (e) {
      toast('読み込めませんでした（既存のデータは変更していません）：' + (e as Error).message, { kind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  const replaceLocal = async () => {
    if (!v) return;
    if (prompt('ローカル専用の領域の内容を、この ZIP の内容で置き換えます。今のローカル領域の内容は消えます。\n確認のため「置換」と入力してください。') !== '置換') return;
    setBusy('置き換え中…');
    try {
      const local = await ensureLocalWorkspace();
      await restoreInto(openWorkspaceDb(local), v);
      toast('ローカル領域を置き換えました');
      await switchWorkspace(local.id);
    } catch (e) {
      toast('置き換えに失敗しました。ローカル領域は元のままです：' + (e as Error).message, { kind: 'error' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      {ws.kind === 'restore' && (
        <section className="card">
          <h2>この復元領域の使い方</h2>
          <p className="small">いま表示しているのは、ZIP から読み込んだ復元用の領域です（同期しません）。履歴で件数を見たり、音声を再生したりして確認できます。</p>
          <div className="actions">
            {session ? (
              <button
                className="btn"
                disabled={!!busy}
                onClick={async () => {
                  if (!confirm(`「${trip.name}」を、アカウント ${session.user.email} に新しい旅行として送ります（既存のクラウドの旅行は上書きしません）。よろしいですか？`)) return;
                  setBusy('写しています…');
                  const cw = await ensureCloudWorkspace(session.user.id, session.user.email ?? null);
                  await copyTripAsNew(db, trip.id, { db: openWorkspaceDb(cw), ownerId: session.user.id }, `${trip.name}（復旧）`);
                  setBusy(null);
                  toast('アカウントの領域に新しい旅行として追加しました。同期で送信します');
                  await switchWorkspace(cw.id);
                }}
              >
                クラウドへ新しい旅行として送る（障害からの復旧用）
              </button>
            ) : (
              <p className="muted small">クラウドへ送るには、先にログインしてください。</p>
            )}
            <button
              className="btn ghost"
              onClick={async () => {
                const local = await ensureLocalWorkspace();
                await copyTripAsNew(db, trip.id, { db: openWorkspaceDb(local), ownerId: null }, `${trip.name}（復元）`);
                toast('ローカル領域に新しい旅行として写しました');
              }}
            >
              ローカル領域に新しい旅行として写す
            </button>
          </div>
          <p className="muted small">復旧の確認が済むまで、古いクラウドの旅行は削除しないでください。旅行の切り替えは「旅行期間・レート」でできます。</p>
        </section>
      )}

      <section className="card">
        <h2>ZIP から復元</h2>
        <p className="small">
          新しい端末では、通常は ZIP は不要です。同じアカウントでログインすれば記録を取得できます。ZIP は、まず独立した「復元用の領域」に読み込み、同期中のデータには自動で上書きしません。
        </p>
        <input type="file" accept=".zip,application/zip" onChange={(e) => void pick(e.target.files?.[0])} aria-label="バックアップ ZIP を選ぶ" />
        {busy && <p>{busy}</p>}
        {error && <p className="error-box">検証に失敗したため読み込みません（既存のデータは変更していません）：{error}</p>}
        {v && (
          <div className="result">
            <h3>検証済み</h3>
            <ul className="kv">
              <li><span>作成日時</span><span>{new Date(v.manifest.createdAt).toLocaleString('ja-JP')}</span></li>
              {v.manifest.trips.map((t) => (
                <li key={t.id}><span>旅行</span><span>{t.name}（{t.startDate}〜{t.endDate}）</span></li>
              ))}
              <li><span>やること・食べたいもの</span><span>{v.manifest.counts.checklistItems ?? 0}件</span></li>
              <li><span>録音</span><span>{v.manifest.counts.audioClips ?? 0}件</span></li>
              <li><span>メモ</span><span>{v.manifest.counts.notes ?? 0}件</span></li>
              <li><span>写真</span><span>{v.manifest.counts.media ?? 0}件</span></li>
              <li><span>支出</span><span>{v.manifest.counts.expenses ?? 0}件</span></li>
              <li><span>ファイル容量</span><span>{formatBytes(v.totalBytes)}</span></li>
              <li><span>この領域の既存データ</span><span>{existing ? `旅行 ${existing}件あり（変更しません）` : 'なし'}</span></li>
            </ul>
            {v.warnings.map((w) => (
              <p key={w} className="notice small">{w}</p>
            ))}
            <div className="actions">
              <button className="btn primary" disabled={!!busy} onClick={() => void toRestoreArea()}>
                復元用の領域に読み込む（推奨）
              </button>
              <button className="btn danger ghost" disabled={!!busy} onClick={() => void replaceLocal()}>
                ローカル専用の領域を置き換える
              </button>
            </div>
            <p className="muted small">同期中のアカウントの領域を ZIP で上書きする機能はありません（誤って同期先を壊さないため）。</p>
          </div>
        )}
      </section>
    </div>
  );
}
