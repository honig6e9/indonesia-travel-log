-- 通訳：スマホが話した音声（または文）を受付に積み、家の PC の通訳プログラムが訳して書き戻す。
-- スマホ（本人）は受付と結果を読めるが、結果を書けるのは PC のプログラム（service_role）だけ。

create table if not exists public.interpret_jobs (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  device_id text,
  created_at timestamptz not null default now(),
  -- 入力：音声のパス（{owner}/interpret/{id}.{ext}）か、文字
  audio_path text,
  input_text text check (input_text is null or char_length(input_text) <= 2000),
  mode text not null default 'auto' check (mode in ('auto', 'ja-id', 'id-ja')),
  status text not null default 'queued' check (status in ('queued', 'processing', 'done', 'error')),
  source_lang text,
  source_text text,
  target_lang text,
  target_text text,
  reading text,
  provider text,
  error text,
  attempts integer not null default 0,
  claimed_at timestamptz,
  processed_at timestamptz,
  check (audio_path is not null or input_text is not null)
);

create index if not exists interpret_jobs_status_idx on public.interpret_jobs (status, created_at);
create index if not exists interpret_jobs_owner_idx on public.interpret_jobs (owner_id, created_at desc);

alter table public.interpret_jobs enable row level security;
revoke all on table public.interpret_jobs from public, anon, authenticated;
grant select on table public.interpret_jobs to authenticated;

drop policy if exists "interpret_jobs: owner can read" on public.interpret_jobs;
create policy "interpret_jobs: owner can read" on public.interpret_jobs
  for select to authenticated using ((select auth.uid()) = owner_id);

-- 受付は RPC だけ（所有者は auth.uid()、音声のパスは本人のフォルダに限る）
create or replace function public.interpret_enqueue(
  p_id uuid,
  p_audio_path text,
  p_input_text text,
  p_mode text,
  p_device_id text default null
)
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
  if p_id is null or (p_audio_path is null and coalesce(p_input_text, '') = '') then
    raise exception 'audio or text is required' using errcode = '22023';
  end if;
  if p_audio_path is not null and p_audio_path !~ ('^' || v_uid::text || '/interpret/[0-9a-fA-F-]{36}\.[a-z0-9]{1,8}$') then
    raise exception 'invalid audio path' using errcode = '22023';
  end if;
  if p_input_text is not null and char_length(p_input_text) > 2000 then
    raise exception 'text too long' using errcode = '22023';
  end if;
  if coalesce(p_mode, 'auto') not in ('auto', 'ja-id', 'id-ja') then
    raise exception 'invalid mode' using errcode = '22023';
  end if;
  if p_device_id is not null and char_length(p_device_id) > 64 then
    raise exception 'device id too long' using errcode = '22023';
  end if;
  -- 同じ ID の再送は何もしない（冪等）
  insert into public.interpret_jobs (id, owner_id, device_id, audio_path, input_text, mode)
  values (p_id, v_uid, p_device_id, p_audio_path, nullif(p_input_text, ''), coalesce(p_mode, 'auto'))
  on conflict (id) do nothing;
end;
$$;

revoke all on function public.interpret_enqueue(uuid, text, text, text, text) from public, anon;
grant execute on function public.interpret_enqueue(uuid, text, text, text, text) to authenticated;

-- 家の PC の通訳プログラムの応答状況（中身は時刻と状態だけ）
create table if not exists public.interpret_worker (
  id text primary key,
  last_seen timestamptz not null default now(),
  status text,
  info jsonb
);

alter table public.interpret_worker enable row level security;
revoke all on table public.interpret_worker from public, anon, authenticated;
grant select on table public.interpret_worker to authenticated;

drop policy if exists "interpret_worker: signed-in users can read" on public.interpret_worker;
create policy "interpret_worker: signed-in users can read" on public.interpret_worker
  for select to authenticated using (true);
