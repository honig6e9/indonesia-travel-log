import { useEffect, useState, type ReactNode } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../app/context';
import { VISIBILITY_LABEL, type Visibility } from '../db/types';
import { formatDuration } from '../lib/format';

export function Sheet(props: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [props]);
  return (
    <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className="sheet" role="dialog" aria-modal="true" aria-label={props.title}>
        <div className="sheet-head">
          <h2>{props.title}</h2>
          <button className="icon-btn" onClick={props.onClose} aria-label="閉じる">✕</button>
        </div>
        <div className="sheet-body">{props.children}</div>
        {props.footer && <div className="sheet-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

export function Field(props: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.hint && <span className="field-hint">{props.hint}</span>}
    </label>
  );
}

export function VisibilitySelect(props: { value: Visibility; onChange: (v: Visibility) => void }) {
  return (
    <Field label="公開区分" hint="「公開候補」にしても、匿名化や同意が済んだことにはなりません">
      <select value={props.value} onChange={(e) => props.onChange(e.target.value as Visibility)}>
        {(Object.keys(VISIBILITY_LABEL) as Visibility[]).map((v) => (
          <option key={v} value={v}>
            {VISIBILITY_LABEL[v]}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Blob の Object URL を作り、外すときに解放する */
export function useBlobUrl(blobId: string | null | undefined) {
  const { db } = useApp();
  const row = useLiveQuery(async () => (blobId ? ((await db.blobs.get(blobId)) ?? null) : null), [db, blobId]);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!row) {
      setUrl(null);
      return;
    }
    const u = URL.createObjectURL(row.blob);
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [row]);
  return { url, missing: row === null, loading: row === undefined };
}

export function FetchButton(props: { blobIds: string[]; label?: string }) {
  const { sync, toast } = useApp();
  const [busy, setBusy] = useState(false);
  if (!sync.available) return <span className="muted small">未取得（{sync.reason ?? 'オンラインで同期すると取得できます'}）</span>;
  return (
    <button
      className="btn small"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const r = await sync.fetchMedia({ blobIds: props.blobIds });
        setBusy(false);
        if (!r) toast('ほかの同期が終わってから、もう一度お試しください');
        else if (r.failed.length) toast('取得できませんでした。通信を確認してください', { kind: 'error' });
      }}
    >
      {busy ? '取得中…' : (props.label ?? '未取得：取得する')}
    </button>
  );
}

export function AudioPlayer(props: { blobId: string; durationMs?: number; label?: string }) {
  const { url, missing } = useBlobUrl(props.blobId);
  if (missing) {
    return (
      <div className="audio missing">
        <span className="muted small">
          {props.label} {props.durationMs ? formatDuration(props.durationMs) : ''} 未取得の音声（この端末にありません。機内モードでは再生できません）
        </span>
        <FetchButton blobIds={[props.blobId]} />
      </div>
    );
  }
  return (
    <div className="audio">
      {props.label && <span className="small muted">{props.label}</span>}
      {url ? <audio controls preload="metadata" src={url} /> : <span className="muted small">読み込み中…</span>}
    </div>
  );
}

export function Thumb(props: { blobId: string; thumbId?: string | null; alt: string; onClick?: () => void }) {
  const t = useBlobUrl(props.thumbId ?? props.blobId);
  const full = useBlobUrl(t.missing && props.thumbId ? props.blobId : null);
  const url = t.url ?? full.url;
  return (
    <button className="thumb" onClick={props.onClick} aria-label={props.alt}>
      {url ? <img src={url} alt={props.alt} loading="lazy" /> : <span className="muted small">未取得</span>}
    </button>
  );
}

export function Empty(props: { children: ReactNode }) {
  return <p className="empty">{props.children}</p>;
}

export function Stars(props: { value: number | null | undefined; onChange: (v: number | null) => void }) {
  return (
    <div className="stars" role="radiogroup" aria-label="評価">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={props.value === n}
          className={'star' + ((props.value ?? 0) >= n ? ' on' : '')}
          onClick={() => props.onChange(props.value === n ? null : n)}
        >
          ★
        </button>
      ))}
    </div>
  );
}

/** 入力中の内容を端末に下書き保存する（戻る・タブ切替で失わない） */
export function useDraft<T>(key: string, initial: T): [T, (v: T) => void, () => void, boolean] {
  const [restored] = useState(() => localStorage.getItem('itl-draft:' + key) !== null);
  const [value, setValue] = useState<T>(() => {
    const raw = localStorage.getItem('itl-draft:' + key);
    if (raw) {
      try {
        return JSON.parse(raw) as T;
      } catch {
        /* 壊れた下書きは無視 */
      }
    }
    return initial;
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem('itl-draft:' + key, JSON.stringify(v));
    } catch {
      /* 容量不足でも入力は続けられる */
    }
  };
  const clear = () => localStorage.removeItem('itl-draft:' + key);
  return [value, set, clear, restored];
}

export function numOrNull(s: string): number | null {
  if (s.trim() === '') return null;
  const n = Number(s.replace(/[,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}
