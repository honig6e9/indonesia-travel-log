import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { navigate } from '../../app/router';
import { Empty, Field, Thumb } from '../../components/ui';
import { INBOX_SOURCE_LABEL, type InboxItem, type Media, type Priority } from '../../db/types';
import { timeIn, todayIn } from '../../lib/dates';
import { categoriesFor } from '../checklist/checklistRepo';
import { googleTranslateUrl } from '../interpret/interpretRepo';
import { MediaSheet } from '../media/MediaSheet';
import { safeHttpUrl } from '../../lib/url';
import { inboxTranslationState, needsTranslation, requestInboxTranslation } from './inboxTranslate';
import { PhotoButton } from '../media/PhotoButton';
import {
  convertedTo,
  convertInbox,
  deleteInboxItems,
  inboxMedia,
  setInboxStatus,
  splitEntries,
  TARGET_LABEL,
  updateInboxItem,
  type TargetKind,
} from './inboxRepo';

const KINDS: TargetKind[] = ['task', 'food', 'place', 'idea'];

export function InboxDetailScreen(props: { id: string }) {
  const { db, ctx, trip, today, toast } = useApp();
  const item = useLiveQuery(() => db.inboxItems.get(props.id), [db, props.id]);
  const media = useLiveQuery(() => inboxMedia(db, props.id), [db, props.id]) ?? [];
  const converted = useLiveQuery(() => convertedTo(db, props.id), [db, props.id]) ?? [];
  const tr = useLiveQuery(() => inboxTranslationState(db, props.id), [db, props.id]);
  const [draft, setDraft] = useState<InboxItem | null>(null);
  const [kind, setKind] = useState<TargetKind>('task');
  const [splitMode, setSplitMode] = useState(false);
  const [lines, setLines] = useState<{ text: string; on: boolean }[]>([]);
  const [mediaSheet, setMediaSheet] = useState<Media | null>(null);
  const [busy, setBusy] = useState(false);

  // 家の PC の訳が届いたら、日本語訳の欄にも反映する（欄を手で書き換えていなければ）
  const prevTrans = useRef<string | null>(null);
  useEffect(() => {
    if (!item) return;
    if (!draft || draft.id !== item.id) setDraft(item);
    else if (prevTrans.current !== null && item.translatedText !== prevTrans.current && draft.translatedText === prevTrans.current)
      setDraft({ ...draft, translatedText: item.translatedText, translationSource: item.translationSource });
    prevTrans.current = item.translatedText;
  }, [item, draft]);

  if (item === undefined) return <div className="screen"><p className="muted">読み込み中…</p></div>;
  if (!item || item.deletedAt || !draft)
    return (
      <div className="screen">
        <Empty>この情報は見つかりません（削除された可能性があります）。</Empty>
        <button className="btn" onClick={() => navigate('inbox')}>未整理ボックスへ</button>
      </div>
    );

  const set = (patch: Partial<InboxItem>) => setDraft({ ...draft, ...patch });
  const dirty = (['title', 'memo', 'translatedText', 'category', 'area', 'plannedDate', 'priority', 'sourceUrl'] as const).some((k) => (draft[k] ?? '') !== (item[k] ?? ''));

  const save = async () => {
    await updateInboxItem(ctx, item, {
      title: draft.title.trim() || item.title,
      memo: draft.memo,
      translatedText: draft.translatedText,
      ...(draft.translatedText !== item.translatedText ? { translationSource: draft.translatedText.trim() ? ('manual' as const) : null } : {}),
      category: draft.category,
      area: draft.area,
      plannedDate: draft.plannedDate || null,
      priority: draft.priority,
      sourceUrl: draft.sourceUrl.trim(),
    });
    toast('保存しました');
  };

  const convert = async () => {
    setBusy(true);
    try {
      if (dirty) await save();
      const fresh = (await db.inboxItems.get(item.id)) ?? item;
      const base = { kind, category: draft.category, area: draft.area, plannedDate: draft.plannedDate || null, priority: draft.priority, memo: draft.memo };
      const targets = splitMode
        ? lines.filter((l) => l.on && l.text.trim()).map((l) => ({ ...base, title: l.text.trim().slice(0, 120), memo: '' }))
        : [{ ...base, title: draft.title.trim() || item.title }];
      if (targets.length === 0) return toast('登録する行を選んでください');
      const made = await convertInbox(ctx, fresh, targets, today);
      toast(`${TARGET_LABEL[kind]}に ${made.length} 件を登録しました。元の情報は整理済みとして残します`);
      setSplitMode(false);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!confirm('この情報を削除します。変換して作ったリストの項目は残ります。よろしいですか？')) return;
    await deleteInboxItems(ctx, [item.id]);
    toast('削除しました');
    navigate('inbox', { replace: true });
  };

  return (
    <div className="screen">
      <header className="diary-head">
        <button className="btn ghost" onClick={() => navigate('inbox')}>← 未整理ボックス</button>
        <strong>{item.status === 'pending' ? '未整理' : item.status === 'processed' ? '整理済み' : 'アーカイブ'}</strong>
        <span />
      </header>
      <p className="muted small">
        <span className="badge">{INBOX_SOURCE_LABEL[item.sourceType]}</span> {todayIn(trip.timeZone, new Date(item.createdAt))} {timeIn(trip.timeZone, item.createdAt)} に取り込み
        {item.sourceTitle && `　共有元：${item.sourceTitle}`}
      </p>

      <Field label="タイトル">
        <input value={draft.title} onChange={(e) => set({ title: e.target.value })} />
      </Field>

      {item.sourceText && (
        <section className="card source-text">
          <div className="card-head">
            <h2>原文</h2>
            <button className="btn small ghost" onClick={() => void navigator.clipboard.writeText(item.sourceText).then(() => toast('コピーしました'), () => toast('コピーできませんでした', { kind: 'error' }))}>
              コピー
            </button>
          </div>
          <p className="pre">{item.sourceText}</p>
        </section>
      )}
      <Field label="元の URL">
        <input type="url" value={draft.sourceUrl} onChange={(e) => set({ sourceUrl: e.target.value })} />
      </Field>
      {safeHttpUrl(item.sourceUrl) && (
        <a className="link small" href={safeHttpUrl(item.sourceUrl)!} target="_blank" rel="noopener noreferrer">
          元のページを開く
        </a>
      )}

      <Field label="日本語訳">
        <textarea rows={2} value={draft.translatedText} onChange={(e) => set({ translatedText: e.target.value })} />
      </Field>
      {needsTranslation(item) && (
        <div className="actions">
          <span className="muted small">
            {tr?.state === 'waiting'
              ? '翻訳待ち（家の PC）'
              : tr?.state === 'translating'
                ? '翻訳中…'
                : tr?.state === 'failed'
                  ? `翻訳失敗：${tr.job?.error ?? ''}`
                  : item.translationSource === 'manual'
                    ? '手動修正済み'
                    : item.translationSource === 'pc'
                      ? `翻訳済み（家の PC：${tr?.job?.provider ?? ''}）`
                      : '未翻訳'}
          </span>
          <button
            className="btn small"
            disabled={tr?.state === 'waiting' || tr?.state === 'translating'}
            onClick={async () => {
              if (item.translationSource === 'manual' && !confirm('手で入れた日本語訳があります。家の PC の訳で置き換えますか？')) return;
              if (item.translationSource === 'manual') await updateInboxItem(ctx, item, { translationSource: null });
              await requestInboxTranslation(db, item);
              window.dispatchEvent(new Event('itl-inbox-translate'));
              toast('家の PC に訳を頼みました（翻訳待ち）');
            }}
          >
            {item.translationSource ? '↻ 家の PC で訳し直す' : '家の PC で訳す'}
          </button>
        </div>
      )}
      {item.sourceText && (
        <a className="link small" href={googleTranslateUrl(item.sourceText.slice(0, 1500), 'auto', 'ja')} target="_blank" rel="noreferrer">
          Google 翻訳で開く
        </a>
      )}
      <Field label="メモ">
        <textarea rows={2} value={draft.memo} onChange={(e) => set({ memo: e.target.value })} />
      </Field>

      <section className="card">
        <div className="card-head">
          <h2>画像</h2>
          <PhotoButton date={today} linkTo={{ type: 'inboxItem', id: item.id }} label="＋ 画像" className="btn small" />
        </div>
        {media.length ? (
          <div className="thumbs">
            {media.map((m) => (
              <Thumb key={m.id} blobId={m.blobId} thumbId={m.thumbnailBlobId} alt={m.caption || '画像'} onClick={() => setMediaSheet(m)} />
            ))}
          </div>
        ) : (
          <p className="muted small">なし</p>
        )}
      </section>

      <section className="card">
        <h2>リストに登録する</h2>
        <div className="chips">
          {KINDS.map((k) => (
            <button key={k} className={'chip' + (kind === k ? ' on' : '')} onClick={() => setKind(k)}>
              {TARGET_LABEL[k]}
            </button>
          ))}
        </div>
        {kind !== 'idea' && (
          <>
            <Field label="カテゴリ">
              <input value={draft.category} list="ib-cats" onChange={(e) => set({ category: e.target.value })} />
              <datalist id="ib-cats">
                {categoriesFor(kind).map((c) => (
                  <option key={c} value={c} />
                ))}
              </datalist>
            </Field>
            <Field label="場所">
              <input value={draft.area} onChange={(e) => set({ area: e.target.value })} placeholder="エリア・店名" />
            </Field>
            <div className="row2">
              <Field label="予定日">
                <input type="date" value={draft.plannedDate ?? ''} onChange={(e) => set({ plannedDate: e.target.value || null })} />
              </Field>
              <Field label="優先度">
                <select value={draft.priority} onChange={(e) => set({ priority: e.target.value as Priority })}>
                  <option value="high">高</option>
                  <option value="normal">普通</option>
                  <option value="low">低</option>
                </select>
              </Field>
            </div>
          </>
        )}
        <label className="check-line">
          <input
            type="checkbox"
            checked={splitMode}
            onChange={(e) => {
              setSplitMode(e.target.checked);
              if (e.target.checked) setLines(splitEntries(item.sourceText || item.title).map((t) => ({ text: t.split('\n')[0], on: true })));
            }}
          />
          複数の項目に分けて登録する
        </label>
        {splitMode && (
          <ul className="split-lines">
            {lines.map((l, i) => (
              <li key={i}>
                <input type="checkbox" checked={l.on} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)))} />
                <input value={l.text} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
              </li>
            ))}
            <li>
              <button className="btn small ghost" onClick={() => setLines([...lines, { text: '', on: true }])}>＋ 行を足す</button>
            </li>
          </ul>
        )}
        <button className="btn primary" disabled={busy} onClick={() => void convert()}>
          {splitMode ? `${lines.filter((l) => l.on && l.text.trim()).length} 件を` : ''}
          {TARGET_LABEL[kind]}に登録
        </button>
        {converted.length > 0 && (
          <div className="converted">
            <p className="muted small">登録した先：</p>
            <ul className="list">
              {converted.map((c) => (
                <li key={c.id}>
                  <button className="row-btn" onClick={() => navigate(c.type === 'checklistItem' ? `item/${c.id}` : 'history')}>
                    <span className="muted small">{TARGET_LABEL[c.kind]}</span>
                    <span>{c.label}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <div className="actions">
        {dirty && <button className="btn primary" onClick={() => void save()}>変更を保存</button>}
        {item.status !== 'processed' && <button className="btn ghost" onClick={() => void setInboxStatus(ctx, [item.id], 'processed')}>整理済みにする</button>}
        {item.status !== 'pending' && <button className="btn ghost" onClick={() => void setInboxStatus(ctx, [item.id], 'pending')}>未整理に戻す</button>}
        {item.status !== 'archived' && <button className="btn ghost" onClick={() => void setInboxStatus(ctx, [item.id], 'archived')}>アーカイブ</button>}
        <button className="btn danger" onClick={() => void remove()}>削除</button>
      </div>
      {mediaSheet && <MediaSheet media={mediaSheet} onClose={() => setMediaSheet(null)} />}
    </div>
  );
}
