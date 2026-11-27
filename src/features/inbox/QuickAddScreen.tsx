import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../app/context';
import { navigate } from '../../app/router';
import { Field } from '../../components/ui';
import { getSetting } from '../../db/db';
import type { InboxSource, Priority } from '../../db/types';
import { newId } from '../../lib/ids';
import { categoriesFor } from '../checklist/checklistRepo';
import { googleTranslateUrl } from '../interpret/interpretRepo';
import { addPhoto } from '../media/mediaRepo';
import {
  buildInboxItem,
  convertInbox,
  extractUrl,
  findDuplicates,
  inboxIdFromShare,
  normalizeUrl,
  saveInboxItem,
  splitEntries,
  TARGET_LABEL,
  textHashOf,
  type Duplicate,
  type TargetKind,
} from './inboxRepo';
import { deleteShare, getShare, type PendingShare } from './shareStore';
import { requestInboxTranslation } from './inboxTranslate';

type Dest = 'inbox' | TargetKind;
const DESTS: Dest[] = ['inbox', 'task', 'food', 'place', 'idea'];

/**
 * クイック登録。共有メニュー（?id=受信ID）、クリップボード、手入力のどれからでも開く。
 * 「とりあえず保存」で未整理ボックスへ即保存。「編集して登録」で登録先と項目を選んで登録する。
 */
export function QuickAddScreen(props: { shareId: string | null; shareError?: boolean; paste?: boolean }) {
  const { ctx, db, trip, today, toast } = useApp();
  const [share, setShare] = useState<PendingShare | null>(null);
  const [loading, setLoading] = useState(!!props.shareId);
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [sourceTitle, setSourceTitle] = useState('');
  const [source, setSource] = useState<InboxSource>('manual');
  const [files, setFiles] = useState<File[]>([]);
  const [editing, setEditing] = useState(false);
  const [dest, setDest] = useState<Dest>('inbox');
  const [title, setTitle] = useState('');
  const [category, setCategory] = useState('');
  const [area, setArea] = useState('');
  const [plannedDate, setPlannedDate] = useState('');
  const [priority, setPriority] = useState<Priority>('normal');
  const [translated, setTranslated] = useState('');
  const [memo, setMemo] = useState('');
  const [split, setSplit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dups, setDups] = useState<Duplicate[]>([]);
  // 同じ画面で 2 回押しても 1 件になるよう、ID は開いたときに決める
  const baseId = useMemo(() => (props.shareId ? inboxIdFromShare(props.shareId) : newId()), [props.shareId]);
  const galRef = useRef<HTMLInputElement>(null);
  const pasted = useRef(false);

  useEffect(() => {
    if (!props.shareId) return;
    let alive = true;
    void getShare(props.shareId).then((s) => {
      if (!alive) return;
      setLoading(false);
      if (!s) return;
      setShare(s);
      setText(s.text);
      setUrl(s.url);
      setSourceTitle(s.title);
      setSource(s.files.length && !s.text && !s.url ? 'image' : 'unknown');
      setFiles(s.files.map((f) => new File([f.blob], f.name, { type: f.type })));
    });
    return () => {
      alive = false;
    };
  }, [props.shareId]);

  const pasteClipboard = async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t.trim()) return toast('クリップボードが空です');
      setText((cur) => (cur.trim() ? cur.trimEnd() + '\n' + t : t));
      if (source === 'manual') setSource('clipboard');
    } catch {
      toast('クリップボードを読めませんでした。下の欄を長押しして「貼り付け」を選んでください', { kind: 'error' });
    }
  };

  // 「📋 貼り付けて取り込む」から来たときは、開いてすぐ貼り付ける
  useEffect(() => {
    if (props.paste && !pasted.current) {
      pasted.current = true;
      void pasteClipboard();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.paste]);

  const effectiveUrl = url.trim() || extractUrl(text);
  const entries = split ? splitEntries(text) : [];

  // 重複の警告（保存は止めない）
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      const urlKey = normalizeUrl(effectiveUrl);
      const textHash = await textHashOf(text);
      const d = urlKey || textHash ? await findDuplicates(db, trip.id, { id: baseId, urlKey, textHash }) : [];
      if (alive) setDups(d);
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [db, trip.id, baseId, effectiveUrl, text]);

  const empty = !text.trim() && !url.trim() && files.length === 0 && !title.trim();

  const finish = async (msg: string, go: string) => {
    if (share) await deleteShare(share.id);
    toast(msg);
    navigate(go, { replace: true });
  };

  const saveImages = async (inboxId: string) => {
    if (!files.length) return;
    const compress = await getSetting<boolean>(db, 'compressPhotosForCloud', false);
    for (const f of files) {
      try {
        await addPhoto(ctx, f, { tripId: trip.id, localDate: today, compressForCloud: compress, linkTo: { type: 'inboxItem', id: inboxId } });
      } catch (e) {
        toast((e as Error).name === 'QuotaExceededError' ? '端末の容量が足りず、画像を保存できませんでした' : `画像を保存できませんでした：${f.name}`, { kind: 'error' });
      }
    }
  };

  /** とりあえず保存：未整理ボックスへ */
  const quickSave = async () => {
    if (empty) return toast('保存する内容がありません');
    setBusy(true);
    try {
      if (split && entries.length > 1) {
        for (let i = 0; i < entries.length; i++) {
          const item = await buildInboxItem(trip.id, {
            id: props.shareId ? inboxIdFromShare(`${props.shareId}:${i}`) : i === 0 ? baseId : newId(),
            sourceType: source,
            sourceTitle,
            sourceText: entries[i],
            shareId: share?.id ?? null,
          });
          await saveInboxItem(ctx, item);
          if (i === 0) await saveImages(item.id);
          await requestInboxTranslation(db, item);
        }
        window.dispatchEvent(new Event('itl-inbox-translate'));
        await finish(`未整理ボックスに ${entries.length} 件を保存しました`, 'inbox');
      } else {
        const item = await buildInboxItem(trip.id, {
          id: baseId,
          sourceType: source,
          sourceTitle,
          sourceText: text,
          sourceUrl: url,
          translatedText: translated,
          title,
          memo,
          category,
          area,
          plannedDate: plannedDate || null,
          priority,
          shareId: share?.id ?? null,
        });
        await saveInboxItem(ctx, { ...item, translationSource: item.translatedText ? 'manual' : null });
        await saveImages(item.id);
        // インドネシア語の原文は、訳を手で入れていなければ家の PC に訳を頼む（翻訳待ち）
        if (!item.translatedText && (await requestInboxTranslation(db, item))) window.dispatchEvent(new Event('itl-inbox-translate'));
        await finish('未整理ボックスに保存しました', 'inbox');
      }
    } catch (e) {
      toast(`保存できませんでした：${(e as Error).message}`, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  /** 編集して登録：選んだリストへ。元の情報は未整理ボックスに「整理済み」として残す */
  const register = async () => {
    if (dest === 'inbox') return quickSave();
    if (empty) return toast('登録する内容がありません');
    setBusy(true);
    try {
      const item = await buildInboxItem(trip.id, {
        id: baseId,
        sourceType: source,
        sourceTitle,
        sourceText: text,
        sourceUrl: url,
        translatedText: translated,
        title,
        memo,
        category,
        area,
        plannedDate: plannedDate || null,
        priority,
        shareId: share?.id ?? null,
      });
      await saveInboxItem(ctx, item);
      await saveImages(item.id);
      const titles = split && entries.length > 1 ? entries.map((e) => e.split('\n')[0].slice(0, 120)) : [item.title];
      const made = await convertInbox(
        ctx,
        item,
        titles.map((t) => ({ kind: dest, title: t, category, area, plannedDate: plannedDate || null, priority, memo })),
        today,
      );
      const go = dest === 'idea' ? 'inbox' : `lists/${dest}`;
      await finish(`${TARGET_LABEL[dest]}に ${made.length} 件を登録しました`, go);
    } catch (e) {
      toast(`登録できませんでした：${(e as Error).message}`, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <div className="screen"><p className="muted">受け取った内容を読み込んでいます…</p></div>;

  return (
    <div className="screen quick-add">
      <div className="screen-head">
        <button className="btn small ghost" onClick={() => navigate('inbox')}>← 未整理ボックス</button>
        <h1>{share ? '共有から登録' : '情報を取り込む'}</h1>
      </div>
      {props.shareError && <p className="error-text">共有された内容を受け取れませんでした。もう一度共有するか、コピーして貼り付けてください。</p>}
      {props.shareId && !share && !props.shareError && <p className="muted">この共有はもう登録済みです。</p>}

      <div className="actions">
        <button className="btn small" onClick={() => void pasteClipboard()}>📋 クリップボードから貼り付け</button>
        <button className="btn small ghost" onClick={() => galRef.current?.click()}>🖼 画像を添付</button>
        <input
          ref={galRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const fs = Array.from(e.target.files ?? []);
            e.target.value = '';
            if (fs.length) setFiles((cur) => [...cur, ...fs].slice(0, 10));
            if (fs.length && !text.trim() && !url.trim() && source === 'manual') setSource('image');
          }}
        />
      </div>

      <Field label="原文（共有・コピーした文章）" hint="キーボードのマイクで話して入力することもできます">
        <textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="例：Jangan pedas, ya." />
      </Field>
      <Field label="元の URL">
        <input type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder={extractUrl(text) || 'https://'} />
      </Field>
      {sourceTitle && <p className="muted small">共有元のタイトル：{sourceTitle}</p>}
      {files.length > 0 && (
        <ul className="file-list">
          {files.map((f, i) => (
            <li key={i}>
              <FilePreview file={f} />
              <button className="link" onClick={() => setFiles((cur) => cur.filter((_, j) => j !== i))}>外す</button>
            </li>
          ))}
        </ul>
      )}
      <label className="check-line">
        <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
        複数の項目として登録する（空行、空行がなければ 1 行ずつ）{split && entries.length > 0 && `：${entries.length} 件`}
      </label>

      {dups.length > 0 && (
        <div className="dup-warn">
          ⚠ 同じ{dups[0].reason === 'url' ? ' URL' : '文章'}がすでにあります：
          {dups.slice(0, 3).map((d) => (
            <button key={d.item.id} className="link" onClick={() => navigate(`inbox/${d.item.id}`)}>
              「{d.item.title}」
            </button>
          ))}
          <span className="muted small">（別の目的なら、そのまま保存できます）</span>
        </div>
      )}

      {!editing ? (
        <div className="quick-actions">
          <button className="btn primary big" disabled={busy || empty} onClick={() => void quickSave()}>
            {busy ? '保存中…' : 'とりあえず保存'}
          </button>
          <button className="btn big" disabled={busy} onClick={() => setEditing(true)}>編集して登録</button>
        </div>
      ) : (
        <section className="card">
          <Field label="登録先">
            <div className="chips">
              {DESTS.map((d) => (
                <button key={d} className={'chip' + (dest === d ? ' on' : '')} onClick={() => setDest(d)}>
                  {TARGET_LABEL[d]}
                </button>
              ))}
            </div>
          </Field>
          {!(split && entries.length > 1) && (
            <Field label="タイトル" hint="空なら原文の先頭から作ります">
              <input value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
          )}
          {dest !== 'idea' && (
            <>
              <Field label="カテゴリ">
                <input value={category} list="qa-cats" onChange={(e) => setCategory(e.target.value)} />
                <datalist id="qa-cats">
                  {categoriesFor(dest === 'inbox' ? 'task' : dest).map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </Field>
              <Field label="場所">
                <input value={area} onChange={(e) => setArea(e.target.value)} placeholder="エリア・店名" />
              </Field>
              <div className="row2">
                <Field label="予定日">
                  <input type="date" value={plannedDate} onChange={(e) => setPlannedDate(e.target.value)} />
                </Field>
                <Field label="優先度">
                  <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
                    <option value="high">高</option>
                    <option value="normal">普通</option>
                    <option value="low">低</option>
                  </select>
                </Field>
              </div>
            </>
          )}
          <Field label="日本語訳">
            <textarea rows={2} value={translated} onChange={(e) => setTranslated(e.target.value)} />
          </Field>
          {text.trim() && (
            <a className="link small" href={googleTranslateUrl(text.slice(0, 1500), 'auto', 'ja')} target="_blank" rel="noreferrer">
              Google 翻訳で開く（訳をコピーして上に貼ります）
            </a>
          )}
          <Field label="メモ">
            <textarea rows={2} value={memo} onChange={(e) => setMemo(e.target.value)} />
          </Field>
          <div className="quick-actions">
            <button className="btn primary big" disabled={busy || empty} onClick={() => void register()}>
              {busy ? '登録中…' : `${TARGET_LABEL[dest]}に登録`}
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => setEditing(false)}>閉じる</button>
          </div>
        </section>
      )}
    </div>
  );
}

function FilePreview(props: { file: File }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    const u = URL.createObjectURL(props.file);
    setSrc(u);
    return () => URL.revokeObjectURL(u);
  }, [props.file]);
  return src ? <img src={src} alt={props.file.name} className="file-thumb" /> : null;
}
