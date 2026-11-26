-- 家の PC の通訳プログラム（service_role キー）が受付を読み、結果を書き戻すための権限。
-- 新しい表に自動で権限を付けない設定のプロジェクトでは、service_role にも明示して付ける必要がある。
grant usage on schema public to service_role;
grant select, update on table public.interpret_jobs to service_role;
grant select, insert, update on table public.interpret_worker to service_role;
