-- 外部情報の取り込み（未整理ボックス）：同期できる種類に inboxItem を足す。
-- 既存のデータには触れない。sync_push は種類の一覧だけを変え、ほかは 0001 と同じ。

alter table public.sync_records drop constraint if exists sync_records_entity_type_check;
alter table public.sync_records add constraint sync_records_entity_type_check check (
  entity_type in (
    'trip', 'questionTemplate', 'dailyLog', 'answer', 'audioClip', 'checklistItem',
    'foodExperience', 'note', 'expense', 'media', 'inboxItem', 'link'
  )
);

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
    'foodExperience', 'note', 'expense', 'media', 'inboxItem', 'link'
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
