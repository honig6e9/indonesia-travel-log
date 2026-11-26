import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { Field } from '../../components/ui';
import { SaveZipActions } from '../../components/SaveZipActions';
import { formatBytes } from '../../lib/format';
import { resizeImage } from '../../lib/image';
import { allTags, loadTripData } from '../history/historyData';
import { missingBlobs } from '../sync/engine';
import { buildArticleExport } from './articleExport';

export function ExportSection() {
  const { db, trip, date, toast } = useApp();
  const [from, setFrom] = useState(date);
  const [to, setTo] = useState(date);
  const [mode, setMode] = useState<'all' | 'candidate'>('all');
  const [tag, setTag] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ blob: Blob; name: string } | null>(null);
  const tags = useLiveQuery(async () => allTags(await loadTripData(db, trip.id)), [db, trip.id]) ?? [];
  const missing = useLiveQuery(async () => (await missingBlobs(db)).filter((m) => m.localDate >= from && m.localDate <= to && m.kind !== 'thumbnail').length, [db, from, to]) ?? 0;

  return (
    <div>
      <section className="card">
        <h2>記事素材 ZIP</h2>
        <p className="small">帰国後の記事・動画づくり用に、日別 Markdown・CSV・音声・写真をまとめて出力します。復元用のバックアップとは別物です。1日だけ選べば、日別の素材 ZIP になります。</p>
        <div className="row">
          <Field label="開始日">
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </Field>
          <Field label="終了日">
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </Field>
        </div>
        <div className="actions">
          <button className="btn small ghost" onClick={() => { setFrom(trip.startDate); setTo(trip.endDate); }}>旅行期間全体</button>
          <button className="btn small ghost" onClick={() => { setFrom(date); setTo(date); }}>選択日だけ</button>
        </div>
        <label className="choice">
          <input type="radio" checked={mode === 'all'} onChange={() => setMode('all')} /> 全素材（私用）
        </label>
        <label className="choice">
          <input type="radio" checked={mode === 'candidate'} onChange={() => setMode('candidate')} /> 公開候補のみ（要レビュー）
        </label>
        {mode === 'candidate' && (
          <p className="notice small">「公開候補」にした素材だけを入れます。支出・定点観測は含めません。写真は再エンコードして位置情報などを落としますが、顔・会話内容の匿名化はしません。公開前に必ず確認してください。</p>
        )}
        <Field label="タグで絞る（任意）">
          <select value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">指定なし</option>
            {tags.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </Field>
        {missing > 0 && <p className="notice small">この期間に、端末にない音声・写真が {missing} 件あります（出力に含まれません）。同期の画面から「全素材を取得」できます。</p>}
        <button
          className="btn primary"
          disabled={busy || from > to}
          onClick={async () => {
            setBusy(true);
            setResult(null);
            try {
              const { blob } = await buildArticleExport(db, trip, { from, to, mode, tag: tag || undefined, stripImage: (b) => resizeImage(b, 4096, 0.9) });
              setResult({ blob, name: `article-materials_${from}${from !== to ? '_' + to : ''}${mode === 'candidate' ? '_public-candidates' : ''}.zip` });
            } catch (e) {
              toast('出力できませんでした：' + (e as Error).message, { kind: 'error' });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '作成中…' : '出力する'}
        </button>
        {result && (
          <div className="result">
            <p>{result.name}（{formatBytes(result.blob.size)}）</p>
            <SaveZipActions blob={result.blob} name={result.name} />
          </div>
        )}
      </section>
    </div>
  );
}
