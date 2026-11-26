import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import type { Ratings } from '../../db/types';
import { getDailyLog, saveRatings } from '../diary/diaryRepo';

export const RATING_LABELS: [keyof Ratings, string][] = [
  ['adaptation', '生活への慣れ'],
  ['language', '語学の通用感'],
  ['satisfaction', '満足度'],
  ['fatigue', '疲労'],
  ['homesick', '日本に帰りたい気持ち'],
];

/** 定点観測（任意）。未入力は欠損のまま（0 にしない） */
export function RatingsCard() {
  const { db, ctx, trip, date } = useApp();
  const [open, setOpen] = useState(false);
  const log = useLiveQuery(async () => (await getDailyLog(db, trip.id, date)) ?? null, [db, trip.id, date]);
  const ratings = log?.ratings ?? {};
  const filled = RATING_LABELS.filter(([k]) => ratings[k] != null).length;
  return (
    <section className="card">
      <button className="card-head as-button" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <h2>定点観測（任意）</h2>
        <span className="muted">{filled}/5 {open ? '▲' : '▼'}</span>
      </button>
      {open && (
        <div>
          <p className="muted small">主観のスコアです（1〜10）。客観的な測定ではありません。未入力は空欄のまま残ります。</p>
          {RATING_LABELS.map(([k, label]) => (
            <div key={k} className="rating-row">
              <span>{label}</span>
              <select
                value={ratings[k] ?? ''}
                onChange={(e) =>
                  void saveRatings(ctx, trip.id, date, { ratings: { ...ratings, [k]: e.target.value ? Number(e.target.value) : null } })
                }
              >
                <option value="">—</option>
                {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          ))}
          <div className="rating-row">
            <span>現地の人との会話（分）</span>
            <input
              inputMode="numeric"
              defaultValue={log?.conversationMinutes ?? ''}
              key={date}
              onBlur={(e) => {
                const v = e.target.value.trim();
                const n = v === '' ? null : Math.max(0, Math.round(Number(v)));
                if (v !== '' && !Number.isFinite(n)) return;
                if (n !== (log?.conversationMinutes ?? null)) void saveRatings(ctx, trip.id, date, { conversationMinutes: n });
              }}
            />
          </div>
        </div>
      )}
    </section>
  );
}
