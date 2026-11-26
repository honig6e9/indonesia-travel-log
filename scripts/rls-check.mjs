// 本番（または検証用）の Supabase で RLS / Storage を実際に確かめるスクリプト（S09）。
// 本人 A と別ユーザー B の 2 つのテスト用アカウントが必要です。値は環境変数で渡し、ファイルには書かないでください。
//
//   SUPABASE_URL=... SUPABASE_KEY=<publishable key> \
//   A_EMAIL=... A_PASSWORD=... B_EMAIL=... B_PASSWORD=... node scripts/rls-check.mjs
//
// このスクリプトは A のアカウントに検証用の旅行を 1 件作ります（名前は「RLS 検証用」）。
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';

const { SUPABASE_URL, SUPABASE_KEY, A_EMAIL, A_PASSWORD, B_EMAIL, B_PASSWORD } = process.env;
if (!SUPABASE_URL || !SUPABASE_KEY || !A_EMAIL || !A_PASSWORD || !B_EMAIL || !B_PASSWORD) {
  console.error('環境変数 SUPABASE_URL, SUPABASE_KEY, A_EMAIL, A_PASSWORD, B_EMAIL, B_PASSWORD が必要です');
  process.exit(2);
}
const opts = { auth: { persistSession: false, autoRefreshToken: false } };
const anon = createClient(SUPABASE_URL, SUPABASE_KEY, opts);
const a = createClient(SUPABASE_URL, SUPABASE_KEY, opts);
const b = createClient(SUPABASE_URL, SUPABASE_KEY, opts);

let failed = 0;
const check = (ok, label) => {
  console.log(`${ok ? 'OK ' : 'NG '} ${label}`);
  if (!ok) failed++;
};

const sa = await a.auth.signInWithPassword({ email: A_EMAIL, password: A_PASSWORD });
const sb = await b.auth.signInWithPassword({ email: B_EMAIL, password: B_PASSWORD });
if (sa.error || sb.error) {
  console.error('ログインできません', sa.error?.message, sb.error?.message);
  process.exit(2);
}
const aId = sa.data.user.id;
const trip = randomUUID();
const op = { operation_id: randomUUID(), entity_type: 'trip', entity_id: trip, trip_id: trip, base_revision: 0, payload: { id: trip, tripId: trip, name: 'RLS 検証用' }, deleted: false };
const push = await a.rpc('sync_push', { p_ops: [op], p_device_id: 'rls-check' });
check(!push.error && push.data?.status === 'ok', 'A は RPC で書き込める');

const ra = await a.from('sync_records').select('entity_id').eq('entity_id', trip);
check(ra.data?.length === 1, 'A は自分の記録を読める');
const rb = await b.from('sync_records').select('entity_id').eq('entity_id', trip);
check(!rb.error && rb.data.length === 0, 'B は A の記録を読めない');
const rn = await anon.from('sync_records').select('entity_id').limit(1);
check(!!rn.error || rn.data.length === 0, '匿名は記録を読めない');
const direct = await a.from('sync_records').update({ payload: {} }).eq('entity_id', trip).select();
check(!!direct.error || direct.data.length === 0, 'A でも記録テーブルへ直接は書き込めない');
const anonRpc = await anon.rpc('sync_push', { p_ops: [{ ...op, operation_id: randomUUID() }], p_device_id: 'x' });
check(!!anonRpc.error, '匿名は RPC を実行できない');

const path = `${aId}/${trip}/${randomUUID()}.txt`;
const up = await a.storage.from('travel-media').upload(path, new Blob(['rls-check']), { contentType: 'text/plain', upsert: false });
check(!up.error, 'A は自分のフォルダにアップロードできる');
const again = await a.storage.from('travel-media').upload(path, new Blob(['overwrite']), { contentType: 'text/plain', upsert: true });
check(!!again.error, '同じパスへの上書きはできない');
const dlA = await a.storage.from('travel-media').download(path);
check(!dlA.error, 'A は自分のファイルを取得できる');
const dlB = await b.storage.from('travel-media').download(path);
check(!!dlB.error, 'B は A のファイルを取得できない');
const dlN = await anon.storage.from('travel-media').download(path);
check(!!dlN.error, '匿名は A のファイルを取得できない');
const upB = await b.storage.from('travel-media').upload(`${aId}/${trip}/${randomUUID()}.txt`, new Blob(['x']), { upsert: false });
check(!!upB.error, 'B は A のフォルダにアップロードできない');
const pub = anon.storage.from('travel-media').getPublicUrl(path).data.publicUrl;
const pubRes = await fetch(pub);
check(!pubRes.ok, '公開 URL ではファイルを取得できない（非公開バケット）');

console.log(failed ? `\n${failed} 件の確認に失敗しました` : '\nすべて OK');
console.log('※ 検証用の旅行レコードと小さなテキストファイルが A のアカウントに残ります（同期すると「RLS 検証用」の旅行が見えます）。');
process.exit(failed ? 1 : 0);
