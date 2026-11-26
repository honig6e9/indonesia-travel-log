import type { TravelDB } from '../../db/db';
import { alive, transact, type Ctx } from '../../db/repo';
import type { Currency, Expense, Trip } from '../../db/types';
import { newId } from '../../lib/ids';

export const EXPENSE_CATEGORIES = ['食事', '交通', '宿泊', '買い物', '通信', '観光', '生活', 'その他'];
export const PAYMENT_METHODS = ['現金', 'カード', 'QRIS', '電子マネー', 'その他'];

export function blankExpense(tripId: string, localDate: string): Expense {
  return {
    id: newId(),
    tripId,
    localDate,
    amount: 0,
    currency: 'IDR',
    personalAmount: null,
    category: '食事',
    shop: '',
    partySize: null,
    paymentMethod: '現金',
    note: '',
    kind: 'expense',
    receiptMediaId: null,
    createdAt: '',
    updatedAt: '',
  };
}

export function validateExpense(e: Expense): string | null {
  if (!Number.isInteger(e.amount) || e.amount < 0) return '金額は0以上の整数で入力してください';
  if (e.personalAmount != null && (!Number.isInteger(e.personalAmount) || e.personalAmount < 0))
    return '自分の負担額は0以上の整数で入力してください';
  if (e.partySize != null && (!Number.isInteger(e.partySize) || e.partySize < 1))
    return '人数は1以上の整数で入力してください';
  return null;
}

export async function saveExpense(ctx: Ctx, e: Expense) {
  const err = validateExpense(e);
  if (err) throw new Error(err);
  await transact(ctx, (w) => w.put('expense', e));
}

export async function deleteExpense(ctx: Ctx, id: string) {
  await transact(ctx, async (w) => {
    await w.remove('expense', id);
    // 実食からの参照は外す（実食そのものは消さない）
    for (const exp of alive(await ctx.db.foodExperiences.where('expenseId').equals(id).toArray()))
      await w.put('foodExperience', { ...exp, expenseId: null });
  });
}

export async function expensesOn(db: TravelDB, tripId: string, localDate: string) {
  return alive(await db.expenses.where('[tripId+localDate]').equals([tripId, localDate]).toArray());
}

export interface CurrencyTotal {
  currency: Currency;
  total: number; // 支払総額（返金を差し引く）
  personal: number; // 自分の負担（未入力は総額で数える）
  count: number;
}

/** 通貨別に集計する。異なる通貨は合算しない */
export function totalsByCurrency(expenses: Expense[]): CurrencyTotal[] {
  const map = new Map<Currency, CurrencyTotal>();
  for (const e of expenses) {
    if (e.deletedAt) continue;
    const t = map.get(e.currency) ?? { currency: e.currency, total: 0, personal: 0, count: 0 };
    const sign = e.kind === 'refund' ? -1 : 1;
    t.total += sign * e.amount;
    t.personal += sign * (e.personalAmount ?? e.amount);
    t.count += 1;
    map.set(e.currency, t);
  }
  return [...map.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** 手動レートが記録されているときだけ、IDR を円に換算して返す */
export function convertIdr(trip: Trip, idr: number): number | null {
  if (!trip.jpyPerIdr || trip.jpyPerIdr <= 0) return null;
  return idr * trip.jpyPerIdr;
}
