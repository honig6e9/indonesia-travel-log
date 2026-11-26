// WhatsApp の候補の登録：選んだものだけ・二重登録しない・追記・抜粋は許可したときだけ
import { beforeEach, describe, expect, it } from 'vitest';
import { TravelDB } from '../db/db';
import { alive, type Ctx } from '../db/repo';
import { createTrip } from '../features/daily/tripRepo';
import { addItems, listItems } from '../features/checklist/checklistRepo';
import { convertedTo } from '../features/inbox/inboxRepo';
import { rangeToIso, tzOffset, type WaCandidate } from '../features/inbox/whatsappApi';
import { DEFAULT_DEST, inboxIdForCandidate, registerCandidate, similarItems } from '../features/inbox/whatsappRegister';

let ctx: Ctx;
let tripId: string;
let n = 0;

beforeEach(async () => {
  const db = new TravelDB(`wa-${n++}`);
  ctx = { db, ownerId: null };
  tripId = (await createTrip(ctx)).id;
});

const cand = (over: Partial<WaCandidate> = {}): WaCandidate => ({
  id: 'c1',
  category: 'food',
  title_ja: 'ソト・ブタウィを食べる',
  name_id: 'Soto Betawi',
  description: 'Sabang で食べる約束',
  place: 'Sabang',
  shop: null,
  price_idr: 35000,
  datetime_text: 'besok jam 7',
  date: '2026-12-02',
  url: null,
  translation_ja: '明日サバンでソト・ブタウィを食べよう',
  certainty: 'agreed',
  status: 'pending',
  action: 'new',
  source_message_ids: ['m1'],
  chat_id: '111@lid',
  chat_title: '+62 811-1111-2222',
  partner: 'WhatsApp の相手',
  message_at: '2026-12-01T10:00:00+07:00',
  key: 'food:sotobetawi',
  ...over,
});

describe('WhatsApp の候補の登録', () => {
  it('食べたいものに登録し、二度押しても 1 件。会話の抜粋は許可しなければ入らない', async () => {
    const c = cand();
    const d = DEFAULT_DEST[c.category];
    expect(await registerCandidate(ctx, tripId, c, { dest: d.dest, title: c.title_ja, category: d.category, localDate: '2026-12-01' })).toBe('created');
    expect(await registerCandidate(ctx, tripId, c, { dest: d.dest, title: c.title_ja, category: d.category, localDate: '2026-12-01' })).toBe('already');
    const foods = await listItems(ctx.db, tripId, 'food');
    expect(foods.map((f) => f.title)).toEqual(['ソト・ブタウィを食べる']);
    expect(foods[0].plannedDate).toBe('2026-12-02');
    expect(foods[0].note).toContain('35,000 IDR');
    expect(foods[0].note).not.toContain('+62');
    const inbox = await ctx.db.inboxItems.get(inboxIdForCandidate('c1'));
    expect(inbox?.sourceType).toBe('whatsapp');
    expect(inbox?.status).toBe('processed');
    expect(inbox?.sourceText).not.toContain('besok jam 7 ya'); // 抜粋（会話の原文）は入れていない
    expect((await convertedTo(ctx.db, inbox!.id)).length).toBe(1);
  });

  it('許可したときだけ、根拠の会話の抜粋を原文として残す', async () => {
    await registerCandidate(ctx, tripId, cand(), {
      dest: 'food',
      title: 'ソト',
      category: '料理',
      excerpt: [{ id: 'm1', at: '12/01 10:00', from: 'Budi', text: 'Besok makan Soto Betawi yuk', source: true }],
      localDate: '2026-12-01',
    });
    const inbox = await ctx.db.inboxItems.get(inboxIdForCandidate('c1'));
    expect(inbox?.sourceText).toBe('[12/01 10:00] 相手: Besok makan Soto Betawi yuk'); // 相手の名前も出さない
  });

  it('既存の項目に追記できる（新しい項目は作らない）。似た項目を見つける', async () => {
    await addItems(ctx, tripId, 'food', ['Soto Betawi（ソトブタウィ）']);
    const [item] = await listItems(ctx.db, tripId, 'food');
    const c = cand({ id: 'c2', action: 'append' });
    expect(similarItems(c, [item]).map((i) => i.id)).toEqual([item.id]);
    await registerCandidate(ctx, tripId, c, { dest: 'append', title: '時間が決まった', category: '', appendTo: item.id, localDate: '2026-12-01' });
    const after = await listItems(ctx.db, tripId, 'food');
    expect(after).toHaveLength(1);
    expect(after[0].note).toContain('WhatsApp からの追記');
    expect(after[0].note).toContain('時間が決まった');
  });

  it('専用のリストがないカテゴリは、やることか未整理ボックスに入る', async () => {
    expect(DEFAULT_DEST.language.dest).toBe('inbox');
    expect(DEFAULT_DEST.change.dest).toBe('inbox');
    expect(DEFAULT_DEST.meetup.dest).toBe('task');
    await registerCandidate(ctx, tripId, cand({ id: 'c3', category: 'language', title_ja: 'Jangan pedas', name_id: null }), { dest: 'inbox', title: 'Jangan pedas', category: '', localDate: '2026-12-01' });
    const inbox = alive(await ctx.db.inboxItems.toArray());
    expect(inbox.map((i) => [i.title, i.status])).toEqual([['Jangan pedas', 'pending']]);
  });
});

describe('期間の指定', () => {
  it('旅行のタイムゾーンの日付の境目で範囲を作る（終わりは含まない）', () => {
    expect(tzOffset('Asia/Jakarta')).toBe('+07:00');
    expect(rangeToIso('7d', '2026-12-10', '+07:00')).toEqual({ from: '2026-12-04T00:00:00+07:00', to: '2026-12-11T00:00:00+07:00' });
    expect(rangeToIso('yesterday', '2026-12-10', '+07:00')).toEqual({ from: '2026-12-09T00:00:00+07:00', to: '2026-12-10T00:00:00+07:00' });
    expect(rangeToIso('custom', '2026-12-10', '+07:00', { from: '2026-12-01', to: '2026-12-03' })).toEqual({ from: '2026-12-01T00:00:00+07:00', to: '2026-12-04T00:00:00+07:00' });
    expect(rangeToIso('all', '2026-12-10', '+07:00')).toEqual({});
  });
});
