import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { navigate } from '../../app/router';
import { Thumb } from '../../components/ui';
import { getSetting } from '../../db/db';
import type { ChecklistItem, Expense, Media, Note } from '../../db/types';
import { addDays, dayLabel, shortDate, timeIn, todayIn, weekdayJa } from '../../lib/dates';
import { formatMoney } from '../../lib/format';
import { listItems, progress, setItemStatus } from '../checklist/checklistRepo';
import { loadDiary } from '../diary/diaryRepo';
import { ExpenseSheet } from '../expenses/ExpenseSheet';
import { expensesOn, totalsByCurrency } from '../expenses/expenseRepo';
import { MediaSheet } from '../media/MediaSheet';
import { mediaOn } from '../media/mediaRepo';
import { PhotoButton } from '../media/PhotoButton';
import { NoteSheet } from '../notes/NoteSheet';
import { blankNote, notesOn, saveNote } from '../notes/notesRepo';
import { formatPosition, getCurrentPosition } from '../../lib/geo';
import { SyncStatusLine } from '../sync/SyncStatus';
import { RatingsCard } from './RatingsCard';

export function DateHeader() {
  const { trip, date, setDate, today } = useApp();
  const dl = dayLabel(date, trip.startDate, trip.endDate);
  return (
    <header className="date-header">
      <div className="app-title">Indonesia Travel Log</div>
      <div className="date-line">
        <label className="date-pick">
          <strong>{shortDate(date)}</strong> {weekdayJa(date)}
          <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="日付を選ぶ" />
        </label>
        <span className={'day-badge ' + dl.kind}>{dl.label}</span>
      </div>
      <div className="date-nav">
        <button className="btn ghost" onClick={() => setDate(addDays(date, -1))}>＜ 前日</button>
        {date !== today && (
          <button className="btn ghost" onClick={() => setDate(today)}>今日へ</button>
        )}
        <button className="btn ghost" onClick={() => setDate(addDays(date, 1))}>翌日 ＞</button>
      </div>
      {date !== today && <p className="notice small">表示中の {date} に保存されます（今日は {today}）</p>}
    </header>
  );
}

export function TodayScreen() {
  const { db, ctx, trip, date, toast } = useApp();
  const [sheet, setSheet] = useState<null | { kind: 'note'; note?: Note } | { kind: 'expense'; expense?: Expense } | { kind: 'media'; media: Media }>(null);

  const diary = useLiveQuery(() => loadDiary(db, trip.id, date), [db, trip.id, date]);
  const drafts = useLiveQuery(() => db.drafts.count(), [db]) ?? 0;
  const tasks = useLiveQuery(() => listItems(db, trip.id, 'task'), [db, trip.id]) ?? [];
  const foods = useLiveQuery(() => listItems(db, trip.id, 'food'), [db, trip.id]) ?? [];
  const notes = useLiveQuery(() => notesOn(db, trip.id, date), [db, trip.id, date]) ?? [];
  const media = useLiveQuery(() => mediaOn(db, trip.id, date), [db, trip.id, date]) ?? [];
  const expenses = useLiveQuery(() => expensesOn(db, trip.id, date), [db, trip.id, date]) ?? [];
  const lastBackup = useLiveQuery(() => getSetting<string | null>(db, 'lastBackupAt', null), [db]);
  const lastExternal = useLiveQuery(() => getSetting<string | null>(db, 'lastExternalSaveAt', null), [db]);

  // 今日のやること：予定日がこの日のもの＋この日に完了したもの。なければ未完了の上位
  const todays = tasks.filter((t) => t.plannedDate === date || (t.status === 'done' && t.completedDate === date));
  const shownTasks = todays.length ? todays : tasks.filter((t) => t.status === 'open').sort((a, b) => prio(a) - prio(b)).slice(0, 3);
  const todayProg = progress(todays);
  const foodProg = progress(foods);
  const shownFoods = [...foods.filter((f) => f.plannedDate === date), ...foods.filter((f) => f.status === 'open' && f.plannedDate !== date)].slice(0, 6);

  const toggle = async (item: ChecklistItem) => {
    const next = item.status === 'done' ? 'open' : 'done';
    await setItemStatus(ctx, item, next, date);
    if (next === 'open') {
      toast(`「${item.title}」のチェックを外しました${item.type === 'food' ? '（実食の記録は残っています）' : ''}`, {
        action: { label: '元に戻す', run: () => void setItemStatus(ctx, { ...item, status: 'open' }, 'done', item.completedDate ?? date) },
      });
    } else {
      toast(`「${item.title}」を${item.type === 'food' ? '食べた' : '完了'}にしました（${date}）`, {
        action: { label: 'メモを追加', run: () => navigate(`item/${item.id}`) },
      });
    }
  };

  // 📍 現在地：押すだけでメモとして記録する（あとから本文を書き足せる）
  const [locating, setLocating] = useState(false);
  const recordHere = async () => {
    setLocating(true);
    try {
      const pos = await getCurrentPosition();
      const note = await saveNote(ctx, {
        ...blankNote(trip.id, date),
        body: `📍 現在地（${timeIn(trip.timeZone, new Date().toISOString())}）`,
        category: '観光・移動',
        location: formatPosition(pos),
      });
      toast(`現在地を記録しました（±${Math.round(pos.accuracy)}m）`, {
        action: { label: 'メモを書く', run: () => setSheet({ kind: 'note', note }) },
      });
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    } finally {
      setLocating(false);
    }
  };

  const answered = diary?.answeredIds.size ?? 0;
  const skipped = diary?.skippedIds.size ?? 0;
  const total = diary?.questions.length ?? 0;
  const backupDays = lastBackup ? Math.floor((Date.now() - Date.parse(lastBackup)) / 86400000) : null;

  return (
    <div className="screen">
      <DateHeader />
      <SyncStatusLine />
      {drafts > 0 && (
        <button className="banner warn" onClick={() => navigate('diary')}>
          ⚠ 中断された録音が {drafts} 件あります。確認する →
        </button>
      )}

      <section className="card diary-card">
        <h2>🎙 音声日記</h2>
        <p>
          回答済み {answered}/{total}　スキップ {skipped}
          {diary && diary.freeClips.length > 0 && `　自由録音 ${diary.freeClips.length}`}
        </p>
        <div className="progress" aria-hidden>
          <div style={{ width: total ? `${(answered / total) * 100}%` : 0 }} />
        </div>
        <button className="btn primary big" onClick={() => navigate('diary')}>
          質問を見ながら録音
        </button>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>やること</h2>
          <span className="muted">{todays.length ? `今日 ${todayProg.done}/${todayProg.total}` : '予定なし・未完了から表示'}</span>
        </div>
        <ul className="checklist">
          {shownTasks.map((t) => (
            <CheckRow key={t.id} item={t} onToggle={toggle} />
          ))}
        </ul>
        <div className="actions">
          <button className="btn small" onClick={() => navigate(`lists/task?add=1&date=${date}`)}>＋追加</button>
          <button className="btn small ghost" onClick={() => navigate('lists/task')}>すべて見る</button>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>食べたいもの</h2>
          <span className="muted">全体 {foodProg.done}/{foodProg.total}</span>
        </div>
        <ul className="checklist two-col">
          {shownFoods.map((t) => (
            <CheckRow key={t.id} item={t} onToggle={toggle} />
          ))}
        </ul>
        <div className="actions">
          <button className="btn small" onClick={() => navigate(`lists/food?add=1`)}>＋追加</button>
          <button className="btn small ghost" onClick={() => navigate('lists/food')}>すべて見る</button>
        </div>
      </section>

      <section className="card">
        <div className="quick">
          <button className="btn" onClick={() => setSheet({ kind: 'note' })}>📝 メモ</button>
          <PhotoButton date={date} />
          <button className="btn" onClick={() => setSheet({ kind: 'expense' })}>💰 支出</button>
          <button className="btn" disabled={locating} onClick={() => void recordHere()}>
            {locating ? '取得中…' : '📍 現在地'}
          </button>
        </div>
        {notes.length > 0 && (
          <ul className="list">
            {notes.map((n) => (
              <li key={n.id}>
                <button className="row-btn" onClick={() => setSheet({ kind: 'note', note: n })}>
                  <span className="muted small">
                    {timeIn(trip.timeZone, n.createdAt)} {n.category}
                    {n.location && ' 📍'}
                  </span>
                  <span className="clamp">{n.body}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {media.length > 0 && (
          <div className="thumbs">
            {media.map((m) => (
              <Thumb key={m.id} blobId={m.blobId} thumbId={m.thumbnailBlobId} alt={m.caption || '写真'} onClick={() => setSheet({ kind: 'media', media: m })} />
            ))}
          </div>
        )}
        {expenses.length > 0 && (
          <div className="expenses-mini">
            {expenses.map((e) => (
              <button key={e.id} className="row-btn" onClick={() => setSheet({ kind: 'expense', expense: e })}>
                <span>{e.kind === 'refund' ? '返金 ' : ''}{e.category} {e.shop}</span>
                <span>{formatMoney(e.amount, e.currency)}</span>
              </button>
            ))}
            <p className="muted small">
              {totalsByCurrency(expenses)
                .map((t) => `${t.currency}合計 ${formatMoney(t.total, t.currency)}`)
                .join('　')}
            </p>
          </div>
        )}
      </section>

      <RatingsCard />

      <button className={'status-line' + (backupDays == null || backupDays >= 3 ? ' warn' : '')} onClick={() => navigate('settings/backup')}>
        最終バックアップ：{lastBackup ? `${todayIn(trip.timeZone, new Date(lastBackup))}（${backupDays}日前）` : '未作成'}
        {lastExternal ? `／外部保存 ${todayIn(trip.timeZone, new Date(lastExternal))}` : ''}
      </button>

      {sheet?.kind === 'note' && <NoteSheet note={sheet.note} date={date} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'expense' && <ExpenseSheet expense={sheet.expense} date={date} onClose={() => setSheet(null)} />}
      {sheet?.kind === 'media' && <MediaSheet media={sheet.media} onClose={() => setSheet(null)} />}
    </div>
  );
}

const prio = (i: ChecklistItem) => (i.priority === 'high' ? 0 : i.priority === 'normal' ? 1 : 2);

export function CheckRow(props: { item: ChecklistItem; onToggle: (i: ChecklistItem) => void; detail?: boolean }) {
  const i = props.item;
  return (
    <li className={'check-row ' + i.status}>
      <button
        className="check"
        role="checkbox"
        aria-checked={i.status === 'done'}
        aria-label={`${i.title}を${i.status === 'done' ? '未完了に戻す' : '完了にする'}`}
        onClick={() => props.onToggle(i)}
      >
        {i.status === 'done' ? '☑' : i.status === 'skipped' ? '⊘' : '☐'}
      </button>
      <button className="check-title" onClick={() => navigate(`item/${i.id}`)}>
        <span>{i.title}</span>
        {props.detail && (
          <span className="muted small">
            {[i.localName, i.area, i.plannedDate && `予定 ${i.plannedDate}`, i.completedDate && `完了 ${i.completedDate}`, i.priority === 'high' && '優先度:高', i.status === 'skipped' && '見送り']
              .filter(Boolean)
              .join('・')}
          </span>
        )}
      </button>
    </li>
  );
}
