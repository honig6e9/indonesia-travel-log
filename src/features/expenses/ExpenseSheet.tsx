import { useState } from 'react';
import { useApp } from '../../app/context';
import { Field, Sheet, numOrNull, useDraft } from '../../components/ui';
import { LocationField } from '../../components/LocationField';
import type { Currency, Expense } from '../../db/types';
import { blankExpense, deleteExpense, EXPENSE_CATEGORIES, PAYMENT_METHODS, saveExpense, validateExpense } from './expenseRepo';

export function ExpenseSheet(props: { expense?: Expense; date: string; onClose: () => void }) {
  const { ctx, trip, toast } = useApp();
  const [e, setE, clearDraft, restored] = useDraft<Expense>(
    `expense:${props.expense?.id ?? 'new:' + props.date}`,
    props.expense ?? blankExpense(trip.id, props.date),
  );
  const [amountText, setAmountText] = useState(e.amount ? String(e.amount) : '');
  const [personalText, setPersonalText] = useState(e.personalAmount != null ? String(e.personalAmount) : '');
  const update = (patch: Partial<Expense>) => setE({ ...e, ...patch });

  const save = async () => {
    const next: Expense = { ...e, amount: numOrNull(amountText) ?? -1, personalAmount: numOrNull(personalText) };
    const err = validateExpense(next);
    if (err) return toast(err, { kind: 'error' });
    try {
      await saveExpense(ctx, next);
      clearDraft();
      toast('支出を端末に保存しました');
      props.onClose();
    } catch (x) {
      toast('保存できませんでした：' + (x as Error).message, { kind: 'error' });
    }
  };

  return (
    <Sheet
      title={props.expense ? '支出を編集' : `支出（${e.localDate}）`}
      onClose={props.onClose}
      footer={
        <>
          {props.expense && (
            <button
              className="btn danger ghost"
              onClick={async () => {
                if (!confirm('この支出を削除しますか？（実食の記録は残ります）')) return;
                await deleteExpense(ctx, props.expense!.id);
                clearDraft();
                props.onClose();
              }}
            >
              削除
            </button>
          )}
          <button className="btn primary" onClick={save}>
            保存
          </button>
        </>
      }
    >
      {restored && <p className="notice">前回の入力途中の内容を復元しました。</p>}
      <div className="row">
        <Field label="種別">
          <select value={e.kind} onChange={(x) => update({ kind: x.target.value as Expense['kind'] })}>
            <option value="expense">支出</option>
            <option value="refund">返金</option>
          </select>
        </Field>
        <Field label="通貨">
          <select value={e.currency} onChange={(x) => update({ currency: x.target.value as Currency })}>
            <option value="IDR">IDR</option>
            <option value="JPY">JPY</option>
          </select>
        </Field>
      </div>
      <Field label="金額（総支払額・整数）">
        <input inputMode="numeric" autoFocus value={amountText} onChange={(x) => setAmountText(x.target.value)} placeholder="例：35000" />
      </Field>
      <div className="row">
        <Field label="人数（任意）">
          <input inputMode="numeric" value={e.partySize ?? ''} onChange={(x) => update({ partySize: numOrNull(x.target.value) })} />
        </Field>
        <Field label="自分の負担額（任意）">
          <input inputMode="numeric" value={personalText} onChange={(x) => setPersonalText(x.target.value)} />
        </Field>
      </div>
      <Field label="カテゴリ">
        <div className="chips">
          {EXPENSE_CATEGORIES.map((c) => (
            <button key={c} type="button" className={'chip' + (e.category === c ? ' on' : '')} onClick={() => update({ category: c })}>
              {c}
            </button>
          ))}
        </div>
      </Field>
      <Field label="店名">
        <input value={e.shop} onChange={(x) => update({ shop: x.target.value })} />
      </Field>
      <LocationField label="場所（任意）" value={e.location} onChange={(location) => update({ location })} />
      <Field label="支払方法">
        <select value={e.paymentMethod} onChange={(x) => update({ paymentMethod: x.target.value })}>
          {PAYMENT_METHODS.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </Field>
      <Field label="メモ">
        <input value={e.note} onChange={(x) => update({ note: x.target.value })} />
      </Field>
      <Field label="記録対象日">
        <input type="date" value={e.localDate} onChange={(x) => x.target.value && update({ localDate: x.target.value })} />
      </Field>
      {trip.jpyPerIdr && e.currency === 'IDR' && numOrNull(amountText) != null && (
        <p className="muted small">
          参考：約 {Math.round((numOrNull(amountText) ?? 0) * trip.jpyPerIdr).toLocaleString()} 円（手動レート {trip.jpyPerIdr} 円/IDR・{trip.rateDate ?? '日付未記録'}）
        </p>
      )}
    </Sheet>
  );
}
