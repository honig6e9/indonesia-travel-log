import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { navigate } from '../../app/router';
import { AudioPlayer, Empty, Thumb } from '../../components/ui';
import type { Expense, Media, Note } from '../../db/types';
import { addDays, dayLabel, shortDate, timeIn, weekdayJa } from '../../lib/dates';
import { formatDuration, formatMoney } from '../../lib/format';
import { loadDiary } from '../diary/diaryRepo';
import { ExpenseSheet } from '../expenses/ExpenseSheet';
import { MediaSheet } from '../media/MediaSheet';
import { NoteSheet } from '../notes/NoteSheet';
import { missingBlobs } from '../sync/engine';
import { loadTripData } from './historyData';

/** 日別タイムライン。作成日時（いつ書いたか）と記録対象日（どの日の記録か）を分けて表示する */
export function DayScreen(props: { date: string }) {
  const { db, trip, setDate, sync, toast } = useApp();
  const date = props.date;
  const diary = useLiveQuery(() => loadDiary(db, trip.id, date), [db, trip.id, date]);
  const data = useLiveQuery(() => loadTripData(db, trip.id), [db, trip.id]);
  const missing = useLiveQuery(() => missingBlobs(db, { localDate: date }), [db, date]) ?? [];
  const [sheet, setSheet] = useState<null | { note: Note } | { expense: Expense } | { media: Media }>(null);
  if (!diary || !data) return <div className="screen">読み込み中…</div>;
  const dl = dayLabel(date, trip.startDate, trip.endDate);

  type Ev = { at: string; key: string; node: React.ReactNode };
  const evs: Ev[] = [];
  const t = (iso: string) => timeIn(trip.timeZone, iso);
  const created = (iso: string) => {
    if (!iso || Number.isNaN(Date.parse(iso))) return '';
    const d = new Intl.DateTimeFormat('en-CA', { timeZone: trip.timeZone }).format(new Date(iso));
    return d === date ? t(iso) : `${d.slice(5)} ${t(iso)} に記録`;
  };
  for (const c of diary.clips) {
    const qi = diary.questions.findIndex((q) => q.questionId === c.questionId);
    evs.push({
      at: c.createdAt,
      key: c.id,
      node: (
        <>
          <span className="muted small">{created(c.createdAt)}　🎙 {qi >= 0 ? `Q${qi + 1}. ${diary.questions[qi].title}` : '自由録音'}</span>
          <AudioPlayer blobId={c.blobId} durationMs={c.durationMs} label={formatDuration(c.durationMs)} />
        </>
      ),
    });
  }
  for (const [qid, a] of diary.answers)
    if (a.note.trim())
      evs.push({ at: a.updatedAt, key: a.id, node: <span><span className="muted small">補足（{diary.questions.find((q) => q.questionId === qid)?.title ?? qid}）</span><br />{a.note}</span> });
  for (const n of data.notes.filter((x) => x.localDate === date))
    evs.push({ at: n.createdAt, key: n.id, node: <button className="row-btn" onClick={() => setSheet({ note: n })}><span className="muted small">{created(n.createdAt)}　📝 {n.category}{n.location ? `　📍 ${n.location}` : ''}</span><span>{n.body}</span></button> });
  for (const m of data.media.filter((x) => x.localDate === date))
    evs.push({ at: m.createdAt, key: m.id, node: <div className="tl-photo"><Thumb blobId={m.blobId} thumbId={m.thumbnailBlobId} alt={m.caption || '写真'} onClick={() => setSheet({ media: m })} /><span className="small">{m.caption}</span></div> });
  for (const i of data.items.filter((x) => x.status === 'done' && x.completedDate === date))
    evs.push({ at: i.updatedAt, key: i.id, node: <button className="row-btn" onClick={() => navigate(`item/${i.id}`)}><span>{i.type === 'task' ? '☑' : i.type === 'place' ? '📍' : '🍜'} {i.title}</span></button> });
  for (const e of data.exps.filter((x) => x.localDate === date)) {
    const it = data.items.find((x) => x.id === e.checklistItemId);
    evs.push({ at: e.createdAt, key: e.id, node: <button className="row-btn" onClick={() => navigate(`item/${e.checklistItemId}`)}><span>🍜 実食：{it?.title} {e.shop}</span><span>{e.price != null ? formatMoney(e.price, e.currency) : ''}</span></button> });
  }
  for (const e of data.expenses.filter((x) => x.localDate === date))
    evs.push({ at: e.createdAt, key: e.id, node: <button className="row-btn" onClick={() => setSheet({ expense: e })}><span>💰 {e.kind === 'refund' ? '返金 ' : ''}{e.category} {e.shop}</span><span>{formatMoney(e.amount, e.currency)}</span></button> });
  evs.sort((a, b) => a.at.localeCompare(b.at));

  return (
    <div className="screen">
      <header className="diary-head">
        <button className="btn ghost" onClick={() => navigate(`day/${addDays(date, -1)}`, { replace: true })}>＜</button>
        <strong>
          {shortDate(date)} {weekdayJa(date)}　{dl.label}
        </strong>
        <button className="btn ghost" onClick={() => navigate(`day/${addDays(date, 1)}`, { replace: true })}>＞</button>
      </header>
      <div className="actions">
        <button className="btn small" onClick={() => { setDate(date); navigate('today'); }}>この日を記録・編集する</button>
        {missing.length > 0 && (
          <button
            className="btn small"
            onClick={async () => {
              const r = await sync.fetchMedia({ localDate: date });
              if (!r) toast(sync.reason ?? '同期中です。少し待ってから再試行してください');
              else toast(r.failed.length ? `取得できなかったファイル ${r.failed.length} 件` : `${r.fetched} 件を端末に保存しました`);
            }}
          >
            この日の素材を端末に保存（未取得 {missing.length}）
          </button>
        )}
      </div>
      {evs.length === 0 ? <Empty>この日の記録はありません。</Empty> : <ul className="timeline">{evs.map((e) => <li key={e.key}>{e.node}</li>)}</ul>}
      {sheet && 'note' in sheet && <NoteSheet note={sheet.note} date={date} onClose={() => setSheet(null)} />}
      {sheet && 'expense' in sheet && <ExpenseSheet expense={sheet.expense} date={date} onClose={() => setSheet(null)} />}
      {sheet && 'media' in sheet && <MediaSheet media={sheet.media} onClose={() => setSheet(null)} />}
    </div>
  );
}
