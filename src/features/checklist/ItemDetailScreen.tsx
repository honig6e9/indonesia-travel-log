import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { navigate } from '../../app/router';
import { Empty, Field, Sheet, Stars, Thumb, VisibilitySelect, numOrNull } from '../../components/ui';
import { alive } from '../../db/repo';
import type { ChecklistItem, Currency, FoodExperience, Media, Priority } from '../../db/types';
import { formatMoney } from '../../lib/format';
import { MediaSheet } from '../media/MediaSheet';
import { PhotoButton } from '../media/PhotoButton';
import {
  blankExperience,
  deleteExperience,
  deleteItem,
  FOOD_CATEGORIES,
  listExperiences,
  saveExperience,
  saveItem,
  setItemStatus,
  TASK_CATEGORIES,
} from './checklistRepo';

export function ItemDetailScreen(props: { id: string }) {
  const { db, ctx, date, toast } = useApp();
  const item = useLiveQuery(async () => (await db.checklistItems.get(props.id)) ?? null, [db, props.id]);
  const exps = useLiveQuery(() => listExperiences(db, props.id), [db, props.id]) ?? [];
  const photos = useLiveQuery(async () => {
    const links = alive(await db.links.where('targetId').equals(props.id).toArray()).filter((l) => l.sourceType === 'media');
    return alive((await db.media.bulkGet(links.map((l) => l.sourceId))).filter((m): m is Media => !!m));
  }, [db, props.id]) ?? [];
  const [draft, setDraft] = useState<ChecklistItem | null>(null);
  const [expSheet, setExpSheet] = useState<FoodExperience | null>(null);
  const [mediaSheet, setMediaSheet] = useState<Media | null>(null);

  // 保存済みの版が変わったら取り込む。編集中の欄は残し、状態（チェック）だけ最新にする
  const prevItem = useRef<ChecklistItem | null>(null);
  useEffect(() => {
    if (!item) return;
    setDraft((d) => {
      const prev = prevItem.current;
      const edited = d && prev && d.id === item.id && JSON.stringify(d) !== JSON.stringify(prev);
      prevItem.current = item;
      return edited ? { ...d, status: item.status, completedDate: item.completedDate, updatedAt: item.updatedAt } : item;
    });
  }, [item]);

  if (item === null) return <div className="screen"><Empty>項目が見つかりません（削除された可能性があります）。</Empty><button className="btn" onClick={() => history.back()}>戻る</button></div>;
  if (!item || !draft) return <div className="screen">読み込み中…</div>;
  if (item.deletedAt) return <div className="screen"><Empty>この項目は削除されています。</Empty></div>;
  const isFood = item.type === 'food';
  const dirty = JSON.stringify(draft) !== JSON.stringify(item);
  const set = (patch: Partial<ChecklistItem>) => setDraft({ ...draft, ...patch });

  const save = async () => {
    await saveItem(ctx, draft);
    toast('保存しました');
  };

  return (
    <div className="screen">
      <header className="diary-head">
        <button className="btn ghost" onClick={() => navigate(`lists/${item.type}`)}>← リスト</button>
        <strong>{isFood ? '食べたいもの' : 'やること'}</strong>
        <span />
      </header>

      <div className="segmented">
        {(['open', 'done', 'skipped'] as const).map((s) => (
          <button
            key={s}
            className={item.status === s ? 'on' : ''}
            onClick={async () => {
              if (s === item.status) return;
              await setItemStatus(ctx, item, s, date);
              toast(s === 'done' ? `${date} に記録しました` : s === 'open' && isFood ? '状態を戻しました（実食の記録は残っています）' : '状態を変更しました');
            }}
          >
            {s === 'open' ? (isFood ? '未体験' : '未完了') : s === 'done' ? (isFood ? '食べた' : '完了') : '見送り'}
          </button>
        ))}
      </div>

      <Field label={isFood ? '料理名・飲料名' : 'タイトル'}>
        <input value={draft.title} onChange={(e) => set({ title: e.target.value })} />
      </Field>
      {isFood && (
        <Field label="現地表記">
          <input value={draft.localName ?? ''} onChange={(e) => set({ localName: e.target.value || null })} placeholder="例：Rendang" />
        </Field>
      )}
      <div className="row">
        <Field label="分類">
          <select value={draft.category} onChange={(e) => set({ category: e.target.value })}>
            {(isFood ? FOOD_CATEGORIES : TASK_CATEGORIES).map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label="優先度">
          <select value={draft.priority} onChange={(e) => set({ priority: e.target.value as Priority })}>
            <option value="high">高</option>
            <option value="normal">普通</option>
            <option value="low">低</option>
          </select>
        </Field>
      </div>
      <Field label={isFood ? '行きたい店・地域' : 'エリア・店名'}>
        <input value={draft.area} onChange={(e) => set({ area: e.target.value })} />
      </Field>
      <div className="row">
        <Field label="予定日">
          <input type="date" value={draft.plannedDate ?? ''} onChange={(e) => set({ plannedDate: e.target.value || null })} />
        </Field>
        <Field label={isFood ? '食べた日' : '完了日'}>
          <input type="date" value={draft.completedDate ?? ''} disabled={item.status !== 'done'} onChange={(e) => set({ completedDate: e.target.value || null })} />
        </Field>
      </div>
      {isFood && (
        <Field label="目安予算（IDR）">
          <input inputMode="numeric" value={draft.targetPrice ?? ''} onChange={(e) => set({ targetPrice: numOrNull(e.target.value) })} />
        </Field>
      )}
      <Field label={isFood ? 'メモ' : '体験メモ'}>
        <textarea rows={3} value={draft.note} onChange={(e) => set({ note: e.target.value })} />
      </Field>
      <VisibilitySelect value={draft.visibility} onChange={(visibility) => set({ visibility })} />
      <div className="actions">
        <button className="btn primary" disabled={!dirty} onClick={() => void save()}>
          {dirty ? '変更を保存' : '保存済み'}
        </button>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>写真</h2>
          <PhotoButton date={item.completedDate ?? date} linkTo={{ type: 'checklistItem', id: item.id }} className="btn small" label="＋写真" />
        </div>
        {photos.length ? (
          <div className="thumbs">
            {photos.map((m) => (
              <Thumb key={m.id} blobId={m.blobId} thumbId={m.thumbnailBlobId} alt={m.caption || '写真'} onClick={() => setMediaSheet(m)} />
            ))}
          </div>
        ) : (
          <p className="muted small">この項目に紐づく写真はまだありません。</p>
        )}
      </section>

      {isFood && (
        <section className="card">
          <div className="card-head">
            <h2>実食記録（{exps.length}回）</h2>
            <button className="btn small" onClick={() => setExpSheet(blankExperience(item, date))}>＋実食を追加</button>
          </div>
          {exps.length === 0 && <p className="muted small">同じ料理を別の店で食べ比べるときは、実食を何回でも追加できます。</p>}
          <ul className="list">
            {exps.map((e) => (
              <li key={e.id}>
                <button className="row-btn" onClick={() => setExpSheet(e)}>
                  <span>
                    {e.localDate} {e.shop || '（店名なし）'} {e.rating ? '★'.repeat(e.rating) : ''}
                    {e.expenseId && <span className="pill">支出あり</span>}
                  </span>
                  <span>{e.price != null ? formatMoney(e.price, e.currency) : ''}</span>
                </button>
              </li>
            ))}
          </ul>
          {item.status !== 'done' && exps.length > 0 && (
            <button className="btn small ghost" onClick={() => void setItemStatus(ctx, item, 'done', exps[exps.length - 1].localDate)}>
              実食の記録から「食べた」に戻す
            </button>
          )}
        </section>
      )}

      <button
        className="btn danger ghost"
        onClick={async () => {
          if (!confirm(`「${item.title}」を削除しますか？`)) return;
          let withExp = false;
          if (exps.length) withExp = confirm(`実食記録が ${exps.length} 件あります。実食記録も削除しますか？\n「キャンセル」で実食記録は残します（支出・写真は消しません）。`);
          await deleteItem(ctx, item, withExp);
          toast('削除しました');
          navigate(`lists/${item.type}`, { replace: true });
        }}
      >
        この項目を削除
      </button>

      {expSheet && <ExperienceSheet item={item} exp={expSheet} onClose={() => setExpSheet(null)} />}
      {mediaSheet && <MediaSheet media={mediaSheet} onClose={() => setMediaSheet(null)} />}
    </div>
  );
}

function ExperienceSheet(props: { item: ChecklistItem; exp: FoodExperience; onClose: () => void }) {
  const { ctx, db, toast } = useApp();
  const [e, setE] = useState(props.exp);
  const [priceText, setPriceText] = useState(e.price != null ? String(e.price) : '');
  const [alsoExpense, setAlsoExpense] = useState(!!e.expenseId);
  const [party, setParty] = useState('');
  const linkedExpense = useLiveQuery(async () => (e.expenseId ? ((await db.expenses.get(e.expenseId)) ?? null) : null), [db, e.expenseId]);
  const isNew = !props.exp.createdAt;
  const update = (patch: Partial<FoodExperience>) => setE({ ...e, ...patch });
  return (
    <Sheet
      title={`実食：${props.item.title}`}
      onClose={props.onClose}
      footer={
        <>
          {!isNew && (
            <button
              className="btn danger ghost"
              onClick={async () => {
                if (!confirm('この実食記録を削除しますか？')) return;
                const withExpense = !!e.expenseId && confirm('紐づく支出も削除しますか？「キャンセル」で支出は残します。');
                await deleteExperience(ctx, props.exp, withExpense);
                props.onClose();
              }}
            >
              削除
            </button>
          )}
          <button
            className="btn primary"
            onClick={async () => {
              const price = numOrNull(priceText);
              if (price != null && (!Number.isInteger(price) || price < 0)) return toast('価格は0以上の整数で入力してください', { kind: 'error' });
              await saveExperience(ctx, props.item, { ...e, price }, alsoExpense && price != null, numOrNull(party));
              toast('実食を保存しました');
              props.onClose();
            }}
          >
            保存
          </button>
        </>
      }
    >
      <Field label="食べた日">
        <input type="date" value={e.localDate} onChange={(x) => x.target.value && update({ localDate: x.target.value })} />
      </Field>
      <Field label="店名">
        <input value={e.shop} onChange={(x) => update({ shop: x.target.value })} />
      </Field>
      <div className="row">
        <Field label="実際の価格">
          <input inputMode="numeric" value={priceText} onChange={(x) => setPriceText(x.target.value)} />
        </Field>
        <Field label="通貨">
          <select value={e.currency} onChange={(x) => update({ currency: x.target.value as Currency })}>
            <option>IDR</option>
            <option>JPY</option>
          </select>
        </Field>
      </div>
      <Field label="評価">
        <Stars value={e.rating} onChange={(rating) => update({ rating })} />
      </Field>
      <Field label="感想">
        <textarea rows={3} value={e.comment} onChange={(x) => update({ comment: x.target.value })} />
      </Field>
      <Field label="再訪したいか">
        <select value={e.revisit == null ? '' : e.revisit ? 'yes' : 'no'} onChange={(x) => update({ revisit: x.target.value === '' ? null : x.target.value === 'yes' })}>
          <option value="">—</option>
          <option value="yes">はい</option>
          <option value="no">いいえ</option>
        </select>
      </Field>
      <label className="check-inline">
        <input type="checkbox" checked={alsoExpense} onChange={(x) => setAlsoExpense(x.target.checked)} />
        {e.expenseId ? '紐づく支出も更新する' : '支出にも登録'}
      </label>
      {alsoExpense && (
        <Field label="人数（任意）" hint="価格は総支払額として登録します。自分の負担額は支出の画面で入力できます">
          <input inputMode="numeric" value={party} onChange={(x) => setParty(x.target.value)} placeholder={linkedExpense?.partySize ? String(linkedExpense.partySize) : ''} />
        </Field>
      )}
      {linkedExpense && <p className="muted small">紐づく支出：{formatMoney(linkedExpense.amount, linkedExpense.currency)}（二重には登録しません）</p>}
      <VisibilitySelect value={e.visibility} onChange={(visibility) => update({ visibility })} />
    </Sheet>
  );
}
