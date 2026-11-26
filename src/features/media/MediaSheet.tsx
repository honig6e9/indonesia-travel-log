import { useState } from 'react';
import { useApp } from '../../app/context';
import { Field, FetchButton, Sheet, VisibilitySelect, useBlobUrl } from '../../components/ui';
import type { Media } from '../../db/types';
import { parseTags } from '../../lib/format';
import { deleteMedia, MEDIA_CATEGORIES, saveMedia } from './mediaRepo';
import { useLiveQuery } from 'dexie-react-hooks';

export function MediaSheet(props: { media: Media; onClose: () => void }) {
  const { ctx, db, toast } = useApp();
  const [m, setM] = useState(props.media);
  const [tags, setTags] = useState(m.tags.join(' '));
  const orig = useLiveQuery(() => db.localOriginals.get(m.id), [db, m.id]);
  const img = useBlobUrl(orig?.blobId ?? m.blobId);
  const update = (patch: Partial<Media>) => setM({ ...m, ...patch });
  return (
    <Sheet
      title="写真"
      onClose={props.onClose}
      footer={
        <>
          <button
            className="btn danger ghost"
            onClick={async () => {
              if (!confirm('この写真を記録から削除しますか？（端末内の画像ファイルは自動では消しません）')) return;
              await deleteMedia(ctx, m.id);
              props.onClose();
            }}
          >
            削除
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              await saveMedia(ctx, { ...m, tags: parseTags(tags) });
              toast('保存しました');
              props.onClose();
            }}
          >
            保存
          </button>
        </>
      }
    >
      {img.url ? <img className="photo-full" src={img.url} alt={m.caption || '写真'} /> : img.missing ? <FetchButton blobIds={[m.blobId]} /> : null}
      {m.cloudCompressed && <p className="muted small">クラウドには圧縮版だけがあります{orig ? '（この端末に原本あり）' : ''}。</p>}
      <Field label="説明">
        <input value={m.caption} onChange={(e) => update({ caption: e.target.value })} />
      </Field>
      <Field label="カテゴリ">
        <select value={m.category} onChange={(e) => update({ category: e.target.value })}>
          {MEDIA_CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </Field>
      <Field label="タグ">
        <input value={tags} onChange={(e) => setTags(e.target.value)} />
      </Field>
      <Field label="記録対象日">
        <input type="date" value={m.localDate} onChange={(e) => e.target.value && update({ localDate: e.target.value })} />
      </Field>
      <VisibilitySelect value={m.visibility} onChange={(visibility) => update({ visibility })} />
      <p className="muted small">顔・位置情報・個人が分かるものが写っていないか、公開前に確認してください。撮影日時はファイルの日時からの推定です。</p>
    </Sheet>
  );
}
