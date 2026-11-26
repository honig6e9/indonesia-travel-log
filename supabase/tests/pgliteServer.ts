// テスト用：PGlite（WASM の Postgres）で本物のマイグレーションを流し、
// Supabase の auth / storage を最小限に模して RPC と RLS を検証する。
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  TransportError,
  type DeviceInfo,
  type PushOp,
  type PushResult,
  type ServerRecord,
  type Transport,
} from '../../src/features/sync/transport';

const BOOTSTRAP = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;
grant usage on schema public to anon, authenticated;

create schema storage;
create table storage.buckets (id text primary key, name text not null, public boolean default false, file_size_limit bigint);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text not null,
  owner uuid,
  size bigint,
  data bytea,
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;
grant usage on schema storage to anon, authenticated;
grant execute on function storage.foldername(text) to anon, authenticated;
grant select, insert, update, delete on storage.objects to anon, authenticated;
`;

export async function createServer() {
  const pg = new PGlite();
  await pg.exec(BOOTSTRAP);
  const dir = join(process.cwd(), 'supabase', 'migrations');
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    await pg.exec(readFileSync(join(dir, f), 'utf8'));
  }
  return pg;
}

export async function addUser(pg: PGlite, id: string) {
  await pg.query('insert into auth.users (id, email) values ($1, $2)', [id, id + '@example.test']);
}

/** 指定の役割・ユーザーとして 1 つのトランザクションを実行する */
export async function asRole<T>(pg: PGlite, role: 'anon' | 'authenticated', uid: string | null, fn: (q: PGlite) => Promise<T>): Promise<T> {
  return pg.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid ?? '']);
    return fn(tx as unknown as PGlite);
  });
}

function toErr(e: unknown): TransportError {
  const code = (e as { code?: string }).code;
  const msg = (e as Error).message;
  if (code === '28000') return new TransportError('auth', msg);
  if (code === '22023' || code === '23503' || code === '22P02') return new TransportError('validation', msg);
  if (code === '54000') return new TransportError('too-large', msg);
  return new TransportError('server', msg);
}

/** PGlite を相手にした Transport。ファイルはメモリ内に置く（storage の RLS は別テストで確認） */
export class PgliteTransport implements Transport {
  /** true にすると「サーバーは書込み完了したが応答が失われた」状態を 1 回だけ作る */
  dropNextResponse = false;
  offline = false;
  constructor(
    private pg: PGlite,
    public uid: string,
    private files: Map<string, Blob>,
  ) {}

  private check() {
    if (this.offline) throw new TransportError('network', 'offline');
  }

  async push(ops: PushOp[], deviceId: string): Promise<PushResult> {
    this.check();
    let res: PushResult;
    try {
      res = await asRole(this.pg, 'authenticated', this.uid, async (q) => {
        const r = await q.query<{ r: PushResult }>('select public.sync_push($1::jsonb, $2) as r', [JSON.stringify(ops), deviceId]);
        return r.rows[0].r;
      });
    } catch (e) {
      throw toErr(e);
    }
    if (this.dropNextResponse) {
      this.dropNextResponse = false;
      throw new TransportError('network', 'response lost');
    }
    return res;
  }

  async pull(since: number, limit: number): Promise<ServerRecord[]> {
    this.check();
    return asRole(this.pg, 'authenticated', this.uid, async (q) => {
      const r = await q.query<ServerRecord>(
        'select entity_type, entity_id, payload, revision::int as revision, deleted_at from public.sync_records where revision > $1 order by revision asc limit $2',
        [since, limit],
      );
      return r.rows.map((x) => ({ ...x, deleted_at: x.deleted_at ? String(x.deleted_at) : null }));
    });
  }

  async uploadBlob(path: string, blob: Blob): Promise<'ok' | 'exists'> {
    this.check();
    if (!path.startsWith(this.uid + '/')) throw new TransportError('auth', 'forbidden path');
    if (this.files.has(path)) return 'exists';
    this.files.set(path, blob);
    return 'ok';
  }

  async downloadBlob(path: string): Promise<Blob> {
    this.check();
    if (!path.startsWith(this.uid + '/')) throw new TransportError('auth', 'forbidden path');
    const b = this.files.get(path);
    if (!b) throw new TransportError('server', 'not found');
    return b;
  }

  async registerDevice(deviceId: string, name: string): Promise<void> {
    this.check();
    await asRole(this.pg, 'authenticated', this.uid, (q) => q.query('select public.register_device($1, $2)', [deviceId, name]));
  }

  async listDevices(): Promise<DeviceInfo[]> {
    return asRole(this.pg, 'authenticated', this.uid, async (q) => {
      const r = await q.query<DeviceInfo>('select device_id, display_name, last_synced_at from public.device_registry');
      return r.rows;
    });
  }
}
