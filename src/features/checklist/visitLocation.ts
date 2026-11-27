// 「食べた」「行った」にチェックしたとき、その場所を記録する。
// 位置情報がすでに許可されているときだけ取る（チェックのたびに許可を聞かない）。常時の追跡はしない。

import { transact, type Ctx } from '../../db/repo';
import type { ChecklistItem } from '../../db/types';
import { firstExperienceId } from '../../lib/ids';
import { formatPosition, getCurrentPosition } from '../../lib/geo';

export async function locationAllowed(): Promise<boolean> {
  try {
    const s = await navigator.permissions?.query({ name: 'geolocation' as PermissionName });
    return s?.state === 'granted';
  } catch {
    return false;
  }
}

/** 場所を記録する種類（店・場所に行くもの） */
export const RECORDS_VISIT = (item: ChecklistItem) => item.type === 'food' || item.type === 'place';

/**
 * 「済み」にした項目に現在地を入れる（まだ場所がないときだけ）。食べたものは初回の実食にも入れる。
 * 取れなかったときは何もしない。戻り値は入れた場所。
 */
export async function recordVisitLocation(ctx: Ctx, item: ChecklistItem, get: () => Promise<string | null> = defaultGet): Promise<string | null> {
  if (!RECORDS_VISIT(item)) return null;
  const loc = await get();
  if (!loc) return null;
  let wrote = false;
  await transact(ctx, async (w) => {
    const cur = await w.get('checklistItem', item.id);
    if (!cur || cur.deletedAt || cur.status !== 'done') return;
    if (!cur.location) {
      await w.put('checklistItem', { ...cur, location: loc, locatedAt: new Date().toISOString() });
      wrote = true;
    }
    if (cur.type === 'food') {
      const e = await w.get('foodExperience', firstExperienceId(cur.id));
      if (e && !e.deletedAt && !e.location) {
        await w.put('foodExperience', { ...e, location: loc });
        wrote = true;
      }
    }
  });
  return wrote ? loc : null;
}

async function defaultGet(): Promise<string | null> {
  if (!(await locationAllowed())) return null;
  try {
    return formatPosition(await getCurrentPosition(15000));
  } catch {
    return null;
  }
}
