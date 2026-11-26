import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { navigate } from '../../app/router';
import { Empty, Sheet } from '../../components/ui';
import type { ChecklistItem, ChecklistType } from '../../db/types';
import { percent } from '../../lib/format';
import { CheckRow } from '../daily/TodayScreen';
import { addItems, listItems, parseBulk, parseImportFile, progress, SAMPLE_FOODS, SAMPLE_TASKS, setItemStatus, type ImportItem } from './checklistRepo';
import { ImportSheet } from './ImportSheet';
import { transact } from '../../db/repo';

type StatusFilter = 'all' | 'open' | 'done' | 'skipped';
type DateFilter = 'all' | 'today' | 'planned' | 'unplanned';

export function ListsScreen(props: { type: ChecklistType }) {
  const { db, ctx, trip, date, toast } = useApp();
  const type = props.type;
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  const itemsQ = useLiveQuery(() => listItems(db, trip.id, type), [db, trip.id, type]);
  const items = useMemo(() => itemsQ ?? [], [itemsQ]);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [dateF, setDateF] = useState<DateFilter>('all');
  const [area, setArea] = useState('');
  const [prio, setPrio] = useState('');
  const [q, setQ] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [bulk, setBulk] = useState<string | null>(null);
  const [importing, setImporting] = useState<{ items: ImportItem[]; errors: string[]; existing: ChecklistItem[] } | null>(null);
  const [reorder, setReorder] = useState(false);
  const plannedFromQuery = params.get('date');

  const areas = useMemo(() => [...new Set(items.map((i) => i.area).filter(Boolean))], [items]);
  const filtered = items.filter(
    (i) =>
      (status === 'all' || i.status === status) &&
      (dateF === 'all' ||
        (dateF === 'today' && (i.plannedDate === date || i.completedDate === date)) ||
        (dateF === 'planned' && !!i.plannedDate) ||
        (dateF === 'unplanned' && !i.plannedDate)) &&
      (!area || i.area === area) &&
      (!prio || i.priority === prio) &&
      (!q || [i.title, i.localName, i.area, i.note].some((s) => s?.toLowerCase().includes(q.toLowerCase()))),
  );
  const p = progress(items);

  const toggle = async (item: ChecklistItem) => {
    const next = item.status === 'done' ? 'open' : 'done';
    await setItemStatus(ctx, item, next, date);
    if (next === 'open')
      toast(`チェックを外しました${type === 'food' ? '（実食の記録は残っています）' : ''}`, {
        action: { label: '元に戻す', run: () => void setItemStatus(ctx, { ...item, status: 'open' }, 'done', item.completedDate ?? date) },
      });
    else toast(`${date} に${type === 'food' ? '食べた' : '完了'}として記録しました`, { action: { label: 'メモを追加', run: () => navigate(`item/${item.id}`) } });
  };

  const addOne = async () => {
    const t = newTitle.trim();
    if (!t) return;
    await addItems(ctx, trip.id, type, [t], plannedFromQuery);
    setNewTitle('');
    toast(`「${t}」を追加しました`);
  };

  const move = async (i: number, d: number) => {
    const arr = [...items];
    const j = i + d;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    await transact(ctx, async (w) => {
      for (const [k, it] of arr.entries()) if (it.sortOrder !== k) await w.put('checklistItem', { ...it, sortOrder: k });
    });
  };

  return (
    <div className="screen">
      <div className="segmented" role="tablist">
        <button role="tab" aria-selected={type === 'task'} className={type === 'task' ? 'on' : ''} onClick={() => navigate('lists/task', { replace: true })}>
          やること
        </button>
        <button role="tab" aria-selected={type === 'food'} className={type === 'food' ? 'on' : ''} onClick={() => navigate('lists/food', { replace: true })}>
          食べたいもの
        </button>
      </div>
      <p className="muted">
        {type === 'task' ? '完了' : '食べた'} {p.done}/{p.total}　見送り {p.skipped}　達成率 {percent(p.done, p.total)}
      </p>

      <div className="add-row">
        <input
          value={newTitle}
          autoFocus={params.get('add') === '1'}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void addOne()}
          placeholder={type === 'task' ? '例：KRLに乗る' : '例：Soto Ayam（ソトアヤム）'}
          aria-label="追加する項目"
        />
        <button className="btn primary" onClick={() => void addOne()}>追加</button>
      </div>
      {plannedFromQuery && <p className="muted small">予定日 {plannedFromQuery} として追加します</p>}
      <div className="actions">
        <button className="btn small ghost" onClick={() => setBulk('')}>まとめて追加</button>
        <button className="btn small ghost" onClick={() => setBulk(type === 'task' ? SAMPLE_TASKS : SAMPLE_FOODS)}>候補サンプルから選ぶ</button>
        <label className="btn small ghost file-btn">
          ファイルから取り込む
          <input
            type="file"
            accept=".json,application/json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              if (f.size > 5 * 1024 * 1024) return toast('ファイルが大きすぎます', { kind: 'error' });
              const parsed = parseImportFile(await f.text());
              if (parsed.items.length === 0) return toast(parsed.errors[0] ?? '取り込める項目がありません', { kind: 'error' });
              const all = [...(await listItems(db, trip.id, 'task')), ...(await listItems(db, trip.id, 'food'))];
              setImporting({ ...parsed, existing: all });
            }}
          />
        </label>
        <button className="btn small ghost" onClick={() => setReorder((r) => !r)}>{reorder ? '並べ替えを終える' : '並べ替え'}</button>
      </div>

      <details className="filters">
        <summary>絞り込み・検索</summary>
        <div className="row wrap">
          <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="状態">
            <option value="all">すべて</option>
            <option value="open">{type === 'task' ? '未完了' : '未体験'}</option>
            <option value="done">{type === 'task' ? '完了' : '食べた'}</option>
            <option value="skipped">見送り</option>
          </select>
          <select value={dateF} onChange={(e) => setDateF(e.target.value as DateFilter)} aria-label="予定日">
            <option value="all">予定日：すべて</option>
            <option value="today">選択日（{date}）</option>
            <option value="planned">予定あり</option>
            <option value="unplanned">予定なし</option>
          </select>
          <select value={area} onChange={(e) => setArea(e.target.value)} aria-label="エリア">
            <option value="">エリア：すべて</option>
            {areas.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </select>
          <select value={prio} onChange={(e) => setPrio(e.target.value)} aria-label="優先度">
            <option value="">優先度：すべて</option>
            <option value="high">高</option>
            <option value="normal">普通</option>
            <option value="low">低</option>
          </select>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="検索" aria-label="検索" />
        </div>
      </details>

      {items.length === 0 ? (
        <Empty>まだ項目がありません。上の欄から追加するか、「候補サンプルから選ぶ」で取り込めます。</Empty>
      ) : (
        <ul className="checklist">
          {(reorder ? items : filtered).map((i, k) =>
            reorder ? (
              <li key={i.id} className="check-row">
                <span className="check-title">{i.title}</span>
                <button className="icon-btn" aria-label="上へ" onClick={() => void move(k, -1)}>↑</button>
                <button className="icon-btn" aria-label="下へ" onClick={() => void move(k, 1)}>↓</button>
              </li>
            ) : (
              <CheckRow key={i.id} item={i} onToggle={toggle} detail />
            ),
          )}
        </ul>
      )}
      {!reorder && filtered.length === 0 && items.length > 0 && <Empty>条件に合う項目はありません。</Empty>}

      {importing && <ImportSheet items={importing.items} errors={importing.errors} existing={importing.existing} onClose={() => setImporting(null)} />}
      {bulk !== null && <BulkSheet type={type} initial={bulk} existing={items} onClose={() => setBulk(null)} />}
      <p className="muted small">項目をタップすると、予定日・エリア・見送り・体験メモなどを編集できます。</p>
    </div>
  );
}

function BulkSheet(props: { type: ChecklistType; initial: string; existing: ChecklistItem[]; onClose: () => void }) {
  const { ctx, trip, toast } = useApp();
  const [text, setText] = useState(props.initial);
  const [step, setStep] = useState<'edit' | 'confirm'>(props.initial ? 'confirm' : 'edit');
  const parsed = parseBulk(text, props.existing);
  const [skipDup, setSkipDup] = useState(true);
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const toAdd = parsed.filter((p, i) => !excluded.has(i) && !(skipDup && p.duplicate)).map((p) => p.line);
  return (
    <Sheet
      title={props.type === 'task' ? 'やることをまとめて追加' : '食べたいものをまとめて追加'}
      onClose={props.onClose}
      footer={
        step === 'edit' ? (
          <button className="btn primary" disabled={parsed.length === 0} onClick={() => setStep('confirm')}>
            確認へ（{parsed.length}件）
          </button>
        ) : (
          <>
            <button className="btn ghost" onClick={() => setStep('edit')}>戻って編集</button>
            <button
              className="btn primary"
              disabled={toAdd.length === 0}
              onClick={async () => {
                await addItems(ctx, trip.id, props.type, toAdd);
                toast(`${toAdd.length}件を追加しました`);
                props.onClose();
              }}
            >
              {toAdd.length}件を登録
            </button>
          </>
        )
      }
    >
      {step === 'edit' ? (
        <>
          <p className="small muted">1行に1項目。空行は無視します。</p>
          <textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </>
      ) : (
        <>
          <label className="check-inline">
            <input type="checkbox" checked={skipDup} onChange={(e) => setSkipDup(e.target.checked)} /> 重複の候補は登録しない
          </label>
          <ul className="bulk-preview">
            {parsed.map((p, i) => (
              <li key={i} className={p.duplicate ? 'dup' : ''}>
                <label>
                  <input
                    type="checkbox"
                    checked={!excluded.has(i) && !(skipDup && p.duplicate)}
                    disabled={skipDup && p.duplicate}
                    onChange={(e) => {
                      const s = new Set(excluded);
                      if (e.target.checked) s.delete(i);
                      else s.add(i);
                      setExcluded(s);
                    }}
                  />
                  {p.line} {p.duplicate && <span className="pill">重複の候補</span>}
                </label>
              </li>
            ))}
          </ul>
        </>
      )}
    </Sheet>
  );
}
