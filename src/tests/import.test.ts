import { describe, expect, it } from 'vitest';
import { TravelDB } from '../db/db';
import type { Ctx } from '../db/repo';
import { createTrip, getActiveTrip } from '../features/daily/tripRepo';
import { importItems, isDuplicate, listItems, parseImportFile, addItems } from '../features/checklist/checklistRepo';

describe('リストのファイル取り込み', () => {
  it('形の合う行だけを読み、予定日・状態・目安予算を入れる。同じ名前は重複の候補にする', async () => {
    const text = JSON.stringify({
      items: [
        { type: 'task', title: 'Meetup', plannedDate: '2026-12-01', priority: 'high', area: 'オンライン', note: '18:00 WIB' },
        { type: 'task', title: 'ビザ', status: 'done' },
        { type: 'food', title: 'Pagi Sore', area: 'チュンパカプティ', targetPrice: 50000 },
        { type: 'food', title: '' },
        { type: 'task', title: '日付がおかしい', plannedDate: '12/1' },
        { type: 'other', title: 'x' },
      ],
    });
    const { items, errors } = parseImportFile(text);
    expect(items).toHaveLength(3);
    expect(errors).toHaveLength(3);
    const db = new TravelDB('import-test');
    const ctx: Ctx = { db, ownerId: null };
    await createTrip(ctx);
    const trip = (await getActiveTrip(db))!;
    await addItems(ctx, trip.id, 'food', ['Pagi Sore']);
    const existing = await listItems(db, trip.id, 'food');
    expect(isDuplicate(items[2], existing)).toBe(true);
    await importItems(ctx, trip.id, items.filter((i) => !isDuplicate(i, existing)));
    const tasks = await listItems(db, trip.id, 'task');
    expect(tasks.map((t) => [t.title, t.plannedDate, t.priority, t.status])).toEqual([
      ['Meetup', '2026-12-01', 'high', 'open'],
      ['ビザ', null, 'normal', 'done'],
    ]);
    expect(await listItems(db, trip.id, 'food')).toHaveLength(1);
    expect(parseImportFile('{oops').errors[0]).toMatch(/JSON/);
  });
});
