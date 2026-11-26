import { useRef, useState } from 'react';
import { useApp } from '../../app/context';
import { getSetting } from '../../db/db';
import type { EntityType } from '../../db/types';
import { addPhoto } from './mediaRepo';

/** カメラ／ギャラリーから写真を追加する（複数可）。選択日を勝手に変えない */
export function PhotoButton(props: { date: string; linkTo?: { type: EntityType; id: string } | null; label?: string; className?: string }) {
  const { ctx, db, trip, toast } = useApp();
  const camRef = useRef<HTMLInputElement>(null);
  const galRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const onFiles = async (files: FileList | null) => {
    setOpen(false);
    if (!files || files.length === 0) return;
    setBusy(true);
    const compress = await getSetting<boolean>(db, 'compressPhotosForCloud', false);
    let ok = 0;
    for (const f of Array.from(files)) {
      try {
        await addPhoto(ctx, f, { tripId: trip.id, localDate: props.date, compressForCloud: compress, linkTo: props.linkTo });
        ok++;
      } catch (e) {
        const name = (e as Error).name;
        toast(name === 'QuotaExceededError' ? '端末の容量が足りず、写真を保存できませんでした' : `写真を保存できませんでした：${f.name}`, { kind: 'error' });
      }
    }
    setBusy(false);
    if (ok) toast(`写真 ${ok} 枚を端末に保存しました（${props.date}）`);
    if (camRef.current) camRef.current.value = '';
    if (galRef.current) galRef.current.value = '';
  };

  return (
    <span className="photo-btn">
      <button className={props.className ?? 'btn'} disabled={busy} onClick={() => setOpen((o) => !o)}>
        {busy ? '保存中…' : (props.label ?? '📷 写真')}
      </button>
      {open && (
        <span className="popover">
          <button className="btn small" onClick={() => camRef.current?.click()}>カメラで撮る</button>
          <button className="btn small" onClick={() => galRef.current?.click()}>ギャラリーから選ぶ</button>
        </span>
      )}
      <input ref={camRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => void onFiles(e.target.files)} />
      <input ref={galRef} type="file" accept="image/*" multiple hidden onChange={(e) => void onFiles(e.target.files)} />
    </span>
  );
}
