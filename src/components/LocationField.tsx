import { useState } from 'react';
import { useApp } from '../app/context';
import { formatPosition, getCurrentPosition, mapUrl } from '../lib/geo';
import { Field } from './ui';

/** 場所の欄：「📍 現在地を入れる」で座標を入れ、「地図で開く」で確かめる（常時の追跡はしない） */
export function LocationField(props: { label?: string; value: string | null | undefined; onChange: (v: string | null) => void; hint?: string }) {
  const { toast } = useApp();
  const [locating, setLocating] = useState(false);
  const url = mapUrl(props.value);
  return (
    <>
      <Field label={props.label ?? '場所（任意）'} hint={props.hint}>
        <input value={props.value ?? ''} onChange={(e) => props.onChange(e.target.value || null)} placeholder="📍 で現在地を入れられます" />
      </Field>
      <div className="actions">
        <button
          type="button"
          className="btn small"
          disabled={locating}
          onClick={async () => {
            setLocating(true);
            try {
              props.onChange(formatPosition(await getCurrentPosition()));
            } catch (e) {
              toast((e as Error).message, { kind: 'error' });
            } finally {
              setLocating(false);
            }
          }}
        >
          {locating ? '取得中…' : '📍 現在地を入れる'}
        </button>
        {url && (
          <a className="link" href={url} target="_blank" rel="noopener noreferrer">
            地図で開く
          </a>
        )}
      </div>
    </>
  );
}
