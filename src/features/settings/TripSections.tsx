import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { Field, numOrNull } from '../../components/ui';
import { getSetting, setSetting } from '../../db/db';
import type { QuestionTemplate } from '../../db/types';
import { formatBytes } from '../../lib/format';
import { isLocalDate } from '../../lib/dates';
import { addTemplate, createTrip, listTemplates, listTrips, reorderTemplates, saveTemplate, setActiveTrip, updateTrip } from '../daily/tripRepo';

export function TripSection() {
  const { db, ctx, trip, toast } = useApp();
  const trips = useLiveQuery(() => listTrips(db), [db]) ?? [];
  const [t, setT] = useState(trip);
  useEffect(() => setT(trip), [trip]);
  const [rateText, setRateText] = useState(trip.jpyPerIdr ? String(trip.jpyPerIdr) : '');

  const save = async () => {
    if (!isLocalDate(t.startDate) || !isLocalDate(t.endDate) || t.endDate < t.startDate) return toast('期間の日付を確認してください', { kind: 'error' });
    try {
      new Intl.DateTimeFormat('en', { timeZone: t.timeZone });
    } catch {
      return toast('タイムゾーンが正しくありません（例：Asia/Jakarta）', { kind: 'error' });
    }
    const rate = numOrNull(rateText);
    if (rate != null && rate <= 0) return toast('レートは正の数で入力してください', { kind: 'error' });
    await updateTrip(ctx, trip, { name: t.name, startDate: t.startDate, endDate: t.endDate, timeZone: t.timeZone, jpyPerIdr: rate, rateDate: rate ? (t.rateDate ?? null) : null });
    toast('保存しました');
  };

  return (
    <div>
      {trips.length > 1 && (
        <section className="card">
          <h2>表示する旅行</h2>
          <select value={trip.id} onChange={(e) => void setActiveTrip(db, e.target.value)}>
            {trips.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}（{x.startDate}〜{x.endDate}）
              </option>
            ))}
          </select>
        </section>
      )}
      <section className="card">
        <h2>旅行</h2>
        <Field label="名前">
          <input value={t.name} onChange={(e) => setT({ ...t, name: e.target.value })} />
        </Field>
        <div className="row">
          <Field label="開始日（DAY 01）">
            <input type="date" value={t.startDate} onChange={(e) => setT({ ...t, startDate: e.target.value })} />
          </Field>
          <Field label="終了日">
            <input type="date" value={t.endDate} onChange={(e) => setT({ ...t, endDate: e.target.value })} />
          </Field>
        </div>
        <Field label="タイムゾーン" hint="記録対象日の「今日」を決めます。端末のタイムゾーンを変えても過去の記録の日付は変わりません">
          <input value={t.timeZone} onChange={(e) => setT({ ...t, timeZone: e.target.value })} />
        </Field>
        <div className="row">
          <Field label="手動レート（1 IDR あたりの円）" hint="例：0.0095。入れたときだけ円の参考額を表示します">
            <input inputMode="decimal" value={rateText} onChange={(e) => setRateText(e.target.value)} />
          </Field>
          <Field label="レートの適用日">
            <input type="date" value={t.rateDate ?? ''} onChange={(e) => setT({ ...t, rateDate: e.target.value || null })} />
          </Field>
        </div>
        <button className="btn primary" onClick={() => void save()}>保存</button>
        <p className="muted small">期間外（出発前・帰国後）の日にも記録できます。</p>
      </section>
      <section className="card">
        <button
          className="btn ghost"
          onClick={async () => {
            const name = prompt('新しい旅行の名前', '新しい旅行');
            if (!name) return;
            const nt = await createTrip(ctx, { name });
            await setActiveTrip(db, nt.id);
            toast('新しい旅行を作りました');
          }}
        >
          新しい旅行を作る
        </button>
      </section>
    </div>
  );
}

export function TemplatesSection() {
  const { db, ctx, trip, toast } = useApp();
  const tpls = useLiveQuery(() => listTemplates(db, trip.id), [db, trip.id]) ?? [];
  const [newTitle, setNewTitle] = useState('');
  const move = async (i: number, d: number) => {
    const arr = [...tpls];
    const j = i + d;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    await reorderTemplates(ctx, arr);
  };
  return (
    <div>
      <p className="small">変更は、まだ作っていない日の日記に使われます。記録を始めた日の質問文は日記に保存してあるので、ここを直しても過去の日記は変わりません。</p>
      {tpls.map((t, i) => (
        <TemplateRow key={t.id} t={t} onMove={(d) => void move(i, d)} />
      ))}
      <section className="card">
        <h2>質問を追加</h2>
        <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder="例：外国人材の話で気づいたことは？" />
        <button
          className="btn"
          disabled={!newTitle.trim()}
          onClick={async () => {
            await addTemplate(ctx, trip.id, newTitle.trim(), [], tpls.length);
            setNewTitle('');
            toast('追加しました');
          }}
        >
          追加
        </button>
      </section>
    </div>
  );
}

function TemplateRow({ t, onMove }: { t: QuestionTemplate; onMove: (d: number) => void }) {
  const { ctx, toast } = useApp();
  const [title, setTitle] = useState(t.title);
  const [hints, setHints] = useState(t.hints.join('\n'));
  const dirty = title !== t.title || hints !== t.hints.join('\n');
  return (
    <section className={'card' + (t.enabled ? '' : ' disabled')}>
      <div className="card-head">
        <span className="muted small">{t.questionId}</span>
        <span className="actions">
          <button className="icon-btn" aria-label="上へ" onClick={() => onMove(-1)}>↑</button>
          <button className="icon-btn" aria-label="下へ" onClick={() => onMove(1)}>↓</button>
          <label className="check-inline">
            <input type="checkbox" checked={t.enabled} onChange={(e) => void saveTemplate(ctx, { ...t, enabled: e.target.checked })} /> 使う
          </label>
        </span>
      </div>
      <Field label="質問">
        <input value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="補助質問（1行に1つ）">
        <textarea rows={3} value={hints} onChange={(e) => setHints(e.target.value)} />
      </Field>
      {dirty && (
        <button
          className="btn small primary"
          onClick={async () => {
            await saveTemplate(ctx, { ...t, title: title.trim() || t.title, hints: hints.split('\n').map((h) => h.trim()).filter(Boolean) });
            toast('保存しました');
          }}
        >
          保存
        </button>
      )}
    </section>
  );
}

export function StorageSection() {
  const { db, toast } = useApp();
  const [est, setEst] = useState<{ usage?: number; quota?: number } | null>(null);
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const compress = useLiveQuery(() => getSetting<boolean>(db, 'compressPhotosForCloud', false), [db]) ?? false;
  const maxMin = useLiveQuery(() => getSetting<number>(db, 'maxClipMinutes', 15), [db]) ?? 15;
  const blobBytes = useLiveQuery(async () => (await db.blobs.toArray()).reduce((s, b) => s + b.size, 0), [db]) ?? 0;

  useEffect(() => {
    void navigator.storage?.estimate?.().then(setEst).catch(() => setEst(null));
    void navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
  }, []);

  return (
    <div>
      <section className="card">
        <h2>端末の保存状況</h2>
        <ul className="kv">
          <li><span>この領域の音声・写真</span><span>{formatBytes(blobBytes)}</span></li>
          <li><span>ブラウザの使用量（目安）</span><span>{est?.usage != null ? formatBytes(est.usage) : '取得できません'}</span></li>
          <li><span>使用できる上限（目安）</span><span>{est?.quota != null ? formatBytes(est.quota) : '取得できません'}</span></li>
          <li><span>永続化</span><span>{persisted == null ? '不明' : persisted ? '許可済み' : '未許可'}</span></li>
        </ul>
        <button
          className="btn"
          onClick={async () => {
            const ok = await navigator.storage?.persist?.();
            setPersisted(!!ok);
            toast(ok ? '永続化が許可されました（それでも ZIP での退避は続けてください）' : '永続化は許可されませんでした。ホーム画面に追加すると許可されやすくなります');
          }}
        >
          データの永続化を要求する
        </button>
        <p className="muted small">永続化はブラウザによる自動削除を防ぐ目安で、保証ではありません。古い素材を自動で消すことはしません。</p>
      </section>
      <section className="card">
        <h2>写真</h2>
        <label className="check-inline">
          <input type="checkbox" checked={compress} onChange={(e) => void setSetting(db, 'compressPhotosForCloud', e.target.checked)} />
          容量節約モード：クラウドには長辺1600px・JPEG の圧縮版を送る（原本はこの端末に残す）
        </label>
      </section>
      <section className="card">
        <h2>録音</h2>
        <Field label="1クリップの録音時間の上限（分）">
          <select value={maxMin} onChange={(e) => void setSetting(db, 'maxClipMinutes', Number(e.target.value))}>
            {[5, 10, 15, 20, 30].map((n) => (
              <option key={n} value={n}>
                {n}分
              </option>
            ))}
          </select>
        </Field>
      </section>
    </div>
  );
}
