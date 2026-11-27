import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { navigate } from '../../app/router';
import { Empty } from '../../components/ui';
import { dayLabel, shortDate, timeIn, todayIn, weekdayJa } from '../../lib/dates';
import { formatMoney } from '../../lib/format';
import { convertIdr, totalsByCurrency } from '../expenses/expenseRepo';
import { RATING_LABELS } from '../daily/RatingsCard';
import { allTags, loadTripData, locationHistory, routeUrl, search, summarizeDays, type LocationEntry, type TripData } from './historyData';

type Tab = 'days' | 'places' | 'search' | 'stats';

export function HistoryScreen() {
  const { db, trip } = useApp();
  const [tab, setTab] = useState<Tab>('days');
  const data = useLiveQuery(() => loadTripData(db, trip.id), [db, trip.id]);
  return (
    <div className="screen">
      <div className="segmented">
        <button className={tab === 'days' ? 'on' : ''} onClick={() => setTab('days')}>日付</button>
        <button className={tab === 'places' ? 'on' : ''} onClick={() => setTab('places')}>📍 位置</button>
        <button className={tab === 'search' ? 'on' : ''} onClick={() => setTab('search')}>検索</button>
        <button className={tab === 'stats' ? 'on' : ''} onClick={() => setTab('stats')}>集計</button>
      </div>
      {!data ? <p>読み込み中…</p> : tab === 'days' ? <Days data={data} /> : tab === 'places' ? <Places data={data} /> : tab === 'search' ? <Search data={data} /> : <Stats data={data} />}
    </div>
  );
}

const KIND_ICON: Record<LocationEntry['kind'], string> = { note: '📍', expense: '💰', food: '🍜', place: '🏛', task: '☑' };

/** 位置の履歴：場所が入っている記録を、日ごと・時刻の順に並べる */
function Places({ data }: { data: TripData }) {
  const { trip } = useApp();
  const entries = useMemo(() => locationHistory(data, (iso) => todayIn(trip.timeZone, new Date(iso))), [data, trip.timeZone]);
  const days = useMemo(() => {
    const m = new Map<string, LocationEntry[]>();
    for (const e of entries) m.set(e.localDate, [...(m.get(e.localDate) ?? []), e]);
    return [...m.entries()];
  }, [entries]);
  if (days.length === 0)
    return <Empty>場所が入った記録はまだありません。画面下の「📍 現在地」で記録すると、ここに時間の順で並びます。</Empty>;
  return (
    <div className="places">
      {days.map(([date, list]) => {
        const dl = dayLabel(date, trip.startDate, trip.endDate);
        const route = routeUrl(list);
        return (
          <section key={date} className="card">
            <div className="card-head">
              <h2>
                {shortDate(date)} {weekdayJa(date).slice(0, 1)}　<span className="muted small">{dl.kind === 'during' ? `DAY ${String(dl.day).padStart(2, '0')}` : dl.label}</span>
              </h2>
              {route && (
                <a className="btn small" href={route} target="_blank" rel="noopener noreferrer">
                  🗺 地図でたどる
                </a>
              )}
            </div>
            <ol className="place-list">
              {list.map((e) => (
                <li key={e.key}>
                  <span className="place-time">{e.at ? timeIn(trip.timeZone, e.at) : '--:--'}</span>
                  <button className="row-btn place-main" onClick={() => navigate(e.go)}>
                    <span>
                      {KIND_ICON[e.kind]} {e.label}
                    </span>
                    <span className="muted small">{e.location}</span>
                  </button>
                  <a className="link small" href={`https://www.google.com/maps/search/?api=1&query=${e.lat},${e.lng}`} target="_blank" rel="noopener noreferrer">
                    地図
                  </a>
                </li>
              ))}
            </ol>
            {list.length > 10 && <p className="muted small">地図でたどるのは最初の 10 地点までです。</p>}
          </section>
        );
      })}
    </div>
  );
}

function Days({ data }: { data: TripData }) {
  const { trip } = useApp();
  const days = summarizeDays(trip, data);
  return (
    <ul className="day-list">
      {days.map((s) => {
        const dl = dayLabel(s.date, trip.startDate, trip.endDate);
        const empty = !s.clips && !s.notes && !s.photos && !s.tasksDone && !s.foodsEaten && !s.expenses;
        return (
          <li key={s.date}>
            <button className={'row-btn day-row' + (empty ? ' empty' : '')} onClick={() => navigate(`day/${s.date}`)}>
              <span>
                <strong>{shortDate(s.date)}</strong> {weekdayJa(s.date).slice(0, 1)}　<span className="muted small">{dl.kind === 'during' ? `DAY ${String(dl.day).padStart(2, '0')}` : dl.label}</span>
              </span>
              <span className="small">
                {empty
                  ? '記録なし'
                  : [s.answered && `🎙${s.answered}問`, s.notes && `📝${s.notes}`, s.photos && `📷${s.photos}`, s.tasksDone && `☑${s.tasksDone}`, s.foodsEaten && `🍜${s.foodsEaten}`, s.expenses && `💰${s.expenses}`]
                      .filter(Boolean)
                      .join(' ')}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Search({ data }: { data: TripData }) {
  const [kw, setKw] = useState('');
  const [tag, setTag] = useState('');
  const tags = useMemo(() => allTags(data), [data]);
  const hits = kw || tag ? search(data, kw, tag) : [];
  return (
    <div>
      <input value={kw} onChange={(e) => setKw(e.target.value)} placeholder="キーワード（質問文・補足・メモ・店名など）" aria-label="キーワード" />
      {tags.length > 0 && (
        <div className="chips">
          {tags.map((t) => (
            <button key={t} className={'chip' + (tag === t ? ' on' : '')} onClick={() => setTag(tag === t ? '' : t)}>
              #{t}
            </button>
          ))}
        </div>
      )}
      <p className="muted small">音声の中身は検索できません（質問文・補足メモ・タグが対象）。</p>
      {(kw || tag) && hits.length === 0 && <Empty>見つかりませんでした。</Empty>}
      <ul className="list">
        {hits.map((h, i) => (
          <li key={i}>
            <button className="row-btn" onClick={() => navigate(h.go)}>
              <span className="muted small">{h.kind} {h.date ?? ''}</span>
              <span className="clamp">{h.text}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Stats({ data }: { data: TripData }) {
  const { trip } = useApp();
  const totals = totalsByCurrency(data.expenses);
  const byCat = new Map<string, Map<string, number>>();
  for (const e of data.expenses) {
    const m = byCat.get(e.currency) ?? new Map<string, number>();
    m.set(e.category, (m.get(e.category) ?? 0) + (e.kind === 'refund' ? -e.amount : e.amount));
    byCat.set(e.currency, m);
  }
  const logs = [...data.logs].sort((a, b) => a.localDate.localeCompare(b.localDate));
  const tasks = data.items.filter((i) => i.type === 'task');
  const foods = data.items.filter((i) => i.type === 'food');
  return (
    <div>
      <section className="card">
        <h2>支出（通貨別。異なる通貨は合算しません）</h2>
        {totals.length === 0 && <p className="muted">まだ支出がありません。</p>}
        {totals.map((t) => (
          <div key={t.currency}>
            <p>
              <strong>{formatMoney(t.total, t.currency)}</strong>（{t.count}件）　自分の負担 {formatMoney(t.personal, t.currency)}
              {t.currency === 'IDR' && convertIdr(trip, t.total) != null && (
                <span className="muted small">　参考 約{Math.round(convertIdr(trip, t.total)!).toLocaleString()}円（手動レート・{trip.rateDate ?? '日付なし'}）</span>
              )}
            </p>
            <ul className="small">
              {[...(byCat.get(t.currency) ?? new Map()).entries()].map(([c, v]) => (
                <li key={c}>
                  {c}：{formatMoney(v, t.currency)}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
      <section className="card">
        <h2>リスト</h2>
        <p>やること：完了 {tasks.filter((i) => i.status === 'done').length}/{tasks.length}（見送り {tasks.filter((i) => i.status === 'skipped').length}）</p>
        <p>食べたいもの：食べた {foods.filter((i) => i.status === 'done').length}/{foods.length}、実食 {data.exps.length}回</p>
      </section>
      <section className="card">
        <h2>定点観測</h2>
        <p className="muted small">主観のスコアです。未入力の日は空白（0 ではありません）。</p>
        {RATING_LABELS.map(([k, label]) => (
          <div key={k} className="spark">
            <span className="small">{label}</span>
            <svg viewBox={`0 0 ${Math.max(1, logs.length) * 10} 40`} preserveAspectRatio="none" role="img" aria-label={label}>
              {logs.map((l, i) => {
                const v = l.ratings?.[k];
                return v == null ? null : <rect key={l.id} x={i * 10 + 1} y={40 - v * 4} width={8} height={v * 4} rx={1} />;
              })}
            </svg>
          </div>
        ))}
        {logs.some((l) => l.conversationMinutes != null) && (
          <p className="small">会話時間の合計：{logs.reduce((s, l) => s + (l.conversationMinutes ?? 0), 0)}分（記録した日 {logs.filter((l) => l.conversationMinutes != null).length}日）</p>
        )}
      </section>
    </div>
  );
}
