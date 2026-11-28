import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { navigate } from '../../app/router';
import { Thumb } from '../../components/ui';
import { recordVisitLocation } from '../checklist/visitLocation';
import { getSetting } from '../../db/db';
import type { ChecklistItem, Expense, Media, Note } from '../../db/types';
import { addDays, dayLabel, shortDate, timeIn, todayIn, weekdayJa } from '../../lib/dates';
import { formatMoney } from '../../lib/format';
import { listItems, progress, setItemStatus, TYPE_TEXT } from '../checklist/checklistRepo';
import { loadDiary } from '../diary/diaryRepo';
import { ExpenseSheet } from '../expenses/ExpenseSheet';
import { expensesOn, totalsByCurrency } from '../expenses/expenseRepo';
import { MediaSheet } from '../media/MediaSheet';
import { mediaOn } from '../media/mediaRepo';
import { PhotoButton } from '../media/PhotoButton';
import { NoteSheet } from '../notes/NoteSheet';
import { notesOn } from '../notes/notesRepo';
import { SyncStatusLine } from '../sync/SyncStatus';
import { byPlanned, formatPeriod, isOverdue, isPlannedOn, periodOf } from '../checklist/period';
import { pendingInboxCount } from '../inbox/inboxRepo';
import { usePendingShares } from '../inbox/InboxScreen';
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
  const { db, ctx, trip, date, toast, today, openHere } = useApp();
  const [sheet, setSheet] = useState<null | { kind: 'note'; note?: Note } | { kind: 'expense'; expense?: Expense } | { kind: 'media'; media: Media }>(null);

  const diary = useLiveQuery(() => loadDiary(db, trip.id, date), [db, trip.id, date]);
  const drafts = useLiveQuery(() => db.drafts.count(), [db]) ?? 0;
  const tasks = useLiveQuery(() => listItems(db, trip.id, 'task'), [db, trip.id]) ?? [];
  const inboxCount = useLiveQuery(() => pendingInboxCount(db, trip.id), [db, trip.id]) ?? 0;
  const shares = usePendingShares();
  const foods = useLiveQuery(() => listItems(db, trip.id, 'food'), [db, trip.id]) ?? [];
  const notes = useLiveQuery(() => notesOn(db, trip.id, date), [db, trip.id, date]) ?? [];
  const media = useLiveQuery(() => mediaOn(db, trip.id, date), [db, trip.id, date]) ?? [];
  const expenses = useLiveQuery(() => expensesOn(db, trip.id, date), [db, trip.id, date]) ?? [];
  const lastBackup = useLiveQuery(() => getSetting<string | null>(db, 'lastBackupAt', null), [db]);
  const lastExternal = useLiveQuery(() => getSetting<string | null>(db, 'lastExternalSaveAt', null), [db]);

  // 今日のやること：予定日がこの日のもの＋この日に完了したもの。なければ未完了の上位
  // 選んだ日が予定（期間）に入るもの＋その日に完了したもの
  const todays = tasks.filter((t) => isPlannedOn(t, date) || (t.status === 'done' && t.completedDate === date)).sort(byPlanned);
  const overdueCount = tasks.filter((t) => isOverdue(t, today)).length;
  // 予定のない日は未完了の上位を出す。予定を過ぎたものは下の「予定を過ぎた未完了」ボタンにまとめ、ここには出さない
  const shownTasks = todays.length ? todays : tasks.filter((t) => t.status === 'open' && !isOverdue(t, today)).sort((a, b) => prio(a) - prio(b)).slice(0, 3);
  const todayProg = progress(todays);
  const foodProg = progress(foods);
  const shownFoods = [...foods.filter((f) => f.plannedDate === date), ...foods.filter((f) => f.status === 'open' && f.plannedDate !== date && !isOverdue(f, today))].slice(0, 6);

  const toggle = async (item: ChecklistItem) => {
    const next = item.status === 'done' ? 'open' : 'done';
    await setItemStatus(ctx, item, next, date);
    // 店・場所に行ったものは、その場所を記録する（位置情報が許可されているときだけ）
    if (next === 'done') void recordVisitLocation(ctx, item);
    if (next === 'open') {
      toast(`「${item.title}」のチェックを外しました${item.type === 'food' ? '（実食の記録は残っています）' : ''}`, {
        action: { label: '元に戻す', run: () => void setItemStatus(ctx, { ...item, status: 'open' }, 'done', item.completedDate ?? date) },
      });
    } else {
      toast(`「${item.title}」を${TYPE_TEXT[item.type].done}にしました（${date}）`, {
        action: { label: 'メモを追加', run: () => navigate(`item/${item.id}`) },
      });
    }
  };

  // 📍 現在地：押すだけでメモとして記録する（あとから本文を書き足せる）
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

      <section className="card inbox-card">
        <div className="card-head">
          <button className="card-head as-button" onClick={() => navigate('inbox')}>
            <h2>📥 未整理ボックス</h2>
            <span className={inboxCount + shares.length > 0 ? 'badge strong' : 'muted'}>
              {inboxCount + shares.length > 0 ? `未整理 ${inboxCount + shares.length} 件` : 'なし'}
            </span>
          </button>
        </div>
        <div className="actions">
          <button className="btn small" onClick={() => navigate('inbox/new?paste=1')}>📋 貼り付けて取り込む</button>
          <button className="btn small ghost" onClick={() => navigate('inbox/new')}>＋ 入力</button>
          {shares.length > 0 && (
            <button className="btn small" onClick={() => navigate(`share?id=${shares[0].id}`)}>受け取った共有 {shares.length} 件を登録</button>
          )}
        </div>
      </section>

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
            <CheckRow key={t.id} item={t} onToggle={toggle} compact />
          ))}
        </ul>
        <div className="actions">
          <button className="btn small" onClick={() => navigate(`lists/task?add=1&date=${date}`)}>＋追加</button>
          <button className="btn small ghost" onClick={() => navigate('lists/task')}>すべて見る</button>
          {overdueCount > 0 && (
            <button className="btn small overdue-link" onClick={() => navigate('lists/task?f=overdue')}>
              ⚠ 予定を過ぎた未完了 {overdueCount} 件
            </button>
          )}
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
          <button className="btn" onClick={openHere}>📍 現在地</button>
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

export function CheckRow(props: { item: ChecklistItem; onToggle: (i: ChecklistItem) => void; detail?: boolean; compact?: boolean }) {
  const { today } = useApp();
  const i = props.item;
  const period = periodOf(i);
  const overdue = isOverdue(i, today);
  const multi = !!period && period.end !== period.start;
  return (
    <li className={'check-row ' + i.status + (overdue ? ' overdue' : '')}>
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
        {overdue && <span className="overdue-badge">予定を過ぎています（{formatPeriod(period!)}）</span>}
        {props.detail && (
          <span className="muted small">
            {[
              i.localName,
              i.area,
              period && !overdue && `予定 ${formatPeriod(period)}`,
              i.completedDate && `完了 ${i.completedDate}`,
              i.location && '📍',
              i.urls?.length && `🔗${i.urls.length}`,
              i.priority === 'high' && '優先度:高',
              i.status === 'skipped' && '見送り',
            ]
              .filter(Boolean)
              .join('・')}
          </span>
        )}
        {props.compact && multi && !overdue && <span className="muted small">期間 {formatPeriod(period!)}</span>}
      </button>
    </li>
  );
}
