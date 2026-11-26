import type { TravelDB } from '../../db/db';
import { alive, transact, type Ctx } from '../../db/repo';
import type { ChecklistItem, ChecklistType, Currency, Expense, FoodExperience } from '../../db/types';
import { experienceExpenseId, firstExperienceId, newId } from '../../lib/ids';

export const TASK_CATEGORIES = ['観光', '生活', '買い物', '交流', '調査', 'その他'];
export const FOOD_CATEGORIES = ['料理', '飲み物', 'おやつ', 'その他'];

export const SAMPLE_TASKS = `現地SIMの設定を確認する
KRLに乗る
MRTに乗る
ローカル市場へ行く
スーパーの物価を記録する
屋台で食事をする
現地の洗濯サービスを利用する
インドネシア語だけで注文する
現地の人と会話する
日本語学習者の話を聞く（本人の同意を得る）
ホテルの設備・生活環境を記録する`;

export const SAMPLE_FOODS = `Rendang（ルンダン）
Nasi Goreng（ナシゴレン）
Mie Ayam（ミーアヤム）
Bakso（バクソ）
Soto Ayam（ソトアヤム）
Sate Ayam（サテアヤム）
Gado-gado（ガドガド）
Nasi Padang（ナシパダン）
Rawon（ラウォン）
Martabak Manis（マルタバッマニス）
Kopi Tubruk（コピトゥブルック）`;

export async function listItems(db: TravelDB, tripId: string, type: ChecklistType): Promise<ChecklistItem[]> {
  return alive(await db.checklistItems.where('[tripId+type]').equals([tripId, type]).toArray()).sort(
    (a, b) => a.sortOrder - b.sortOrder || a.createdAt.localeCompare(b.createdAt),
  );
}

const LOCAL_NAME_RE = /^([A-Za-z][A-Za-z\s'-]+)[（(](.+)[）)]$/;

export function blankItem(tripId: string, type: ChecklistType, title: string, sortOrder: number): ChecklistItem {
  // 「Rendang（ルンダン）」のような書き方は、現地表記と日本語に分ける
  let t = title.trim();
  let localName: string | null = null;
  const m = t.match(LOCAL_NAME_RE);
  if (type === 'food' && m) {
    localName = m[1].trim();
    t = m[2].trim();
  }
  return {
    id: newId(),
    tripId,
    type,
    title: t,
    category: type === 'task' ? 'その他' : '料理',
    area: '',
    plannedDate: null,
    status: 'open',
    completedDate: null,
    priority: 'normal',
    localName,
    targetPrice: null,
    note: '',
    sortOrder,
    visibility: 'unchecked',
    createdAt: '',
    updatedAt: '',
  };
}

const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/** 一行一項目の貼り付けを解析する。空行除去・重複候補の検出 */
export function parseBulk(text: string, existing: ChecklistItem[]) {
  const seen = new Set<string>();
  const existingKeys = new Set(
    existing.flatMap((i) => [norm(i.title), i.localName ? norm(i.localName) : '']).filter(Boolean),
  );
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-・*□☐\s]+/, '').trim())
    .filter(Boolean)
    .map((line) => {
      const key = norm(line);
      const dupInInput = seen.has(key);
      seen.add(key);
      const m = line.match(LOCAL_NAME_RE);
      const parts = m ? [norm(m[1]), norm(m[2])] : [key];
      const duplicate = dupInInput || parts.some((p) => existingKeys.has(p));
      return { line, duplicate };
    });
}

export async function addItems(ctx: Ctx, tripId: string, type: ChecklistType, titles: string[], plannedDate?: string | null) {
  const current = await listItems(ctx.db, tripId, type);
  let order = current.reduce((m, i) => Math.max(m, i.sortOrder), -1) + 1;
  await transact(ctx, async (w) => {
    for (const t of titles) {
      const item = blankItem(tripId, type, t, order++);
      if (plannedDate) item.plannedDate = plannedDate;
      await w.put('checklistItem', item);
    }
  });
}

export async function saveItem(ctx: Ctx, item: ChecklistItem) {
  await transact(ctx, (w) => w.put('checklistItem', item));
}

/**
 * チェック操作。food を「食べた」にすると初回の実食（決定的 ID）を作る。
 * 解除は状態だけを戻し、実食・写真・支出は消さない。
 */
export async function setItemStatus(ctx: Ctx, item: ChecklistItem, status: ChecklistItem['status'], date: string) {
  await transact(
    ctx,
    async (w) => {
      const cur = (await w.get('checklistItem', item.id)) ?? item;
      let completedDate: string | null = null;
      if (status === 'done') completedDate = cur.status === 'done' && cur.completedDate ? cur.completedDate : date;
      await w.put('checklistItem', { ...cur, status, completedDate });
      if (cur.type === 'food' && status === 'done') {
        const existing = alive(await ctx.db.foodExperiences.where('checklistItemId').equals(cur.id).toArray());
        if (existing.length === 0) {
          const expId = firstExperienceId(cur.id);
          const prev = await w.get('foodExperience', expId);
          await w.put('foodExperience', {
            id: expId,
            tripId: cur.tripId,
            checklistItemId: cur.id,
            localDate: date,
            shop: '',
            price: null,
            currency: 'IDR',
            rating: null,
            comment: '',
            revisit: null,
            expenseId: null,
            visibility: 'unchecked',
            auto: true,
            createdAt: prev?.createdAt ?? '',
            updatedAt: '',
            deletedAt: null,
          });
        }
      }
    },
    { atomic: true },
  );
}

export async function deleteItem(ctx: Ctx, item: ChecklistItem, withExperiences: boolean) {
  await transact(ctx, async (w) => {
    await w.remove('checklistItem', item.id);
    if (withExperiences) {
      for (const e of alive(await ctx.db.foodExperiences.where('checklistItemId').equals(item.id).toArray()))
        await w.remove('foodExperience', e.id);
    }
    // 関連リンクは切り離す（写真・メモなどの素材そのものは消さない）
    for (const l of alive(await ctx.db.links.where('targetId').equals(item.id).toArray())) await w.remove('link', l.id);
    for (const l of alive(await ctx.db.links.where('sourceId').equals(item.id).toArray())) await w.remove('link', l.id);
  });
}

export async function listExperiences(db: TravelDB, itemId: string) {
  return alive(await db.foodExperiences.where('checklistItemId').equals(itemId).toArray()).sort(
    (a, b) => a.localDate.localeCompare(b.localDate) || a.createdAt.localeCompare(b.createdAt),
  );
}

export function blankExperience(item: ChecklistItem, date: string): FoodExperience {
  return {
    id: newId(),
    tripId: item.tripId,
    checklistItemId: item.id,
    localDate: date,
    shop: '',
    price: null,
    currency: 'IDR',
    rating: null,
    comment: '',
    revisit: null,
    expenseId: null,
    visibility: 'unchecked',
    createdAt: '',
    updatedAt: '',
  };
}

/**
 * 実食の保存。「支出にも登録」のとき、紐づく支出があれば編集し、なければ決定的 ID で作る（二重集計を防ぐ）。
 * 実食・支出・料理の状態を 1 バッチで送る。
 */
export async function saveExperience(
  ctx: Ctx,
  item: ChecklistItem,
  exp: FoodExperience,
  alsoExpense: boolean,
  partySize: number | null,
) {
  await transact(
    ctx,
    async (w) => {
      let expenseId = exp.expenseId ?? null;
      if (alsoExpense && exp.price != null && exp.price >= 0) {
        expenseId = expenseId ?? experienceExpenseId(exp.id);
        const prev = await w.get('expense', expenseId);
        const expense: Expense = {
          id: expenseId,
          tripId: item.tripId,
          localDate: exp.localDate,
          amount: Math.round(exp.price),
          currency: exp.currency as Currency,
          personalAmount: prev?.personalAmount ?? null,
          category: '食事',
          shop: exp.shop,
          partySize: partySize ?? prev?.partySize ?? null,
          paymentMethod: prev?.paymentMethod ?? '',
          note: prev?.note || item.title,
          kind: 'expense',
          receiptMediaId: prev?.receiptMediaId ?? null,
          createdAt: prev?.createdAt ?? '',
          updatedAt: '',
          deletedAt: null,
        };
        await w.put('expense', expense);
      }
      await w.put('foodExperience', { ...exp, expenseId, auto: false });
      const cur = (await w.get('checklistItem', item.id)) ?? item;
      if (cur.status !== 'done') await w.put('checklistItem', { ...cur, status: 'done', completedDate: exp.localDate });
    },
    { atomic: true },
  );
}

export async function deleteExperience(ctx: Ctx, exp: FoodExperience, withExpense: boolean) {
  await transact(ctx, async (w) => {
    await w.remove('foodExperience', exp.id);
    if (withExpense && exp.expenseId) await w.remove('expense', exp.expenseId);
  });
}

export function progress(items: ChecklistItem[]) {
  const done = items.filter((i) => i.status === 'done').length;
  const skipped = items.filter((i) => i.status === 'skipped').length;
  return { done, skipped, total: items.length };
}
