import { useApp } from '../../app/context';
import { navigate } from '../../app/router';
import { AccountSection } from '../auth/AccountSection';
import { SyncSection } from '../sync/SyncSection';
import { BackupSection, RestoreSection } from './BackupSection';
import { ExportSection } from '../export/ExportSection';
import { StorageSection, TemplatesSection, TripSection } from './TripSections';

const SECTIONS: [string, string][] = [
  ['account', 'アカウント・端末'],
  ['sync', '同期'],
  ['backup', 'バックアップ'],
  ['restore', '復元'],
  ['export', '記事素材の出力'],
  ['trip', '旅行期間・レート'],
  ['templates', '質問テンプレート'],
  ['storage', '保存状況・容量'],
];

export function SettingsScreen(props: { section: string | null }) {
  const { ws } = useApp();
  const s = props.section;
  if (!s) {
    return (
      <div className="screen">
        <h1>設定</h1>
        <p className="muted small">表示中の領域：{ws.label}</p>
        <ul className="list">
          {SECTIONS.map(([key, label]) => (
            <li key={key}>
              <button className="row-btn" onClick={() => navigate(`settings/${key}`)}>
                <span>{label}</span>
                <span aria-hidden>›</span>
              </button>
            </li>
          ))}
        </ul>
        <p className="muted small">Indonesia Travel Log v0.1.0。旅行データは端末（とログイン時は本人用クラウド）にだけ保存し、広告・解析・AI サービスには送りません。</p>
      </div>
    );
  }
  const label = SECTIONS.find(([k]) => k === s)?.[1] ?? '設定';
  return (
    <div className="screen">
      <header className="diary-head">
        <button className="btn ghost" onClick={() => navigate('settings')}>← 設定</button>
        <strong>{label}</strong>
        <span />
      </header>
      {s === 'account' && <AccountSection />}
      {s === 'sync' && <SyncSection />}
      {s === 'backup' && <BackupSection />}
      {s === 'restore' && <RestoreSection />}
      {s === 'export' && <ExportSection />}
      {s === 'trip' && <TripSection />}
      {s === 'templates' && <TemplatesSection />}
      {s === 'storage' && <StorageSection />}
    </div>
  );
}
