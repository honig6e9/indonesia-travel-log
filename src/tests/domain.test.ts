import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { TravelDB } from '../db/db';
import { alive, type Ctx } from '../db/repo';
import { addDays, dayLabel, todayIn } from '../lib/dates';
import { createTrip, getActiveTrip, listTemplates, saveTemplate } from '../features/daily/tripRepo';
import { loadDiary, saveClip, setAnswerNote, setSkipped, updateAnswer } from '../features/diary/diaryRepo';
import { addItems, blankExperience, listExperiences, listItems, parseBulk, saveExperience, setItemStatus } from '../features/checklist/checklistRepo';
import { blankNote, saveNote } from '../features/notes/notesRepo';
import { blankExpense, saveExpense, totalsByCurrency } from '../features/expenses/expenseRepo';
import { buildArticleExport, csvCell } from '../features/export/articleExport';
import { merge3 } from '../features/sync/merge';

let n = 0;
async function setup() {
  const db = new TravelDB(`domain-${n++}`);
  const ctx: Ctx = { db, ownerId: null };
  await createTrip(ctx);
  const trip = (await getActiveTrip(db))!;
  return { db, ctx, trip };
}

describe('日付', () => {
  it('A08：11/29 が DAY 01、12/28 が DAY 30、期間外は出発前・帰国後', () => {
    expect(dayLabel('2026-11-29', '2026-11-29', '2026-12-28').label).toBe('DAY 01/30');
    expect(dayLabel('2026-12-28', '2026-11-29', '2026-12-28').label).toBe('DAY 30/30');
    expect(dayLabel('2026-11-28', '2026-11-29', '2026-12-28').label).toBe('出発前（1日前）');
    expect(dayLabel('2026-12-29', '2026-11-29', '2026-12-28').label).toBe('帰国後（1日後）');
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
  });

  it('A11：「今日」は旅行のタイムゾーンで決まり、端末のタイムゾーンに依存しない', () => {
    // UTC 2026-11-28 18:30 は ジャカルタ（UTC+7）では 11/29 01:30
    const t = new Date('2026-11-28T18:30:00Z');
    expect(todayIn('Asia/Jakarta', t)).toBe('2026-11-29');
    expect(todayIn('Asia/Tokyo', t)).toBe('2026-11-29');
    expect(todayIn('America/Los_Angeles', t)).toBe('2026-11-28');
    // 記録対象日は文字列で保存され、DAY 計算も文字列だけで行う
    expect(dayLabel('2026-11-29', '2026-11-29', '2026-12-28').day).toBe(1);
  });
});

describe('音声日記', () => {
  it('A12：テンプレートを変更しても、記録を始めた日の質問文と回答は変わらない', async () => {
    const { db, ctx, trip } = await setup();
    await setAnswerNote(ctx, trip.id, '2026-11-29', 'q01', 'モナスへ行った');
    const tpl = (await listTemplates(db, trip.id))[0];
    await saveTemplate(ctx, { ...tpl, title: '書き換えた質問' });
    const day1 = await loadDiary(db, trip.id, '2026-11-29');
    expect(day1.questions[0].title).toBe('今日はどこで何をした？');
    expect(day1.answers.get('q01')!.note).toBe('モナスへ行った');
    const day2 = await loadDiary(db, trip.id, '2026-11-30');
    expect(day2.questions[0].title).toBe('書き換えた質問');
  });

  it('回答数とスキップ数を分けて数え、追記クリップを重ねられる', async () => {
    const { db, ctx, trip } = await setup();
    await setSkipped(ctx, trip.id, '2026-11-29', 'q02', true);
    await saveClip(ctx, { tripId: trip.id, localDate: '2026-11-29', questionId: 'q03', blob: new Blob(['1']), mimeType: 'audio/webm', ext: 'webm', durationMs: 1 });
    await saveClip(ctx, { tripId: trip.id, localDate: '2026-11-29', questionId: 'q03', blob: new Blob(['2']), mimeType: 'audio/webm', ext: 'webm', durationMs: 1 });
    const d = await loadDiary(db, trip.id, '2026-11-29');
    expect(d.answeredIds.size).toBe(1);
    expect(d.skippedIds.size).toBe(1);
    expect(d.clipsByQuestion.get('q03')).toHaveLength(2);
  });

  it('作成日時・更新日時が必ず入る', async () => {
    const { db, ctx, trip } = await setup();
    await saveNote(ctx, { ...blankNote(trip.id, '2026-11-29'), body: 'x' });
    const note = alive(await db.notes.toArray())[0];
    expect(Date.parse(note.createdAt)).not.toBeNaN();
    expect(Date.parse(note.updatedAt)).not.toBeNaN();
  });
});

describe('リスト', () => {
  it('A07：同じ料理を複数回記録でき、チェック解除で実食履歴が消えない', async () => {
    const { db, ctx, trip } = await setup();
    await addItems(ctx, trip.id, 'food', ['Bakso（バクソ）']);
    const item = (await listItems(db, trip.id, 'food'))[0];
    await setItemStatus(ctx, item, 'done', '2026-11-29');
    await saveExperience(ctx, item, { ...blankExperience(item, '2026-12-02'), shop: '別の店', price: 20000 }, false, null);
    expect(await listExperiences(db, item.id)).toHaveLength(2);
    await setItemStatus(ctx, (await db.checklistItems.get(item.id))!, 'open', '2026-12-03');
    expect((await db.checklistItems.get(item.id))!.status).toBe('open');
    expect(await listExperiences(db, item.id)).toHaveLength(2);
  });

  it('A05：完了日は選択日。一括登録は空行除去・重複候補を出す', async () => {
    const { db, ctx, trip } = await setup();
    await addItems(ctx, trip.id, 'task', ['KRLに乗る']);
    const parsed = parseBulk('KRLに乗る\n\nMRTに乗る\nMRTに乗る\n', await listItems(db, trip.id, 'task'));
    expect(parsed.map((p) => [p.line, p.duplicate])).toEqual([
      ['KRLに乗る', true],
      ['MRTに乗る', false],
      ['MRTに乗る', true],
    ]);
    const item = (await listItems(db, trip.id, 'task'))[0];
    await setItemStatus(ctx, item, 'done', '2026-12-05');
    expect((await db.checklistItems.get(item.id))!.completedDate).toBe('2026-12-05');
  });
});

describe('支出', () => {
  it('A13：通貨別に集計し、異なる通貨を合算しない。返金は差し引く', async () => {
    const { db, ctx, trip } = await setup();
    await saveExpense(ctx, { ...blankExpense(trip.id, '2026-11-29'), amount: 50000, currency: 'IDR' });
    await saveExpense(ctx, { ...blankExpense(trip.id, '2026-11-29'), amount: 10000, currency: 'IDR', kind: 'refund' });
    await saveExpense(ctx, { ...blankExpense(trip.id, '2026-11-29'), amount: 1200, currency: 'JPY' });
    await expect(saveExpense(ctx, { ...blankExpense(trip.id, '2026-11-29'), amount: 1.5 })).rejects.toThrow();
    const t = totalsByCurrency(alive(await db.expenses.toArray()));
    expect(t).toEqual([
      { currency: 'IDR', total: 40000, personal: 40000, count: 2 },
      { currency: 'JPY', total: 1200, personal: 1200, count: 1 },
    ]);
  });
});

describe('記事素材の出力', () => {
  it('CSV 式インジェクション対策', () => {
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('普通の文')).toBe('普通の文');
  });

  it('A14/A15：日別 Markdown と音声ファイルが対応し、公開候補の出力に未確認・非公開が混ざらない', async () => {
    const { db, ctx, trip } = await setup();
    await saveClip(ctx, { tripId: trip.id, localDate: '2026-11-29', questionId: 'q01', blob: new Blob(['a']), mimeType: 'audio/webm', ext: 'webm', durationMs: 1 });
    await saveClip(ctx, { tripId: trip.id, localDate: '2026-11-29', questionId: 'q02', blob: new Blob(['b']), mimeType: 'audio/webm', ext: 'webm', durationMs: 1 });
    await saveNote(ctx, { ...blankNote(trip.id, '2026-11-29'), body: '公開してよいメモ', visibility: 'candidate' });
    await saveNote(ctx, { ...blankNote(trip.id, '2026-11-29'), body: '秘密のメモ', visibility: 'private' });
    await saveNote(ctx, { ...blankNote(trip.id, '2026-11-29'), body: '未確認のメモ' });
    const d = await loadDiary(db, trip.id, '2026-11-29');
    await updateAnswer(ctx, d.answers.get('q01')!, { visibility: 'candidate' });
    await saveExpense(ctx, { ...blankExpense(trip.id, '2026-11-29'), amount: 30000 });

    const all = await JSZip.loadAsync(await (await buildArticleExport(db, trip, { from: '2026-11-29', to: '2026-11-29', mode: 'all' })).blob);
    const md = await all.file('article-materials/days/2026-11-29.md')!.async('string');
    expect(md).toContain('../audio/2026-11-29_q01_01.webm');
    expect(md).toContain('../audio/2026-11-29_q02_01.webm');
    expect(all.file('article-materials/audio/2026-11-29_q01_01.webm')).toBeTruthy();
    expect(md).toContain('IDR合計');
    const csv = await all.file('article-materials/csv/expenses.csv')!.async('string');
    expect(csv.charCodeAt(0)).toBe(0xfeff);

    const pub = await JSZip.loadAsync(await (await buildArticleExport(db, trip, { from: '2026-11-29', to: '2026-11-29', mode: 'candidate' })).blob);
    const pmd = await pub.file('article-materials/days/2026-11-29.md')!.async('string');
    expect(pmd).toContain('公開してよいメモ');
    expect(pmd).not.toContain('秘密のメモ');
    expect(pmd).not.toContain('未確認のメモ');
    expect(pmd).toContain('2026-11-29_q01_01.webm');
    expect(pmd).not.toContain('q02');
    expect(pub.file('article-materials/audio/2026-11-29_q02_01.webm')).toBeNull();
    expect(pub.file('article-materials/csv/expenses.csv')).toBeNull();
    expect(pmd).not.toContain('IDR合計');
  });
});

describe('マージ', () => {
  it('同じ値への変更は競合にしない', () => {
    const base = { id: '1', note: 'a', status: 'open' };
    const r = merge3('checklistItem', base, { ...base, status: 'done' }, { ...base, status: 'done' });
    expect(r.conflicts).toEqual([]);
  });
  it('日別の質問スナップショットはベースなしでも和集合にする', () => {
    const q = (id: string, title = id) => ({ questionId: id, title, hints: [] });
    const r = merge3('dailyLog', null, { id: '1', questionSnapshots: [q('q01'), q('c1')] }, { id: '1', questionSnapshots: [q('q01'), q('c2')] });
    expect(r.conflicts).toEqual([]);
    expect((r.merged.questionSnapshots as { questionId: string }[]).map((x) => x.questionId).sort()).toEqual(['c1', 'c2', 'q01']);
    const r2 = merge3('dailyLog', null, { id: '1', questionSnapshots: [q('q01', 'A')] }, { id: '1', questionSnapshots: [q('q01', 'B')] });
    expect(r2.conflicts).toEqual(['questionSnapshots']);
  });
});
