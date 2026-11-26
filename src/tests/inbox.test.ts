// 外部情報の取り込み（未整理ボックス）：URL の正規化・仮タイトル・分割・重複・変換・同期
import { beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { TravelDB } from '../db/db';
import { alive, type Ctx } from '../db/repo';
import { SyncEngine } from '../features/sync/engine';
import { TransportError } from '../features/sync/transport';
import { addUser, createServer, PgliteTransport } from '../../supabase/tests/pgliteServer';
import { createTrip, getActiveTrip } from '../features/daily/tripRepo';
import { addItems, listItems } from '../features/checklist/checklistRepo';
import {
  buildInboxItem,
  convertedTo,
  convertInbox,
  deleteInboxItems,
  detectSource,
  extractUrl,
  findDuplicates,
  guessTitle,
  inboxSourceOf,
  normalizeUrl,
  pendingInboxCount,
  saveInboxItem,
  splitEntries,
} from '../features/inbox/inboxRepo';

describe('取り込み：文字の処理', () => {
  it('URL を正規化する（追跡用の引数・www・末尾の / ・twitter.com）', () => {
    expect(normalizeUrl('https://twitter.com/user/status/123?s=20&t=abc')).toBe('x.com/user/status/123');
    expect(normalizeUrl('https://x.com/user/status/123/')).toBe('x.com/user/status/123');
    expect(normalizeUrl('https://www.example.com/a/?utm_source=x&id=5#top')).toBe('example.com/a?id=5');
    expect(normalizeUrl('https://www.instagram.com/p/ABC/?igsh=xyz')).toBe('instagram.com/p/ABC');
    expect(normalizeUrl('')).toBe('');
  });

  it('文の中の URL を取り出し、送り元を見分ける', () => {
    expect(extractUrl('おすすめ https://x.com/a/status/1。')).toBe('https://x.com/a/status/1');
    expect(detectSource('https://x.com/a/status/1', 'manual')).toBe('x');
    expect(detectSource('https://www.instagram.com/p/1', 'manual')).toBe('instagram');
    expect(detectSource('https://maps.app.goo.gl/abc', 'manual')).toBe('maps');
    expect(detectSource('https://www.google.com/maps/place/Monas', 'manual')).toBe('maps');
    expect(detectSource('https://example.com', 'manual')).toBe('web');
    expect(detectSource('', 'clipboard')).toBe('clipboard');
  });

  it('タイトルが空なら原文の最初の行、なければ URL から仮タイトルを作る', () => {
    expect(guessTitle({ text: 'https://x.com/a\nJangan pedas, ya.' })).toBe('Jangan pedas, ya.');
    expect(guessTitle({ url: 'https://example.com/blog/post-1' })).toBe('example.com/blog/post-1');
    expect(guessTitle({ title: '  自分の題  ', text: 'abc' })).toBe('自分の題');
    expect(guessTitle({})).toBe('（無題）');
  });

  it('複数行の貼り付けを分ける（空行があればまとまりごと、なければ 1 行ずつ。行頭の記号は外す）', () => {
    expect(splitEntries('- KRLに乗る\n・Monasに行く\n1. Sate を食べる')).toEqual(['KRLに乗る', 'Monasに行く', 'Sate を食べる']);
    expect(splitEntries('店A\n住所A\n\n店B\n住所B')).toEqual(['店A\n住所A', '店B\n住所B']);
    expect(splitEntries('  ')).toEqual([]);
  });
});

// ---------- DB を使うもの ----------

const A = '00000000-0000-4000-8000-0000000000aa';
let pg: PGlite;
let files: Map<string, Blob>;
let n = 0;

function device(name: string) {
  const db = new TravelDB(`inbox-${name}-${n++}`);
  const t = new PgliteTransport(pg, A, files);
  const engine = new SyncEngine(db, A, crypto.randomUUID(), name, t);
  const ctx: Ctx = { db, ownerId: A };
  return { db, ctx, t, engine, sync: () => engine.sync({ uploadMedia: true }) };
}

beforeEach(async () => {
  pg = await createServer();
  await addUser(pg, A);
  files = new Map();
});

async function setup() {
  const a = device('a');
  const b = device('b');
  await createTrip(a.ctx);
  expect((await a.sync()).errors).toEqual([]);
  expect((await b.sync()).errors).toEqual([]);
  const trip = (await getActiveTrip(a.db))!;
  return { a, b, trip };
}

describe('取り込み：保存・変換・同期', () => {
  it('URL だけでも保存でき、インドネシア語の原文と URL が残る', async () => {
    const { a, trip } = await setup();
    const onlyUrl = await buildInboxItem(trip.id, { sourceType: 'unknown', sourceUrl: 'https://x.com/u/status/9?s=20' });
    await saveInboxItem(a.ctx, onlyUrl);
    const text = await buildInboxItem(trip.id, { sourceType: 'clipboard', sourceText: 'Jangan pedas, ya.' });
    await saveInboxItem(a.ctx, text);
    const got = await a.db.inboxItems.get(onlyUrl.id);
    expect(got?.sourceType).toBe('x');
    expect(got?.title).toBe('x.com/u/status/9');
    expect((await a.db.inboxItems.get(text.id))?.sourceText).toBe('Jangan pedas, ya.');
    expect(await pendingInboxCount(a.db, trip.id)).toBe(2);
  });

  it('同じ URL・同じ原文は重複として見つけるが、保存は止めない', async () => {
    const { a, trip } = await setup();
    const first = await buildInboxItem(trip.id, { sourceType: 'web', sourceText: 'Jangan  pedas, ya.', sourceUrl: 'https://www.example.com/p?utm_source=a' });
    await saveInboxItem(a.ctx, first);
    const second = await buildInboxItem(trip.id, { sourceType: 'web', sourceText: 'Jangan pedas, ya.', sourceUrl: 'https://example.com/p/' });
    const d = await findDuplicates(a.db, trip.id, second);
    expect(d.map((x) => x.item.id)).toEqual([first.id]);
    expect(d[0].reason).toBe('url');
    await saveInboxItem(a.ctx, second);
    expect(await pendingInboxCount(a.db, trip.id)).toBe(2);
  });

  it('同じ共有を 2 回保存しても 1 件（受信 ID から決まる ID）', async () => {
    const { a, trip } = await setup();
    for (let i = 0; i < 2; i++) await saveInboxItem(a.ctx, await buildInboxItem(trip.id, { sourceType: 'unknown', sourceText: 'abc', shareId: 'share-1' }));
    expect(alive(await a.db.inboxItems.toArray())).toHaveLength(1);
  });

  it('やることに変換・複数に分割でき、元の情報は整理済みで残り、変換先と結ばれる', async () => {
    const { a, trip } = await setup();
    await addItems(a.ctx, trip.id, 'task', ['既存のやること']);
    const it0 = await buildInboxItem(trip.id, { sourceType: 'x', sourceText: 'Monas に行く\nKota Tua を歩く', sourceUrl: 'https://x.com/u/status/1' });
    await saveInboxItem(a.ctx, it0);
    const made = await convertInbox(a.ctx, it0, [{ kind: 'task', title: 'Monas に行く' }, { kind: 'place', title: 'Kota Tua' }, { kind: 'idea', title: '旧市街の記事' }], '2026-12-01');
    expect(made).toHaveLength(3);
    const tasks = await listItems(a.db, trip.id, 'task');
    expect(tasks.map((t) => t.title)).toEqual(['既存のやること', 'Monas に行く']);
    expect(tasks[1].note).toContain('https://x.com/u/status/1');
    expect(tasks[1].note).toContain('Kota Tua を歩く');
    expect((await listItems(a.db, trip.id, 'place')).map((t) => t.title)).toEqual(['Kota Tua']);
    const note = alive(await a.db.notes.toArray()).find((x) => x.category === '記事ネタ');
    expect(note?.body.startsWith('旧市街の記事')).toBe(true);
    const after = await a.db.inboxItems.get(it0.id);
    expect(after?.status).toBe('processed');
    expect(after?.sourceText).toBe('Monas に行く\nKota Tua を歩く');
    expect((await convertedTo(a.db, it0.id)).map((c) => c.kind).sort()).toEqual(['idea', 'place', 'task']);
    expect((await inboxSourceOf(a.db, tasks[1].id))?.id).toBe(it0.id);
    // 元の情報を削除しても、変換したやることは残る
    await deleteInboxItems(a.ctx, [it0.id]);
    expect((await listItems(a.db, trip.id, 'task')).map((t) => t.title)).toContain('Monas に行く');
  });

  it('別の端末へ同期され、変換先とのつながりも届く', async () => {
    const { a, b, trip } = await setup();
    const it0 = await buildInboxItem(trip.id, { sourceType: 'clipboard', sourceText: 'Jangan pedas, ya.' });
    await saveInboxItem(a.ctx, it0);
    await convertInbox(a.ctx, it0, [{ kind: 'food', title: '辛くない料理を頼む' }], '2026-12-01');
    expect((await a.sync()).errors).toEqual([]);
    expect((await b.sync()).errors).toEqual([]);
    const got = await b.db.inboxItems.get(it0.id);
    expect(got?.status).toBe('processed');
    expect(got?.sourceText).toBe('Jangan pedas, ya.');
    expect((await convertedTo(b.db, it0.id)).map((c) => c.label)).toEqual(['辛くない料理を頼む']);
    expect(await a.db.outbox.count()).toBe(0);
  });

  it('サーバーが古く未整理ボックスを受け付けなくても、ほかの記録は送れ、取り込みは消えずに待つ', async () => {
    const { a, b, trip } = await setup();
    const orig = a.t.push.bind(a.t);
    a.t.push = async (ops, dev) => {
      if (ops.some((o) => o.entity_type === 'inboxItem')) throw new TransportError('validation', 'invalid entity_type');
      return orig(ops, dev);
    };
    await saveInboxItem(a.ctx, await buildInboxItem(trip.id, { sourceType: 'manual', sourceText: 'あとで見る' }));
    await addItems(a.ctx, trip.id, 'task', ['KRLに乗る']);
    await a.sync();
    await b.sync();
    expect((await listItems(b.db, trip.id, 'task')).map((t) => t.title)).toEqual(['KRLに乗る']);
    const waiting = await a.db.outbox.where('entityType').equals('inboxItem').toArray();
    expect(waiting).toHaveLength(1);
    expect(waiting[0].status).toBe('pending');
    expect(waiting[0].nextAttemptAt).toBeGreaterThan(Date.now());
  });
});
