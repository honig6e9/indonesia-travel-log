import { describe, expect, it } from 'vitest';
import type { ChecklistItem } from '../db/types';
import { byPlanned, endFromText, formatPeriod, isOverdue, isPlannedOn, periodOf } from '../features/checklist/period';

const item = (p: Partial<ChecklistItem>): ChecklistItem => ({
  id: 'x', tripId: 't', type: 'task', title: '', category: '', area: '', plannedDate: null, status: 'open',
  completedDate: null, priority: 'normal', note: '', sortOrder: 0, visibility: 'unchecked', createdAt: '', updatedAt: '', ...p,
});

describe('期間と予定を過ぎた判定', () => {
  it('タイトルやメモの書き方から期間を読む', () => {
    expect(endFromText('Jakarta Coffee Week 2026（第11回・12/4〜6）', '2026-12-04')).toBe('2026-12-06');
    expect(endFromText('25/7（12/4〜5または6）', '2026-12-04')).toBe('2026-12-06');
    expect(endFromText('BTS（12/26・27）', '2026-12-26')).toBe('2026-12-27');
    expect(endFromText('12/25〜1/5。入場Rp1.5万〜', '2026-12-25')).toBe('2027-01-05');
    expect(endFromText('Boyz II Men 12/9・Malcolm Todd 12/12', '2026-12-09')).toBeNull();
    expect(endFromText('翌11/29 2:00着', '2026-11-28')).toBeNull();
  });

  it('期間に入る日、過ぎた判定、表示', () => {
    const coffee = item({ title: 'Coffee Week（12/4〜6）', plannedDate: '2026-12-04' });
    expect(isPlannedOn(coffee, '2026-12-05')).toBe(true);
    expect(isPlannedOn(coffee, '2026-12-07')).toBe(false);
    expect(isOverdue(coffee, '2026-12-06')).toBe(false);
    expect(isOverdue(coffee, '2026-12-07')).toBe(true);
    expect(isOverdue({ ...coffee, status: 'done' }, '2026-12-07')).toBe(false);
    expect(formatPeriod(periodOf(coffee)!)).toBe('12/4〜6');
    expect(formatPeriod(periodOf(item({ title: 'Big Bang', note: '12/25〜1/5', plannedDate: '2026-12-25' }))!)).toBe('12/25〜1/5');
    // 終了日が入っていれば、そちらを使う
    expect(periodOf(item({ title: '（12/4〜6）', plannedDate: '2026-12-04', plannedEndDate: '2026-12-10' }))!.end).toBe('2026-12-10');
  });
});


describe('時系列の並び', () => {
  const it0 = (title: string, plannedDate: string | null, sortOrder: number, plannedEndDate: string | null = null) =>
    ({ id: title, title, note: '', plannedDate, plannedEndDate, sortOrder, status: 'open' }) as unknown as ChecklistItem;
  it('予定日の順に並べ、同じ日は短い期間・登録順、予定日のないものは最後に登録順', () => {
    const items = [it0('予定なしB', null, 1), it0('12/5', '2026-12-05', 2), it0('12/1〜3', '2026-12-01', 5, '2026-12-03'), it0('予定なしA', null, 0), it0('12/1', '2026-12-01', 9)];
    expect([...items].sort(byPlanned).map((i) => i.title)).toEqual(['12/1', '12/1〜3', '12/5', '予定なしA', '予定なしB']);
  });
});
