-- Indonesia Travel Log：本人用の複数端末同期
-- 記録は JSONB の単一同期テーブルに置き、所有者・ID・リビジョン・削除フラグは独立列にする。
-- 書込みは検証済みの RPC（sync_push）だけ。読み取りは RLS で本人の行だけに限る。

-- ---------- テーブル ----------

create table if not exists public.sync_heads (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  revision bigint not null default 0
);

create table if not exists public.sync_records (
  owner_id uuid not null references auth.users (id) on delete cascade,
  entity_type text not null check (
    entity_type in (
      'trip', 'questionTemplate', 'dailyLog', 'answer', 'audioClip', 'checklistItem',
      'foodExperience', 'note', 'expense', 'media', 'link'
    )
  ),
  entity_id uuid not null,
  trip_id uuid not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  revision bigint not null,
  deleted_at timestamptz,
  server_updated_at timestamptz not null default now(),
  updated_by_device text,
  primary key (owner_id, entity_type, entity_id)
);

create index if not exists sync_records_owner_revision_idx on public.sync_records (owner_id, revision);

create table if not exists public.sync_operations (
  owner_id uuid not null references auth.users (id) on delete cascade,
  operation_id uuid not null,
  request_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (owner_id, operation_id)
);

create table if not exists public.device_registry (
  owner_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null,
  display_name text not null check (char_length(display_name) between 1 and 60),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (owner_id, device_id)
);

-- ---------- RLS ----------

alter table public.sync_heads enable row level security;
alter table public.sync_records enable row level security;
alter table public.sync_operations enable row level security;
alter table public.device_registry enable row level security;

revoke all on table public.sync_heads, public.sync_records, public.sync_operations, public.device_registry from public, anon, authenticated;

-- 本人は自分の記録と端末一覧を読める。直接の書込み権限は与えない
grant select on table public.sync_records, public.device_registry to authenticated;

drop policy if exists "sync_records: owner can read" on public.sync_records;
create policy "sync_records: owner can read" on public.sync_records
  for select to authenticated using ((select auth.uid()) = owner_id);

drop policy if exists "device_registry: owner can read" on public.device_registry;
create policy "device_registry: owner can read" on public.device_registry
  for select to authenticated using ((select auth.uid()) = owner_id);

-- ---------- RPC: sync_push ----------
-- p_ops: [{operation_id, entity_type, entity_id, trip_id, base_revision, payload, deleted}]
-- 1 回の呼び出しは原子的に処理する（全件適用か、競合を返して何もしないか）。
-- 戻り値：{status:'ok', results:[{operation_id, entity_type, entity_id, revision}]}
--        {status:'conflict', conflicts:[{operation_id, entity_type, entity_id, revision, payload, deleted}]}

create or replace function public.sync_push(p_ops jsonb, p_device_id text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_allowed text[] := array[
    'trip', 'questionTemplate', 'dailyLog', 'answer', 'audioClip', 'checklistItem',
    'foodExperience', 'note', 'expense', 'media', 'link'
  ];
  v_n integer;
  v_op jsonb;
  v_type text;
  v_id uuid;
  v_trip uuid;
  v_opid uuid;
  v_payload jsonb;
  v_base bigint;
  v_head bigint;
  v_found integer := 0;
  v_stored jsonb := '[]'::jsonb;
  v_conflicts jsonb := '[]'::jsonb;
  v_results jsonb := '[]'::jsonb;
  v_result jsonb;
  v_rec record;
  v_hash text;
  v_keys text[] := array[]::text[];
  v_batch_trips uuid[] := array[]::uuid[];
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_ops is null or jsonb_typeof(p_ops) <> 'array' then
    raise exception 'ops must be an array' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_ops);
  if v_n < 1 or v_n > 200 then
    raise exception 'ops must contain 1..200 items' using errcode = '22023';
  end if;
  if octet_length(p_ops::text) > 4000000 then
    raise exception 'request too large' using errcode = '54000';
  end if;
  if p_device_id is not null and char_length(p_device_id) > 64 then
    raise exception 'device id too long' using errcode = '22023';
  end if;

  -- 入力の検証（型・サイズ・ID の整合）
  for v_op in select value from jsonb_array_elements(p_ops) loop
    if jsonb_typeof(v_op) <> 'object' then
      raise exception 'op must be an object' using errcode = '22023';
    end if;
    v_type := v_op ->> 'entity_type';
    if v_type is null or not (v_type = any (v_allowed)) then
      raise exception 'invalid entity_type' using errcode = '22023';
    end if;
    v_id := (v_op ->> 'entity_id')::uuid;
    v_trip := (v_op ->> 'trip_id')::uuid;
    v_opid := (v_op ->> 'operation_id')::uuid;
    if v_id is null or v_trip is null or v_opid is null then
      raise exception 'ids are required' using errcode = '22023';
    end if;
    if jsonb_typeof(v_op -> 'base_revision') <> 'number' or (v_op ->> 'base_revision')::bigint < 0 then
      raise exception 'invalid base_revision' using errcode = '22023';
    end if;
    if jsonb_typeof(v_op -> 'deleted') <> 'boolean' then
      raise exception 'invalid deleted flag' using errcode = '22023';
    end if;
    v_payload := v_op -> 'payload';
    if v_payload is null or jsonb_typeof(v_payload) <> 'object' then
      raise exception 'payload must be an object' using errcode = '22023';
    end if;
    if octet_length(v_payload::text) > 262144 then
      raise exception 'payload too large' using errcode = '54000';
    end if;
    if (v_payload ->> 'id') is distinct from v_id::text then
      raise exception 'payload.id mismatch' using errcode = '22023';
    end if;
    if (v_payload ->> 'tripId') is distinct from v_trip::text then
      raise exception 'payload.tripId mismatch' using errcode = '22023';
    end if;
    if v_type = 'trip' and v_trip <> v_id then
      raise exception 'trip id mismatch' using errcode = '22023';
    end if;
    if v_payload ? 'localDate' and not ((v_payload ->> 'localDate') ~ '^\d{4}-\d{2}-\d{2}$') then
      raise exception 'invalid localDate' using errcode = '22023';
    end if;
    if v_type = 'expense' and not (
      jsonb_typeof(v_payload -> 'amount') = 'number'
      and (v_payload ->> 'amount')::numeric >= 0
      and (v_payload ->> 'amount')::numeric = trunc((v_payload ->> 'amount')::numeric)
      and (v_payload ->> 'currency') in ('IDR', 'JPY')
    ) then
      raise exception 'invalid expense amount' using errcode = '22023';
    end if;
    if v_type in ('audioClip', 'media') and not (
      (v_payload ->> 'blobId') ~ '^[0-9a-fA-F-]{36}$'
      and jsonb_typeof(v_payload -> 'size') = 'number'
      and (v_payload ->> 'size')::numeric between 0 and 52428800
    ) then
      raise exception 'invalid file reference' using errcode = '22023';
    end if;
    if (v_type || ':' || v_id::text) = any (v_keys) then
      raise exception 'duplicate entity in batch' using errcode = '22023';
    end if;
    v_keys := v_keys || (v_type || ':' || v_id::text);
    if v_type = 'trip' then
      v_batch_trips := v_batch_trips || v_id;
    end if;
  end loop;

  -- ユーザー単位のロック（採番とコミット順をそろえる）
  insert into public.sync_heads (owner_id, revision) values (v_uid, 0)
    on conflict (owner_id) do nothing;
  select h.revision into v_head from public.sync_heads h where h.owner_id = v_uid for update;

  -- 冪等性：同じ operation_id の再送には保存済みの結果を返す
  for v_op in select value from jsonb_array_elements(p_ops) loop
    v_hash := md5(v_op::text);
    select o.request_hash, o.result into v_rec
      from public.sync_operations o
      where o.owner_id = v_uid and o.operation_id = (v_op ->> 'operation_id')::uuid;
    if found then
      if v_rec.request_hash <> v_hash then
        raise exception 'operation_id reused with different content' using errcode = '22023';
      end if;
      v_found := v_found + 1;
      v_stored := v_stored || jsonb_build_array(v_rec.result);
    end if;
  end loop;
  if v_found = v_n then
    return jsonb_build_object('status', 'ok', 'results', v_stored, 'replayed', true);
  elsif v_found > 0 then
    raise exception 'batch partially replayed' using errcode = '22023';
  end if;

  -- 旅行の所有者確認
  for v_op in select value from jsonb_array_elements(p_ops) loop
    v_trip := (v_op ->> 'trip_id')::uuid;
    if (v_op ->> 'entity_type') <> 'trip'
      and not (v_trip = any (v_batch_trips))
      and not exists (
        select 1 from public.sync_records r
        where r.owner_id = v_uid and r.entity_type = 'trip' and r.entity_id = v_trip
      ) then
      raise exception 'unknown trip' using errcode = '23503';
    end if;
  end loop;

  -- 競合の確認：ベースのリビジョンが現在と違えば、最新版を返して何もしない
  for v_op in select value from jsonb_array_elements(p_ops) loop
    v_type := v_op ->> 'entity_type';
    v_id := (v_op ->> 'entity_id')::uuid;
    v_base := (v_op ->> 'base_revision')::bigint;
    select r.revision, r.payload, r.deleted_at into v_rec
      from public.sync_records r
      where r.owner_id = v_uid and r.entity_type = v_type and r.entity_id = v_id;
    if not found then
      if v_base <> 0 then
        v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
          'operation_id', v_op -> 'operation_id', 'entity_type', v_type, 'entity_id', v_id,
          'revision', 0, 'payload', null, 'deleted', false));
      end if;
    elsif v_rec.revision <> v_base then
      v_conflicts := v_conflicts || jsonb_build_array(jsonb_build_object(
        'operation_id', v_op -> 'operation_id', 'entity_type', v_type, 'entity_id', v_id,
        'revision', v_rec.revision, 'payload', v_rec.payload, 'deleted', v_rec.deleted_at is not null));
    end if;
  end loop;
  if jsonb_array_length(v_conflicts) > 0 then
    return jsonb_build_object('status', 'conflict', 'conflicts', v_conflicts);
  end if;

  -- 適用：採番・更新・操作結果を同じトランザクションで確定する
  for v_op in select value from jsonb_array_elements(p_ops) loop
    v_head := v_head + 1;
    v_type := v_op ->> 'entity_type';
    v_id := (v_op ->> 'entity_id')::uuid;
    v_opid := (v_op ->> 'operation_id')::uuid;
    insert into public.sync_records as r (
      owner_id, entity_type, entity_id, trip_id, payload, revision, deleted_at, server_updated_at, updated_by_device
    ) values (
      v_uid, v_type, v_id, (v_op ->> 'trip_id')::uuid, v_op -> 'payload', v_head,
      case when (v_op ->> 'deleted')::boolean then now() else null end, now(), p_device_id
    )
    on conflict (owner_id, entity_type, entity_id) do update set
      trip_id = excluded.trip_id,
      payload = excluded.payload,
      revision = excluded.revision,
      deleted_at = excluded.deleted_at,
      server_updated_at = excluded.server_updated_at,
      updated_by_device = excluded.updated_by_device;
    v_result := jsonb_build_object('operation_id', v_opid, 'entity_type', v_type, 'entity_id', v_id, 'revision', v_head);
    insert into public.sync_operations (owner_id, operation_id, request_hash, result)
      values (v_uid, v_opid, md5(v_op::text), v_result);
    v_results := v_results || jsonb_build_array(v_result);
  end loop;
  update public.sync_heads set revision = v_head where owner_id = v_uid;

  return jsonb_build_object('status', 'ok', 'results', v_results);
end;
$$;

revoke all on function public.sync_push(jsonb, text) from public, anon;
grant execute on function public.sync_push(jsonb, text) to authenticated;

-- ---------- RPC: register_device ----------

create or replace function public.register_device(p_device_id uuid, p_display_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_device_id is null or p_display_name is null or char_length(p_display_name) not between 1 and 60 then
    raise exception 'invalid device' using errcode = '22023';
  end if;
  insert into public.device_registry (owner_id, device_id, display_name, last_synced_at)
    values (v_uid, p_device_id, p_display_name, now())
    on conflict (owner_id, device_id) do update
      set display_name = excluded.display_name, last_synced_at = excluded.last_synced_at;
end;
$$;

revoke all on function public.register_device(uuid, text) from public, anon;
grant execute on function public.register_device(uuid, text) to authenticated;
