// WhatsApp から取り出した候補を、利用者が選んだときだけ既存の未整理ボックス・リストへ登録する。
// クラウドに入るのは登録した内容だけ。会話の抜粋は、利用者が許可したときだけ原文として残す。

import { v5 as uuidv5 } from 'uuid';
import type { TravelDB } from '../../db/db';
import { alive, transact, type Ctx } from '../../db/repo';
import type { ChecklistItem } from '../../db/types';
import { APP_NAMESPACE, newId } from '../../lib/ids';
import { buildInboxItem, convertInbox, saveInboxItem, type TargetKind } from './inboxRepo';
import type { WaCandidate, WaCategory, WaContextMessage } from './whatsappApi';

export type WaDest = TargetKind | 'inbox' | 'append';

/** カテゴリごとの登録先と分類（専用のリストがないものは、やることか未整理ボックスへ） */
export const DEFAULT_DEST: Record<WaCategory, { dest: WaDest; category: string }> = {
  task: { dest: 'task', category: 'その他' },
  food: { dest: 'food', category: '料理' },
  restaurant: { dest: 'place', category: '店・カフェ' },
  place: { dest: 'place', category: 'その他' },
  sightseeing: { dest: 'place', category: '観光地' },
  meetup: { dest: 'task', category: '交流' },
  schedule: { dest: 'task', category: '交流' },
  shopping: { dest: 'task', category: '買い物' },
  souvenir: { dest: 'task', category: '買い物' },
  note_idea: { dest: 'idea', category: '' },
  research: { dest: 'task', category: '調査' },
  language: { dest: 'inbox', category: '' },
  change: { dest: 'inbox', category: '' },
};

export const inboxIdForCandidate = (candidateId: string) => uuidv5(`waCandidate:${candidateId}`, APP_NAMESPACE);

const norm = (s: string | null | undefined) => (s ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}_]+/gu, '');

/** 既存の項目のうち、名前がほぼ同じもの（重複の警告と「追記」の候補に使う） */
export function similarItems(c: WaCandidate, items: ChecklistItem[]): ChecklistItem[] {
  const keys = [c.name_id, c.shop, c.title_ja].map(norm).filter((k) => k.length >= 2);
  if (!keys.length) return [];
  return items.filter((i) => {
    const names = [i.title, i.localName, i.area].map(norm).filter((k) => k.length >= 2);
    return names.some((n) => keys.some((k) => n === k || (k.length >= 4 && (n.includes(k) || k.includes(n)))));
  });
}

/** 候補の説明文（登録先のメモに入れる。会話の抜粋は含めない） */
export function describe(c: WaCandidate, partnerLabel: string): string {
  const lines = [c.description];
  const facts = [
    c.name_id && `名称：${c.name_id}`,
    c.shop && `店：${c.shop}`,
    c.place && `場所：${c.place}`,
    c.price_idr != null && `価格：${c.price_idr.toLocaleString('ja-JP')} IDR`,
    c.datetime_text && `日時：${c.datetime_text}`,
    c.url,
  ].filter(Boolean);
  if (facts.length) lines.push(facts.join('　'));
  const when = c.message_at ? c.message_at.slice(0, 10) : '';
  lines.push(`（WhatsApp ${partnerLabel}${when ? ` ${when}` : ''}）`);
  return lines.filter(Boolean).join('\n');
}

export interface RegisterOptions {
  dest: WaDest;
  title: string;
  category: string;
  appendTo?: string | null;
  /** 会話の抜粋もクラウドに保存する（利用者の許可があるときだけ） */
  excerpt?: WaContextMessage[] | null;
  localDate: string;
}

/**
 * 1 件を登録する。同じ候補をもう一度登録しても重ならない（未整理ボックスの ID は候補 ID から決まり、
 * 変換済みなら変換し直さない）。
 */
export async function registerCandidate(ctx: Ctx, tripId: string, c: WaCandidate, o: RegisterOptions): Promise<'created' | 'already'> {
  const id = inboxIdForCandidate(c.id);
  const existing = await ctx.db.inboxItems.get(id);
  if (existing && !existing.deletedAt && existing.status !== 'pending') return 'already';
  const partner = c.partner || 'WhatsApp の相手';
  const excerpt = o.excerpt?.length ? o.excerpt.map((m) => `[${m.at}] ${m.from === '自分' ? '自分' : '相手'}: ${m.text}`).join('\n') : '';
  const item = await buildInboxItem(tripId, {
    id,
    sourceType: 'whatsapp',
    sourceTitle: `WhatsApp：${partner}`,
    sourceText: excerpt || describe(c, partner),
    sourceUrl: c.url ?? '',
    translatedText: c.translation_ja ?? '',
    title: o.title,
    memo: excerpt ? describe(c, partner) : '',
    category: o.category,
    area: c.shop || c.place || '',
    plannedDate: c.date,
    priority: 'normal',
  });
  if (o.dest === 'inbox') {
    await saveInboxItem(ctx, item);
    return 'created';
  }
  if (o.dest === 'append') {
    if (!o.appendTo) throw new Error('追記する項目を選んでください');
    await transact(ctx, async (w) => {
      const target = await w.get('checklistItem', o.appendTo!);
      if (!target || target.deletedAt) throw new Error('追記先の項目が見つかりません');
      const add = `【WhatsApp からの追記 ${c.message_at?.slice(0, 10) ?? ''}】${o.title}\n${describe(c, partner)}`;
      await w.put('checklistItem', { ...target, note: [target.note.trim(), add].filter(Boolean).join('\n\n') });
      await w.put('inboxItem', { ...item, status: 'processed' });
      await w.put('link', { id: newId(), tripId, sourceType: 'inboxItem', sourceId: item.id, targetType: 'checklistItem', targetId: target.id, createdAt: '', updatedAt: '' });
    });
    return 'created';
  }
  await saveInboxItem(ctx, item);
  await convertInbox(
    ctx,
    item,
    [{ kind: o.dest, title: o.title, category: o.category, area: c.shop || c.place || '', plannedDate: c.date, priority: 'normal', memo: excerpt ? describe(c, partner) : '' }],
    o.localDate,
  );
  return 'created';
}

export async function allChecklistItems(db: TravelDB, tripId: string): Promise<ChecklistItem[]> {
  return alive(await db.checklistItems.where('tripId').equals(tripId).toArray());
}
