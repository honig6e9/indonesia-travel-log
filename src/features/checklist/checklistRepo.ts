import type { TravelDB } from '../../db/db';
import { alive, transact, type Ctx } from '../../db/repo';
import type { ChecklistItem, ChecklistType, Currency, Expense, FoodExperience, Priority } from '../../db/types';
import { experienceExpenseId, firstExperienceId, newId } from '../../lib/ids';

export const TASK_CATEGORIES = ['観光', '生活', '買い物', '交流', '調査', 'その他'];
export const FOOD_CATEGORIES = ['料理', '飲み物', 'おやつ', 'その他'];
export const PLACE_CATEGORIES = ['観光地', '店・カフェ', '市場', '自然', '宗教施設', 'その他'];

export function categoriesFor(type: ChecklistType): string[] {
  return type === 'food' ? FOOD_CATEGORIES : type === 'place' ? PLACE_CATEGORIES : TASK_CATEGORIES;
}

/** リストの種類ごとの呼び方 */
export const TYPE_TEXT: Record<ChecklistType, { name: string; open: string; done: string; placeholder: string; area: string }> = {
  task: { name: 'やること', open: '未完了', done: '完了', placeholder: '例：KRLに乗る', area: 'エリア・店名' },
  food: { name: '食べたいもの', open: '未体験', done: '食べた', placeholder: '例：Soto Ayam（ソトアヤム）', area: '行きたい店・地域' },
  place: { name: '行きたい場所', open: '未訪問', done: '行った', placeholder: '例：Kota Tua（コタトゥア）', area: '地域・住所' },
};

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
    category: type === 'food' ? '料理' : 'その他',
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

// ---------- ファイルから取り込む ----------

export interface ImportItem {
  type: ChecklistType;
  title: string;
  localName?: string | null;
  category?: string;
  area?: string;
  plannedDate?: string | null;
  plannedEndDate?: string | null;
  priority?: Priority;
  status?: ChecklistItem['status'];
  note?: string;
  targetPrice?: number | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 取り込み用ファイル（JSON）を読む。形の合わない行は理由つきで外す */
export function parseImportFile(text: string): { items: ImportItem[]; errors: string[] } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { items: [], errors: ['JSON として読めません'] };
  }
  const list = Array.isArray(data) ? data : (data as { items?: unknown })?.items;
  if (!Array.isArray(list)) return { items: [], errors: ['items の一覧がありません'] };
  if (list.length > 1000) return { items: [], errors: ['1 回に取り込めるのは 1000 件までです'] };
  const items: ImportItem[] = [];
  const errors: string[] = [];
  list.forEach((raw, i) => {
    const r = raw as Record<string, unknown>;
    const title = typeof r.title === 'string' ? r.title.trim() : '';
    const where = `${i + 1} 件目`;
    if (r.type !== 'task' && r.type !== 'food') return errors.push(`${where}：type は task か food`);
    if (!title || title.length > 200) return errors.push(`${where}：タイトルがないか長すぎます`);
    if (r.plannedDate != null && !(typeof r.plannedDate === 'string' && DATE_RE.test(r.plannedDate))) return errors.push(`${where}：予定日の形が違います`);
    if (r.plannedEndDate != null && !(typeof r.plannedEndDate === 'string' && DATE_RE.test(r.plannedEndDate))) return errors.push(`${where}：終了日の形が違います`);
    if (r.priority != null && !['high', 'normal', 'low'].includes(r.priority as string)) return errors.push(`${where}：優先度の値が違います`);
    if (r.status != null && !['open', 'done', 'skipped'].includes(r.status as string)) return errors.push(`${where}：状態の値が違います`);
    const price = r.targetPrice == null ? null : Number(r.targetPrice);
    if (price != null && (!Number.isInteger(price) || price < 0)) return errors.push(`${where}：目安予算は 0 以上の整数`);
    const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
    items.push({
      type: r.type,
      title,
      localName: str(r.localName, 200) || null,
      category: str(r.category, 40) || undefined,
      area: str(r.area, 300),
      plannedDate: (r.plannedDate as string | null | undefined) ?? null,
      plannedEndDate: (r.plannedEndDate as string | null | undefined) ?? null,
      priority: (r.priority as Priority | undefined) ?? 'normal',
      status: (r.status as ChecklistItem['status'] | undefined) ?? 'open',
      note: str(r.note, 4000),
      targetPrice: price,
    });
  });
  return { items, errors };
}

/** すでにある項目と同じ名前か（重複の候補） */
export function isDuplicate(item: ImportItem, existing: ChecklistItem[]): boolean {
  const key = norm(item.title);
  return existing.some((e) => e.type === item.type && (norm(e.title) === key || (!!e.localName && norm(e.localName) === key)));
}

export async function importItems(ctx: Ctx, tripId: string, items: ImportItem[]) {
  const current = [...(await listItems(ctx.db, tripId, 'task')), ...(await listItems(ctx.db, tripId, 'food'))];
  let order = current.reduce((m, i) => Math.max(m, i.sortOrder), -1) + 1;
  await transact(ctx, async (w) => {
    for (const it of items) {
      const base = blankItem(tripId, it.type, it.title, order++);
      await w.put('checklistItem', {
        ...base,
        title: it.title,
        localName: it.localName ?? base.localName,
        category: it.category ?? base.category,
        area: it.area ?? '',
        plannedDate: it.plannedDate ?? null,
        plannedEndDate: it.plannedEndDate ?? null,
        priority: it.priority ?? 'normal',
        status: it.status ?? 'open',
        note: it.note ?? '',
        targetPrice: it.targetPrice ?? null,
      });
    }
  });
}
