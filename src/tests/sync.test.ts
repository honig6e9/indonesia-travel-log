// 2 台の端末（別々の IndexedDB）と PGlite のサーバーで同期を検証する（S01・S03〜S08・S13・S14 の自動化できる部分）
import { beforeEach, describe, expect, it } from 'vitest';
import Dexie from 'dexie';
import type { PGlite } from '@electric-sql/pglite';
import { TravelDB } from '../db/db';
import { alive, transact, type Ctx } from '../db/repo';
import { SyncEngine, missingBlobs } from '../features/sync/engine';
import { resolveWith } from '../features/sync/merge';
import { resolveConflictTx } from '../features/sync/engine';
import { addUser, createServer, PgliteTransport } from '../../supabase/tests/pgliteServer';
import { createTrip, getActiveTrip } from '../features/daily/tripRepo';
import { blankNote, saveNote } from '../features/notes/notesRepo';
import { addItems, listItems, saveExperience, setItemStatus, listExperiences } from '../features/checklist/checklistRepo';
import { loadDiary, saveClip, setAnswerNote } from '../features/diary/diaryRepo';

const A = '00000000-0000-4000-8000-0000000000aa';
const B = '00000000-0000-4000-8000-0000000000bb';

let pg: PGlite;
let files: Map<string, Blob>;
let n = 0;

interface Device {
  db: TravelDB;
  ctx: Ctx;
  t: PgliteTransport;
  engine: SyncEngine;
  sync: () => ReturnType<SyncEngine['sync']>;
}

function device(owner: string, name: string): Device {
  const db = new TravelDB(`test-${name}-${n++}`);
  const t = new PgliteTransport(pg, owner, files);
  const engine = new SyncEngine(db, owner, crypto.randomUUID(), name, t);
  return { db, ctx: { db, ownerId: owner }, t, engine, sync: () => engine.sync({ uploadMedia: true }) };
}

beforeEach(async () => {
  pg = await createServer();
  await addUser(pg, A);
  await addUser(pg, B);
  files = new Map();
});

async function setup() {
  const a = device(A, 'phoneA');
  const b = device(A, 'phoneB');
  await createTrip(a.ctx);
  expect((await a.sync()).errors).toEqual([]);
  expect((await b.sync()).errors).toEqual([]);
  const trip = (await getActiveTrip(b.db))!;
  return { a, b, trip };
}

describe('同期', () => {
  it('S01：リストとメモが双方向に同期される', async () => {
    const { a, b, trip } = await setup();
    expect(trip).toBeTruthy();
    expect((await b.db.questionTemplates.count())).toBe(8);
    await addItems(b.ctx, trip.id, 'task', ['KRLに乗る', 'MRTに乗る']);
    const note = blankNote(trip.id, '2026-11-29');
    await saveNote(a.ctx, { ...note, body: 'Aのメモ' });
    await b.sync();
    await a.sync();
    await b.sync();
    expect((await listItems(a.db, trip.id, 'task')).map((i) => i.title)).toEqual(['KRLに乗る', 'MRTに乗る']);
    expect(alive(await b.db.notes.toArray())[0].body).toBe('Aのメモ');
    expect(await a.db.outbox.count()).toBe(0);
    expect(await b.db.outbox.count()).toBe(0);
  });

  it('S02/S03：オフラインで記録した音声が再接続後に届き、両端末の追記クリップが共存する', async () => {
    const { a, b, trip } = await setup();
    a.t.offline = true;
    await saveClip(a.ctx, { tripId: trip.id, localDate: '2026-11-29', questionId: 'q01', blob: new Blob(['audio-A']), mimeType: 'audio/webm', ext: 'webm', durationMs: 1000 });
    const r = await a.sync();
    expect(r.stoppedBy).toBe('network');
    expect(await a.db.outbox.count()).toBeGreaterThan(0); // 通信断でキューを消さない
    await saveClip(b.ctx, { tripId: trip.id, localDate: '2026-11-29', questionId: 'q01', blob: new Blob(['audio-B']), mimeType: 'audio/webm', ext: 'webm', durationMs: 2000 });
    await b.sync();
    a.t.offline = false;
    await a.sync();
    await b.sync();
    const dA = await loadDiary(a.db, trip.id, '2026-11-29');
    const dB = await loadDiary(b.db, trip.id, '2026-11-29');
    expect(dA.clipsByQuestion.get('q01')).toHaveLength(2);
    expect(dB.clipsByQuestion.get('q01')).toHaveLength(2);
    // 未取得の音声は A の端末にない → 取得すると再生できる（S11）
    const missing = await missingBlobs(a.db);
    expect(missing).toHaveLength(1);
    const f = await a.engine.fetchMissing({ localDate: '2026-11-29' });
    expect(f.fetched).toBe(1);
    expect(await missingBlobs(a.db)).toHaveLength(0);
    const blobs = await Promise.all(dA.clipsByQuestion.get('q01')!.map((c) => a.db.blobs.get(c.blobId)));
    expect((await Promise.all(blobs.map((x) => x!.blob.text()))).sort()).toEqual(['audio-A', 'audio-B']);
  });

  it('S04：2 台がオフラインで同じ日・質問を作っても日記と回答が重複しない', async () => {
    const { a, b, trip } = await setup();
    await setAnswerNote(a.ctx, trip.id, '2026-11-30', 'q02', '');
    await saveClip(a.ctx, { tripId: trip.id, localDate: '2026-11-30', questionId: 'q02', blob: new Blob(['a']), mimeType: 'audio/webm', ext: 'webm', durationMs: 1 });
    await saveClip(b.ctx, { tripId: trip.id, localDate: '2026-11-30', questionId: 'q02', blob: new Blob(['b']), mimeType: 'audio/webm', ext: 'webm', durationMs: 1 });
    await a.sync();
    await b.sync();
    await a.sync();
    expect(alive(await a.db.dailyLogs.toArray())).toHaveLength(1);
    expect(alive(await b.db.dailyLogs.toArray())).toHaveLength(1);
    expect(alive(await b.db.answers.toArray())).toHaveLength(1);
    expect(alive(await a.db.audioClips.toArray())).toHaveLength(2);
    expect(alive(await b.db.audioClips.toArray())).toHaveLength(2);
    expect(await b.db.conflicts.where('status').equals('open').count()).toBe(0);
  });

  it('S05：同じ項目の異なる編集は競合になり、両方の内容を保つ。解決後に両端末がそろう', async () => {
    const { a, b, trip } = await setup();
    await addItems(a.ctx, trip.id, 'task', ['洗濯']);
    await a.sync();
    await b.sync();
    const itemA = (await listItems(a.db, trip.id, 'task'))[0];
    const itemB = (await listItems(b.db, trip.id, 'task'))[0];
    await transact(a.ctx, (w) => w.put('checklistItem', { ...itemA, note: 'Aの体験メモ' }));
    await transact(b.ctx, (w) => w.put('checklistItem', { ...itemB, note: 'Bの体験メモ' }));
    await a.sync();
    await b.sync();
    const c = (await b.db.conflicts.where('status').equals('open').toArray())[0];
    expect(c.fields).toEqual(['note']);
    expect(c.local.note).toBe('Bの体験メモ');
    expect(c.server!.note).toBe('Aの体験メモ');
    // 選択確定までは送らない
    expect((await b.db.outbox.toArray())[0].status).toBe('conflict');
    const current = (await b.db.checklistItems.get(c.entityId)) as unknown as Record<string, unknown>;
    await b.db.transaction('rw', b.db.tables, () => resolveConflictTx(b.db, c.id, resolveWith(current, c.local, c.server, { note: 'server' })));
    await b.sync();
    await a.sync();
    expect((await a.db.checklistItems.get(itemA.id))!.note).toBe('Aの体験メモ');
    expect((await b.db.checklistItems.get(itemA.id))!.note).toBe('Aの体験メモ');
  });

  it('S05：削除と編集の衝突は削除を確定せず競合にする', async () => {
    const { a, b, trip } = await setup();
    const note = await saveNote(a.ctx, { ...blankNote(trip.id, '2026-11-29'), body: '元' });
    await a.sync();
    await b.sync();
    await transact(a.ctx, (w) => w.remove('note', note.id));
    const nb = (await b.db.notes.get(note.id))!;
    await saveNote(b.ctx, { ...nb, body: '編集' });
    await a.sync();
    await b.sync();
    const c = (await b.db.conflicts.toArray())[0];
    expect(c.fields).toContain('__deleted__');
    expect((await b.db.notes.get(note.id))!.deletedAt).toBeFalsy();
  });

  it('S06：別フィールドの更新は自動でマージされる', async () => {
    const { a, b, trip } = await setup();
    await addItems(a.ctx, trip.id, 'food', ['Rendang（ルンダン）']);
    await a.sync();
    await b.sync();
    const ia = (await listItems(a.db, trip.id, 'food'))[0];
    expect(ia.localName).toBe('Rendang');
    const ib = (await listItems(b.db, trip.id, 'food'))[0];
    await transact(a.ctx, (w) => w.put('checklistItem', { ...ia, area: 'パダン料理店' }));
    await transact(b.ctx, (w) => w.put('checklistItem', { ...ib, priority: 'high' }));
    await a.sync();
    await b.sync();
    await a.sync();
    for (const d of [a, b]) {
      const it2 = (await d.db.checklistItems.get(ia.id))!;
      expect(it2.area).toBe('パダン料理店');
      expect(it2.priority).toBe('high');
      expect(await d.db.conflicts.count()).toBe(0);
    }
  });

  it('S06：同時の「食べた」チェックで実食が二重に作られず、支出も二重登録されない', async () => {
    const { a, b, trip } = await setup();
    await addItems(a.ctx, trip.id, 'food', ['Bakso（バクソ）']);
    await a.sync();
    await b.sync();
    const ia = (await listItems(a.db, trip.id, 'food'))[0];
    const ib = (await listItems(b.db, trip.id, 'food'))[0];
    await setItemStatus(a.ctx, ia, 'done', '2026-12-01');
    await setItemStatus(b.ctx, ib, 'done', '2026-12-01');
    await a.sync();
    await b.sync();
    await a.sync();
    expect(await listExperiences(a.db, ia.id)).toHaveLength(1);
    expect(await listExperiences(b.db, ia.id)).toHaveLength(1);
    // 実食に価格を入れ「支出にも登録」を 2 回保存しても、支出は 1 件
    const exp = (await listExperiences(a.db, ia.id))[0];
    await saveExperience(a.ctx, ia, { ...exp, shop: '屋台', price: 25000 }, true, 1);
    const exp2 = (await listExperiences(a.db, ia.id))[0];
    await saveExperience(a.ctx, ia, { ...exp2, price: 30000 }, true, 1);
    await a.sync();
    await b.sync();
    const ex = alive(await b.db.expenses.toArray());
    expect(ex).toHaveLength(1);
    expect(ex[0].amount).toBe(30000);
  });

  it('S07：サーバーが書込み完了後に応答を失っても、再送で重複せず、他端末の更新も欠落しない', async () => {
    const { a, b, trip } = await setup();
    await saveNote(a.ctx, { ...blankNote(trip.id, '2026-11-29'), body: '一度だけ' });
    a.t.dropNextResponse = true;
    const r1 = await a.sync();
    expect(r1.stoppedBy).toBe('network');
    await saveNote(b.ctx, { ...blankNote(trip.id, '2026-11-29'), body: 'Bの更新' });
    await b.sync();
    const r2 = await a.sync();
    expect(r2.errors).toEqual([]);
    const server = await pg.query<{ c: number }>(`select count(*)::int as c from public.sync_records where entity_type = 'note'`);
    expect(server.rows[0].c).toBe(2);
    expect(alive(await a.db.notes.toArray()).map((x) => x.body).sort()).toEqual(['Bの更新', '一度だけ']);
    expect(await a.db.outbox.count()).toBe(0);
  });

  it('S07：送信中に追加された編集は新しいベースに載せ替えて送る', async () => {
    const { a, b, trip } = await setup();
    const note = await saveNote(a.ctx, { ...blankNote(trip.id, '2026-11-29'), body: '1' });
    a.t.dropNextResponse = true;
    await a.sync(); // 1 はサーバーに入ったが応答なし
    await saveNote(a.ctx, { ...(await a.db.notes.get(note.id))!, body: '2' });
    expect(await a.db.outbox.count()).toBe(2); // 送信済みの操作は書き換えない
    await a.sync();
    await b.sync();
    expect((await b.db.notes.get(note.id))!.body).toBe('2');
    expect(await a.db.conflicts.count()).toBe(0);
  });

  it('S13：別アカウントのキューは送らない', async () => {
    const { a, trip } = await setup();
    await saveNote(a.ctx, { ...blankNote(trip.id, '2026-11-29'), body: 'Aのもの' });
    // 同じ DB を別ユーザーのエンジンで同期しても、A の操作は送られない
    const other = new SyncEngine(a.db, B, crypto.randomUUID(), 'x', new PgliteTransport(pg, B, files));
    await other.sync({ uploadMedia: true });
    const rows = await pg.query<{ c: number }>(`select count(*)::int as c from public.sync_records where owner_id = $1`, [B]);
    expect(rows.rows[0].c).toBe(0);
    expect(await a.db.outbox.count()).toBe(1);
  });

  it('S08：ファイルが大きすぎるときは元ファイルを残し、理由を示し、無限に再試行しない', async () => {
    const { a, trip } = await setup();
    const big = new Blob([new Uint8Array(51 * 1024 * 1024)]);
    await saveClip(a.ctx, { tripId: trip.id, localDate: '2026-11-29', questionId: null, blob: big, mimeType: 'audio/webm', ext: 'webm', durationMs: 1 });
    const r = await a.sync();
    expect(r.errors.join()).toMatch(/大きすぎ/);
    const op = (await a.db.outbox.toArray()).find((o) => o.entityType === 'audioClip')!;
    expect(op.status).toBe('error');
    expect((await a.db.blobs.toArray()).some((b) => b.size === big.size)).toBe(true);
  });

  it('S14：別インスタンスで開き直しても outbox と未送信音声が残る', async () => {
    const a = device(A, 'persist');
    await createTrip(a.ctx);
    const trip = (await getActiveTrip(a.db))!;
    await saveClip(a.ctx, { tripId: trip.id, localDate: '2026-11-29', questionId: 'q03', blob: new Blob(['x']), mimeType: 'audio/webm', ext: 'webm', durationMs: 1 });
    const name = a.db.name;
    a.db.close();
    const reopened = new TravelDB(name);
    expect(await reopened.outbox.count()).toBeGreaterThan(0);
    expect(await reopened.blobs.count()).toBe(1);
    reopened.close();
    await Dexie.delete(name);
  });
});
