// 「食べた」「行った」のチェックで場所を記録する
import { beforeEach, describe, expect, it } from 'vitest';
import { TravelDB } from '../db/db';
import type { Ctx } from '../db/repo';
import { createTrip } from '../features/daily/tripRepo';
import { addItems, listItems, setItemStatus } from '../features/checklist/checklistRepo';
import { recordVisitLocation } from '../features/checklist/visitLocation';
import { firstExperienceId } from '../lib/ids';
import { mapUrl } from '../lib/geo';

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
