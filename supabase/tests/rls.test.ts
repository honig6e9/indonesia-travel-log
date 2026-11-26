// S09：他アカウント・匿名から記録・ファイルにアクセスできないこと（RLS / RPC を実際の SQL で検証）
import { beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { addUser, asRole, createServer } from './pgliteServer';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const TRIP = '11111111-1111-4111-8111-111111111111';
const NOTE = '22222222-2222-4222-8222-222222222222';

const tripOp = (opId: string, base = 0, name = 'trip') => ({
  operation_id: opId,
  entity_type: 'trip',
  entity_id: TRIP,
  trip_id: TRIP,
  base_revision: base,
  payload: { id: TRIP, tripId: TRIP, name },
  deleted: false,
});

let pg: PGlite;

async function push(uid: string | null, ops: unknown[], role: 'anon' | 'authenticated' = 'authenticated') {
  return asRole(pg, role, uid, async (q) => (await q.query<{ r: any }>('select public.sync_push($1::jsonb, $2) as r', [JSON.stringify(ops), 'dev'])).rows[0].r);
}

describe('Supabase migration: RLS と sync_push', () => {
  beforeAll(async () => {
    pg = await createServer();
    await addUser(pg, A);
    await addUser(pg, B);
    const r = await push(A, [tripOp('aaaaaaaa-0000-4000-8000-000000000001')]);
    expect(r.status).toBe('ok');
    const r2 = await push(A, [
      {
        operation_id: 'aaaaaaaa-0000-4000-8000-000000000002',
        entity_type: 'note',
        entity_id: NOTE,
        trip_id: TRIP,
        base_revision: 0,
        payload: { id: NOTE, tripId: TRIP, body: '秘密のメモ', localDate: '2026-11-29' },
        deleted: false,
      },
    ]);
    expect(r2.status).toBe('ok');
  });

  it('本人は自分の記録を読める', async () => {
    const rows = await asRole(pg, 'authenticated', A, async (q) => (await q.query('select * from public.sync_records')).rows);
    expect(rows).toHaveLength(2);
  });

  it('別ユーザーは他人の記録を読めない', async () => {
    const rows = await asRole(pg, 'authenticated', B, async (q) => (await q.query('select * from public.sync_records')).rows);
    expect(rows).toHaveLength(0);
  });

  it('匿名は記録テーブルを読めない', async () => {
    await expect(asRole(pg, 'anon', null, (q) => q.query('select * from public.sync_records'))).rejects.toThrow(/permission denied/);
  });

  it('認証済みでも記録テーブルへ直接書き込めない', async () => {
    await expect(
      asRole(pg, 'authenticated', A, (q) =>
        q.query(`update public.sync_records set payload = '{}'::jsonb where owner_id = $1`, [A]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole(pg, 'authenticated', A, (q) =>
        q.query(`insert into public.sync_records (owner_id, entity_type, entity_id, trip_id, payload, revision) values ($1, 'note', gen_random_uuid(), $2, '{}', 1)`, [A, TRIP]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(asRole(pg, 'authenticated', A, (q) => q.query('select * from public.sync_heads'))).rejects.toThrow(/permission denied/);
    await expect(asRole(pg, 'authenticated', A, (q) => q.query('select * from public.sync_operations'))).rejects.toThrow(/permission denied/);
  });

  it('匿名は RPC を実行できない', async () => {
    await expect(push(null, [tripOp('aaaaaaaa-0000-4000-8000-000000000003')], 'anon')).rejects.toThrow(/permission denied/);
  });

  it('別ユーザーが他人の旅行 ID にレコードを足せない（所有者は auth.uid() で決まる）', async () => {
    await expect(
      push(B, [
        {
          operation_id: 'bbbbbbbb-0000-4000-8000-000000000001',
          entity_type: 'note',
          entity_id: '33333333-3333-4333-8333-333333333333',
          trip_id: TRIP,
          base_revision: 0,
          payload: { id: '33333333-3333-4333-8333-333333333333', tripId: TRIP, body: 'x' },
          deleted: false,
        },
      ]),
    ).rejects.toThrow(/unknown trip/);
    // B が同じ ID で旅行を作っても、A の行とは別の所有者の行になる
    const r = await push(B, [tripOp('bbbbbbbb-0000-4000-8000-000000000002', 0, 'B の旅行')]);
    expect(r.status).toBe('ok');
    const aRows = await asRole(pg, 'authenticated', A, async (q) => (await q.query<{ payload: any }>(`select payload from public.sync_records where entity_type = 'trip'`)).rows);
    expect(aRows[0].payload.name).toBe('trip');
  });

  it('ベースのリビジョンが古ければ競合を返し、何も変更しない', async () => {
    const r = await push(A, [tripOp('aaaaaaaa-0000-4000-8000-000000000010', 0, '上書き')]);
    expect(r.status).toBe('conflict');
    expect(r.conflicts[0].payload.name).toBe('trip');
  });

  it('同じ operation_id の再送は保存済みの結果を返す（重複適用しない）', async () => {
    const head = await asRole(pg, 'authenticated', A, async (q) => (await q.query<{ revision: number }>(`select revision::int as revision from public.sync_records where entity_type='trip'`)).rows[0].revision);
    const op = tripOp('aaaaaaaa-0000-4000-8000-000000000011', head, '名前変更');
    const r1 = await push(A, [op]);
    const r2 = await push(A, [op]);
    expect(r1.status).toBe('ok');
    expect(r2.replayed).toBe(true);
    expect(r2.results[0].revision).toBe(r1.results[0].revision);
    // 同じ ID で中身を変えた再送は拒否
    await expect(push(A, [{ ...op, payload: { ...op.payload, name: '別' } }])).rejects.toThrow(/reused/);
  });

  it('不正な入力を拒否する', async () => {
    await expect(push(A, [{ ...tripOp('aaaaaaaa-0000-4000-8000-000000000020'), entity_type: 'secrets' }])).rejects.toThrow(/entity_type/);
    await expect(push(A, [{ ...tripOp('aaaaaaaa-0000-4000-8000-000000000021'), payload: { id: NOTE, tripId: TRIP } }])).rejects.toThrow(/mismatch/);
    await expect(
      push(A, [
        {
          operation_id: 'aaaaaaaa-0000-4000-8000-000000000022',
          entity_type: 'expense',
          entity_id: '44444444-4444-4444-8444-444444444444',
          trip_id: TRIP,
          base_revision: 0,
          payload: { id: '44444444-4444-4444-8444-444444444444', tripId: TRIP, amount: -5, currency: 'IDR' },
          deleted: false,
        },
      ]),
    ).rejects.toThrow(/amount/);
  });

  it('端末一覧も本人だけが読める', async () => {
    await asRole(pg, 'authenticated', A, (q) => q.query(`select public.register_device('55555555-5555-4555-8555-555555555555', 'Pixel')`));
    const a = await asRole(pg, 'authenticated', A, async (q) => (await q.query('select * from public.device_registry')).rows);
    const b = await asRole(pg, 'authenticated', B, async (q) => (await q.query('select * from public.device_registry')).rows);
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(0);
  });

  it('Storage：本人のフォルダだけ読み書きでき、上書き・削除・他人のファイル参照はできない', async () => {
    await asRole(pg, 'authenticated', A, (q) =>
      q.query(`insert into storage.objects (bucket_id, name, size) values ('travel-media', $1, 3)`, [`${A}/${TRIP}/f.webm`]),
    );
    // 他人のフォルダへの書込み
    await expect(
      asRole(pg, 'authenticated', B, (q) =>
        q.query(`insert into storage.objects (bucket_id, name, size) values ('travel-media', $1, 3)`, [`${A}/${TRIP}/evil.webm`]),
      ),
    ).rejects.toThrow(/row-level security/);
    // 他人・匿名の読み取り
    const bRead = await asRole(pg, 'authenticated', B, async (q) => (await q.query('select name from storage.objects')).rows);
    const anonRead = await asRole(pg, 'anon', null, async (q) => (await q.query('select name from storage.objects')).rows);
    const aRead = await asRole(pg, 'authenticated', A, async (q) => (await q.query('select name from storage.objects')).rows);
    expect(bRead).toHaveLength(0);
    expect(anonRead).toHaveLength(0);
    expect(aRead).toHaveLength(1);
    // 上書き・削除（ポリシーがないので 0 行）
    const upd = await asRole(pg, 'authenticated', A, (q) => q.query(`update storage.objects set size = 9`));
    const del = await asRole(pg, 'authenticated', A, (q) => q.query(`delete from storage.objects`));
    expect(upd.affectedRows).toBe(0);
    expect(del.affectedRows).toBe(0);
    const bucket = (await pg.query<{ public: boolean }>(`select public from storage.buckets where id = 'travel-media'`)).rows[0];
    expect(bucket.public).toBe(false);
  });

  it('通訳の受付：本人だけが自分のフォルダの音声で受付でき、他人と匿名は読めない', async () => {
    const job = '66666666-6666-4666-8666-666666666666';
    await asRole(pg, 'authenticated', A, (q) =>
      q.query('select public.interpret_enqueue($1, $2, null, $3, $4)', [job, `${A}/interpret/${job}.webm`, 'auto', 'dev']),
    );
    // 再送は冪等
    await asRole(pg, 'authenticated', A, (q) =>
      q.query('select public.interpret_enqueue($1, $2, null, $3, $4)', [job, `${A}/interpret/${job}.webm`, 'auto', 'dev']),
    );
    const a = await asRole(pg, 'authenticated', A, async (q) => (await q.query<{ status: string; owner_id: string }>('select status, owner_id from public.interpret_jobs')).rows);
    expect(a).toEqual([{ status: 'queued', owner_id: A }]);
    const b = await asRole(pg, 'authenticated', B, async (q) => (await q.query('select * from public.interpret_jobs')).rows);
    expect(b).toHaveLength(0);
    await expect(asRole(pg, 'anon', null, (q) => q.query('select * from public.interpret_jobs'))).rejects.toThrow(/permission denied/);
    // 他人のフォルダの音声・直接の書込み・結果の書換えはできない
    await expect(
      asRole(pg, 'authenticated', B, (q) =>
        q.query('select public.interpret_enqueue($1, $2, null, $3, null)', ['77777777-7777-4777-8777-777777777777', `${A}/interpret/77777777-7777-4777-8777-777777777777.webm`, 'auto']),
      ),
    ).rejects.toThrow(/invalid audio path/);
    await expect(
      asRole(pg, 'authenticated', A, (q) => q.query(`update public.interpret_jobs set target_text = 'x'`)),
    ).rejects.toThrow(/permission denied/);
    await expect(
      asRole(pg, 'anon', null, (q) => q.query('select public.interpret_enqueue($1, null, $2, $3, null)', [job, 'こんにちは', 'auto'])),
    ).rejects.toThrow(/permission denied/);
    // 家の PC（service_role）は受付を読み、結果を書き戻せる
    await pg.transaction(async (tx) => {
      await tx.exec('set local role service_role');
      await tx.query(`update public.interpret_jobs set status = 'done', target_text = 'Halo' where id = $1`, [job]);
      await tx.query(`insert into public.interpret_worker (id, status) values ('home-pc', 'ok')`);
    });
    const done = await asRole(pg, 'authenticated', A, async (q) => (await q.query<{ target_text: string }>('select target_text from public.interpret_jobs')).rows);
    expect(done[0].target_text).toBe('Halo');
    const hb = await asRole(pg, 'authenticated', A, async (q) => (await q.query('select id from public.interpret_worker')).rows);
    expect(hb).toHaveLength(1);
  });
});
