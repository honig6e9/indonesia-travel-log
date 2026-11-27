// 「食べた」「行った」のチェックで場所を記録する
import { beforeEach, describe, expect, it } from 'vitest';
import { TravelDB } from '../db/db';
import type { Ctx } from '../db/repo';
import { createTrip } from '../features/daily/tripRepo';
import { addItems, listItems, setItemStatus } from '../features/checklist/checklistRepo';
import { recordVisitLocation } from '../features/checklist/visitLocation';
import { firstExperienceId } from '../lib/ids';
import { mapUrl } from '../lib/geo';
import { locationHistory, routeUrl, type TripData } from '../features/history/historyData';

let ctx: Ctx;
let tripId: string;
let n = 0;
const here = async () => '-6.175392,106.827153（±12m）';

beforeEach(async () => {
  const db = new TravelDB(`loc-${n++}`);
  ctx = { db, ownerId: null };
  tripId = (await createTrip(ctx)).id;
});

describe('行った・食べた場所の記録', () => {
  it('食べたものは、項目と初回の実食に場所が入る', async () => {
    await addItems(ctx, tripId, 'food', ['Soto Betawi']);
    const [item] = await listItems(ctx.db, tripId, 'food');
    await setItemStatus(ctx, item, 'done', '2026-12-01');
    expect(await recordVisitLocation(ctx, item, here)).toBe('-6.175392,106.827153（±12m）');
    expect((await ctx.db.checklistItems.get(item.id))?.location).toBe('-6.175392,106.827153（±12m）');
    expect((await ctx.db.foodExperiences.get(firstExperienceId(item.id)))?.location).toBe('-6.175392,106.827153（±12m）');
    expect(mapUrl('-6.175392,106.827153（±12m）')).toContain('-6.175392,106.827153');
  });

  it('行きたい場所は記録し、やることは記録しない。すでにある場所は上書きしない', async () => {
    await addItems(ctx, tripId, 'place', ['Monas']);
    await addItems(ctx, tripId, 'task', ['KRLに乗る']);
    const [place] = await listItems(ctx.db, tripId, 'place');
    const [task] = await listItems(ctx.db, tripId, 'task');
    await setItemStatus(ctx, place, 'done', '2026-12-01');
    await setItemStatus(ctx, task, 'done', '2026-12-01');
    expect(await recordVisitLocation(ctx, place, here)).not.toBeNull();
    expect(await recordVisitLocation(ctx, task, here)).toBeNull();
    expect((await ctx.db.checklistItems.get(task.id))?.location).toBeUndefined();
    expect(await recordVisitLocation(ctx, place, async () => '1.000000,2.000000（±5m）')).toBeNull();
    expect((await ctx.db.checklistItems.get(place.id))?.location).toBe('-6.175392,106.827153（±12m）');
  });

  it('チェックを外したあとや、場所が取れなかったときは何もしない', async () => {
    await addItems(ctx, tripId, 'place', ['Kota Tua']);
    const [item] = await listItems(ctx.db, tripId, 'place');
    await setItemStatus(ctx, item, 'done', '2026-12-01');
    expect(await recordVisitLocation(ctx, item, async () => null)).toBeNull();
    await setItemStatus(ctx, item, 'open', '2026-12-01');
    expect(await recordVisitLocation(ctx, item, here)).toBeNull();
    expect((await ctx.db.checklistItems.get(item.id))?.location).toBeUndefined();
  });
});


describe('位置の履歴', () => {
  const base = { tripId: 't', updatedAt: '', deletedAt: null };
  const data = {
    logs: [],
    answers: [],
    clips: [],
    media: [],
    notes: [
      { ...base, id: 'n1', localDate: '2026-12-01', createdAt: '2026-12-01T05:00:00Z', body: '📍 現在地（12:00）\nモナス', category: '', tags: [], evidenceType: '', visibility: 'unchecked', location: '-6.175392,106.827153（±12m）' },
      { ...base, id: 'n2', localDate: '2026-12-01', createdAt: '2026-12-01T02:00:00Z', body: '朝ごはん', category: '', tags: [], evidenceType: '', visibility: 'unchecked', location: '-6.200000,106.800000（±8m）' },
      { ...base, id: 'n3', localDate: '2026-12-01', createdAt: '2026-12-01T03:00:00Z', body: '場所なし', category: '', tags: [], evidenceType: '', visibility: 'unchecked', location: null },
    ],
    expenses: [{ ...base, id: 'x1', localDate: '2026-12-02', createdAt: '2026-12-02T06:00:00Z', amount: 35000, currency: 'IDR', category: '食事', shop: 'Warung A', paymentMethod: '', note: '', kind: 'expense', location: '-6.100000,106.900000（±5m）' }],
    items: [
      { ...base, id: 'i1', type: 'food', title: 'Soto', status: 'done', completedDate: '2026-12-02', location: '-6.1,106.9', locatedAt: '2026-12-02T05:00:00Z', createdAt: '', sortOrder: 0 },
      { ...base, id: 'i2', type: 'place', title: 'Kota Tua', status: 'done', completedDate: '2026-12-02', location: '-6.135,106.813（±9m）', locatedAt: '2026-12-02T08:00:00Z', createdAt: '', sortOrder: 1 },
    ],
    exps: [{ ...base, id: 'e1', checklistItemId: 'i1', localDate: '2026-12-02', createdAt: '2026-12-02T05:00:00Z', shop: '', currency: 'IDR', comment: '', visibility: 'unchecked', location: '-6.1,106.9' }],
  } as unknown as TripData;
  const localDateOf = (iso: string) => iso.slice(0, 10);

  it('場所のある記録だけを、新しい日から・日の中は時刻の順に並べ、実食と同じ場所の項目は 1 つにする', () => {
    const h = locationHistory(data, localDateOf);
    expect(h.map((e) => e.key)).toEqual(['f:e1', 'x:x1', 'i:i2', 'n:n2', 'n:n1']);
    expect(h[0].label).toBe('Soto');
    expect(h.find((e) => e.key === 'n:n1')?.label).toBe('モナス');
  });

  it('その日の地点を時刻の順にたどる地図の経路を作る', () => {
    const day = locationHistory(data, localDateOf).filter((e) => e.localDate === '2026-12-01');
    expect(routeUrl(day)).toBe('https://www.google.com/maps/dir/-6.2,106.8/-6.175392,106.827153');
    expect(routeUrl(day.slice(0, 1))).toBe('https://www.google.com/maps/search/?api=1&query=-6.2,106.8');
    expect(routeUrl([])).toBeNull();
  });
});
