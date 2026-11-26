import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { navigate } from '../../app/router';
import { Empty } from '../../components/ui';
import { INBOX_SOURCE_LABEL, type InboxItem, type InboxSource, type InboxStatus } from '../../db/types';
import { shortDate, timeIn, todayIn } from '../../lib/dates';
import { convertInbox, deleteInboxItems, listInbox, setInboxStatus, TARGET_LABEL, type TargetKind } from './inboxRepo';
import { listShares, type PendingShare } from './shareStore';

const STATUS_LABEL: Record<InboxStatus, string> = { pending: '未整理', processed: '整理済み', archived: 'アーカイブ' };

/** 受け取ったまま登録していない共有（ログイン前などに受け取ったもの） */
export function usePendingShares(): PendingShare[] {
  const [shares, setShares] = useState<PendingShare[]>([]);
  useEffect(() => {
    const load = () => void listShares().then(setShares).catch(() => setShares([]));
    load();
    window.addEventListener('itl-shares-changed', load);
    window.addEventListener('focus', load);
    return () => {
      window.removeEventListener('itl-shares-changed', load);
      window.removeEventListener('focus', load);
    };
  }, []);
  return shares;
}

export function InboxScreen() {
  const { db, ctx, trip, today, toast } = useApp();
  const itemsQ = useLiveQuery(() => listInbox(db, trip.id), [db, trip.id]);
  const items = useMemo(() => itemsQ ?? [], [itemsQ]);
  const shares = usePendingShares();
  const [status, setStatus] = useState<InboxStatus>('pending');
  const [order, setOrder] = useState<'new' | 'old'>('new');
  const [src, setSrc] = useState<InboxSource | ''>('');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const counts = useMemo(() => {
    const c: Record<InboxStatus, number> = { pending: 0, processed: 0, archived: 0 };
    for (const i of items) c[i.status]++;
    return c;
  }, [items]);
  const sources = useMemo(() => [...new Set(items.map((i) => i.sourceType))], [items]);
  const ql = q.trim().toLowerCase();
  const shown = items
    .filter((i) => i.status === status && (!src || i.sourceType === src))
    .filter((i) => !ql || [i.title, i.sourceText, i.sourceUrl, i.translatedText, i.memo, i.sourceTitle, i.area].some((s) => s?.toLowerCase().includes(ql)))
    .sort((a, b) => (order === 'new' ? b.createdAt.localeCompare(a.createdAt) : a.createdAt.localeCompare(b.createdAt)));
  const sel = shown.filter((i) => selected.has(i.id));

  const toggle = (id: string) =>
    setSelected((cur) => {
      const n = new Set(cur);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const bulkConvert = async (kind: TargetKind) => {
    setBusy(true);
    try {
      let n = 0;
      for (const it of sel)
        n += (await convertInbox(ctx, it, [{ kind, title: it.title, category: it.category, area: it.area, plannedDate: it.plannedDate, priority: it.priority, memo: it.memo }], today)).length;
      toast(`${TARGET_LABEL[kind]}に ${n} 件を登録しました（元の情報は整理済みに残します）`);
      setSelected(new Set());
    } finally {
      setBusy(false);
    }
  };

  const bulkStatus = async (s: InboxStatus) => {
    await setInboxStatus(ctx, sel.map((i) => i.id), s);
    toast(`${sel.length} 件を${STATUS_LABEL[s]}にしました`);
    setSelected(new Set());
  };

  const bulkDelete = async () => {
    if (!confirm(`${sel.length} 件を削除します。変換して作ったリストの項目は残ります。よろしいですか？`)) return;
    const ids = sel.map((i) => i.id);
    await deleteInboxItems(ctx, ids);
    toast(`${ids.length} 件を削除しました`);
    setSelected(new Set());
  };

  return (
    <div className="screen">
      <div className="screen-head">
        <h1>📥 未整理ボックス</h1>
      </div>
      <div className="actions">
        <button className="btn primary" onClick={() => navigate('inbox/new?paste=1')}>📋 貼り付けて取り込む</button>
        <button className="btn" onClick={() => navigate('inbox/new')}>＋ 入力して取り込む</button>
      </div>
      <p className="muted small">X・Instagram・Google マップ・ブラウザなどの「共有」から、このアプリ（旅ログ）を選んでも取り込めます。</p>

      {shares.length > 0 && (
        <div className="dup-warn">
          受け取ったまま登録していない共有が {shares.length} 件あります。
          {shares.map((s) => (
            <button key={s.id} className="link" onClick={() => navigate(`share?id=${s.id}`)}>
              {(s.title || s.text || s.url || '画像').slice(0, 30)}
            </button>
          ))}
        </div>
      )}

      <div className="segmented" role="tablist">
        {(['pending', 'processed', 'archived'] as InboxStatus[]).map((s) => (
          <button
            key={s}
            role="tab"
            aria-selected={status === s}
            className={status === s ? 'on' : ''}
            onClick={() => {
              setStatus(s);
              setSelected(new Set());
            }}
          >
            {STATUS_LABEL[s]} {counts[s]}
          </button>
        ))}
      </div>

      <div className="filter-row">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="キーワードで探す" aria-label="キーワード" />
        <select value={src} onChange={(e) => setSrc(e.target.value as InboxSource | '')} aria-label="登録元">
          <option value="">登録元：すべて</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {INBOX_SOURCE_LABEL[s]}
            </option>
          ))}
        </select>
        <select value={order} onChange={(e) => setOrder(e.target.value as 'new' | 'old')} aria-label="並び順">
          <option value="new">新しい順</option>
          <option value="old">古い順</option>
        </select>
      </div>

      {shown.length > 0 && (
        <label className="check-line">
          <input
            type="checkbox"
            checked={sel.length === shown.length}
            onChange={(e) => setSelected(e.target.checked ? new Set(shown.map((i) => i.id)) : new Set())}
          />
          すべて選ぶ{sel.length > 0 && `（${sel.length} 件を選択中）`}
        </label>
      )}

      {shown.length === 0 ? (
        <Empty>{status === 'pending' ? '未整理の情報はありません。' : `${STATUS_LABEL[status]}の情報はありません。`}</Empty>
      ) : (
        <ul className="inbox-list">
          {shown.map((i) => (
            <InboxRow key={i.id} item={i} checked={selected.has(i.id)} onCheck={() => toggle(i.id)} timeZone={trip.timeZone} />
          ))}
        </ul>
      )}

      {sel.length > 0 && (
        <div className="bulk-bar">
          <span className="muted small">{sel.length} 件を</span>
          {(['task', 'food', 'place', 'idea'] as TargetKind[]).map((k) => (
            <button key={k} className="btn small" disabled={busy} onClick={() => void bulkConvert(k)}>
              {TARGET_LABEL[k]}へ
            </button>
          ))}
          {status !== 'processed' && <button className="btn small ghost" onClick={() => void bulkStatus('processed')}>整理済みに</button>}
          {status !== 'pending' && <button className="btn small ghost" onClick={() => void bulkStatus('pending')}>未整理に戻す</button>}
          {status !== 'archived' && <button className="btn small ghost" onClick={() => void bulkStatus('archived')}>アーカイブ</button>}
          <button className="btn small danger" onClick={() => void bulkDelete()}>削除</button>
        </div>
      )}
    </div>
  );
}

function InboxRow(props: { item: InboxItem; checked: boolean; onCheck: () => void; timeZone: string }) {
  const i = props.item;
  const snippet = i.sourceText && i.sourceText !== i.title ? i.sourceText : i.sourceUrl;
  return (
    <li className="inbox-row">
      <input type="checkbox" checked={props.checked} onChange={props.onCheck} aria-label={`${i.title} を選ぶ`} />
      <button className="row-btn" onClick={() => navigate(`inbox/${i.id}`)}>
        <span className="muted small">
          <span className="badge">{INBOX_SOURCE_LABEL[i.sourceType]}</span> {shortDate(todayIn(props.timeZone, new Date(i.createdAt)))} {timeIn(props.timeZone, i.createdAt)}
        </span>
        <span>{i.title}</span>
        {snippet && <span className="muted small clamp">{snippet}</span>}
      </button>
    </li>
  );
}
