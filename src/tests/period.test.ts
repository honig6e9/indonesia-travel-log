import { describe, expect, it } from 'vitest';
import type { ChecklistItem } from '../db/types';
import { endFromText, formatPeriod, isOverdue, isPlannedOn, periodOf } from '../features/checklist/period';

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
