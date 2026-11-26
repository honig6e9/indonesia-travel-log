-- 音声・写真の非公開バケット。パスは {ownerId}/{tripId}/{blobId}.{ext}
-- 本人の先頭フォルダだけ SELECT / INSERT を許可。UPDATE（上書き）と DELETE のポリシーは作らない。

insert into storage.buckets (id, name, public, file_size_limit)
values ('travel-media', 'travel-media', false, 52428800)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "travel-media: owner can read" on storage.objects;
create policy "travel-media: owner can read" on storage.objects
  for select to authenticated
  using (bucket_id = 'travel-media' and (storage.foldername(name))[1] = (select auth.uid())::text);

drop policy if exists "travel-media: owner can upload" on storage.objects;
create policy "travel-media: owner can upload" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'travel-media' and (storage.foldername(name))[1] = (select auth.uid())::text);
