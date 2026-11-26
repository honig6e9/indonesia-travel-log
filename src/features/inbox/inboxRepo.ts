// 外部から取り込んだ情報（未整理ボックス）の保存・重複の判定・リストへの変換。
// 原文・URL・画像は変換後も消さず、変換先とはリンク（inboxItem → 変換先）で結ぶ。

import type { TravelDB } from '../../db/db';
import { alive, transact, type Ctx } from '../../db/repo';
import type { ChecklistItem, ChecklistType, EntityType, InboxItem, InboxSource, InboxStatus, Media, Note, Priority } from '../../db/types';
import { newId } from '../../lib/ids';
import { blankItem } from '../checklist/checklistRepo';
import { v5 as uuidv5 } from 'uuid';
import { APP_NAMESPACE } from '../../lib/ids';

// ---------- 文字の処理（純粋関数） ----------

const URL_RE = /https?:\/\/[^\s<>"'）」』】]+/i;
const TRACKING = /^(utm_[a-z]+|fbclid|gclid|igsh|igshid|si|s|t|ref|ref_src|ref_url|mibextid|share_id|feature)$/i;

/** 文の中の最初の URL（末尾の句読点は外す） */
export function extractUrl(text: string): string {
  const m = text.match(URL_RE);
  return m ? m[0].replace(/[.,;:!?。、）)\]]+$/, '') : '';
}

/** 同じページかを見分けるための URL（追跡用の引数・末尾の / ・# を外す） */
export function normalizeUrl(raw: string): string {
  const s = raw.trim();
  if (!s) return '';
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s);
  } catch {
    return s.toLowerCase();
  }
  let host = u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  if (host === 'twitter.com' || host === 'fxtwitter.com' || host === 'vxtwitter.com') host = 'x.com';
  const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  const qs = params.length ? '?' + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&') : '';
  const path = u.pathname.replace(/\/+$/, '') || '';
  return `${host}${path}${qs}`;
}

/** 送り元の種類を URL から決める（分からなければ fallback） */
export function detectSource(url: string, fallback: InboxSource): InboxSource {
  if (!url) return fallback;
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url);
  } catch {
    return fallback;
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  if (/(^|\.)(x|twitter)\.com$/.test(host)) return 'x';
  if (/(^|\.)instagram\.com$/.test(host) || host === 'instagr.am') return 'instagram';
  if (host === 'maps.app.goo.gl' || (host === 'goo.gl' && path.startsWith('/maps')) || (/(^|\.)google\.[a-z.]+$/.test(host) && path.startsWith('/maps')) || host.startsWith('maps.google.'))
    return 'maps';
  return 'web';
}

/** ハッシュ用に原文の空白をそろえる */
export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export async function textHashOf(text: string): Promise<string> {
  const n = normalizeText(text);
  if (!n) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(n));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** タイトルが空のときの仮タイトル：原文の最初の行（URL を除く）→ 共有元のタイトル → URL */
export function guessTitle(o: { title?: string; sourceTitle?: string; text?: string; url?: string }): string {
  const t = (o.title ?? '').trim();
  if (t) return t.slice(0, 120);
  const line = (o.text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(new RegExp(URL_RE.source, 'gi'), '').trim())
    .find((l) => l.length > 0);
  if (line) return line.length > 60 ? line.slice(0, 60) + '…' : line;
  const st = (o.sourceTitle ?? '').trim();
  if (st) return st.slice(0, 120);
  const url = (o.url ?? '').trim();
  if (url) {
    try {
      const u = new URL(url);
      return (u.hostname.replace(/^www\./, '') + decodeURIComponent(u.pathname)).replace(/\/$/, '').slice(0, 80);
    } catch {
      return url.slice(0, 80);
    }
  }
  return '（無題）';
}

/** 複数行の貼り付けを 1 件ずつに分ける（空行で区切る。空行がなければ 1 行ずつ） */
export function splitEntries(text: string): string[] {
  const t = text.replace(/\r\n/g, '\n').trim();
  if (!t) return [];
  const blocks = t.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  if (blocks.length > 1) return blocks;
  return t.split('\n').map((l) => l.replace(/^\s*(?:[-・*•]|\d+[.)．])\s*/, '').trim()).filter(Boolean);
}

/** 共有受信 ID から決まる記録 ID（同じ共有を 2 回保存しても 1 件になる） */
export const inboxIdFromShare = (shareId: string) => uuidv5(`inboxShare:${shareId}`, APP_NAMESPACE);

// ---------- 保存 ----------

export interface InboxInput {
  id?: string;
  sourceType: InboxSource;
  sourceTitle?: string;
  sourceText?: string;
  sourceUrl?: string;
  translatedText?: string;
  title?: string;
  memo?: string;
  category?: string;
  area?: string;
  plannedDate?: string | null;
  priority?: Priority;
  shareId?: string | null;
}

export async function buildInboxItem(tripId: string, i: InboxInput): Promise<InboxItem> {
  const text = (i.sourceText ?? '').trim();
  const url = (i.sourceUrl ?? '').trim() || extractUrl(text);
  return {
    id: i.id ?? (i.shareId ? inboxIdFromShare(i.shareId) : newId()),
    tripId,
    sourceType: i.sourceType === 'manual' || i.sourceType === 'clipboard' || i.sourceType === 'unknown' ? detectSource(url, i.sourceType) : i.sourceType,
    sourceTitle: (i.sourceTitle ?? '').trim(),
    sourceText: text,
    sourceUrl: url,
    translatedText: (i.translatedText ?? '').trim(),
    status: 'pending',
    title: guessTitle({ title: i.title, sourceTitle: i.sourceTitle, text, url }),
    memo: (i.memo ?? '').trim(),
    category: i.category ?? '',
    area: i.area ?? '',
    plannedDate: i.plannedDate ?? null,
    priority: i.priority ?? 'normal',
    urlKey: normalizeUrl(url),
    textHash: await textHashOf(text),
    shareId: i.shareId ?? null,
    createdAt: '',
    updatedAt: '',
  };
}

export async function saveInboxItem(ctx: Ctx, item: InboxItem): Promise<InboxItem> {
  return transact(ctx, (w) => w.put('inboxItem', item));
}

export async function updateInboxItem(ctx: Ctx, item: InboxItem, patch: Partial<InboxItem>): Promise<InboxItem> {
  const next = { ...item, ...patch };
  if ('sourceUrl' in patch) next.urlKey = normalizeUrl(next.sourceUrl);
  if ('sourceText' in patch) next.textHash = await textHashOf(next.sourceText);
  return transact(ctx, (w) => w.put('inboxItem', next));
}

export async function setInboxStatus(ctx: Ctx, ids: string[], status: InboxStatus) {
  await transact(ctx, async (w) => {
    for (const id of ids) {
      const cur = await w.get('inboxItem', id);
      if (cur && !cur.deletedAt && cur.status !== status) await w.put('inboxItem', { ...cur, status });
    }
  });
}

/** 削除（墓石）。変換先の項目は消さない */
export async function deleteInboxItems(ctx: Ctx, ids: string[]) {
  await transact(ctx, async (w) => {
    for (const id of ids) {
      await w.remove('inboxItem', id);
      for (const l of alive(await ctx.db.links.where('sourceId').equals(id).toArray())) await w.remove('link', l.id);
      // 画像（media → inboxItem）のリンクも外す。写真そのものは残す
      for (const l of alive(await ctx.db.links.where('targetId').equals(id).toArray())) await w.remove('link', l.id);
    }
  });
}

export async function listInbox(db: TravelDB, tripId: string): Promise<InboxItem[]> {
  return alive(await db.inboxItems.where('tripId').equals(tripId).toArray());
}

export async function pendingInboxCount(db: TravelDB, tripId: string): Promise<number> {
  return db.inboxItems
    .where('[tripId+status]')
    .equals([tripId, 'pending'])
    .filter((x) => !x.deletedAt)
    .count();
}

export interface Duplicate {
  item: InboxItem;
  reason: 'url' | 'text';
}

/** 同じ URL か同じ原文の記録（警告に使う。保存は止めない） */
export async function findDuplicates(db: TravelDB, tripId: string, o: { id?: string; urlKey: string; textHash: string }): Promise<Duplicate[]> {
  const out: Duplicate[] = [];
  const seen = new Set<string>();
  if (o.urlKey) {
    for (const x of alive(await db.inboxItems.where('urlKey').equals(o.urlKey).toArray()))
      if (x.tripId === tripId && x.id !== o.id && !seen.has(x.id)) {
        seen.add(x.id);
        out.push({ item: x, reason: 'url' });
      }
  }
  if (o.textHash) {
    for (const x of alive(await db.inboxItems.where('textHash').equals(o.textHash).toArray()))
      if (x.tripId === tripId && x.id !== o.id && !seen.has(x.id)) {
        seen.add(x.id);
        out.push({ item: x, reason: 'text' });
      }
  }
  return out;
}

// ---------- 画像 ----------

export async function inboxMedia(db: TravelDB, inboxId: string): Promise<Media[]> {
  const links = alive(await db.links.where('targetId').equals(inboxId).toArray()).filter((l) => l.sourceType === 'media');
  return alive((await db.media.bulkGet(links.map((l) => l.sourceId))).filter((m): m is Media => !!m));
}

// ---------- 変換 ----------

export type TargetKind = ChecklistType | 'idea';
export const TARGET_LABEL: Record<TargetKind | 'inbox', string> = {
  inbox: '未整理ボックス',
  task: 'やること',
  food: '食べたいもの',
  place: '行きたい場所',
  idea: '記事ネタ',
};

export interface ConvertTarget {
  kind: TargetKind;
  title: string;
  category?: string;
  area?: string;
  plannedDate?: string | null;
  priority?: Priority;
  memo?: string;
}

/** 変換先のメモに入れる「元の情報」（原文・訳・URL） */
export function sourceBlock(item: InboxItem): string {
  const lines: string[] = [];
  if (item.sourceText) lines.push(item.sourceText);
  if (item.translatedText) lines.push(`（訳）${item.translatedText}`);
  if (item.sourceUrl && !item.sourceText.includes(item.sourceUrl)) lines.push(item.sourceUrl);
  return lines.length ? `── 取り込んだ元の情報 ──\n${lines.join('\n')}` : '';
}

const joinMemo = (memo: string | undefined, block: string) => [memo?.trim(), block].filter(Boolean).join('\n\n');

/**
 * 未整理の情報を、やること・食べたいもの・行きたい場所・記事ネタに変換する（1 件から複数件も可）。
 * 元の情報は消さずに「整理済み」にし、変換先とリンクで結ぶ。写真も変換先に結ぶ。
 */
export async function convertInbox(ctx: Ctx, item: InboxItem, targets: ConvertTarget[], localDate: string): Promise<{ type: EntityType; id: string }[]> {
  const media = await inboxMedia(ctx.db, item.id);
  const block = sourceBlock(item);
  const created: { type: EntityType; id: string }[] = [];
  // 新しい種類（inboxItem）を含むので、ほかの記録とは別に送れるよう原子的なまとまりにしない
  await transact(ctx, async (w) => {
    for (const t of targets) {
      const title = t.title.trim();
      if (!title) continue;
      let target: { type: EntityType; id: string };
      if (t.kind === 'idea') {
        const note: Note = {
          id: newId(),
          tripId: item.tripId,
          localDate,
          body: joinMemo([title, t.memo?.trim()].filter(Boolean).join('\n'), block),
          category: '記事ネタ',
          tags: ['記事ネタ'],
          evidenceType: '',
          visibility: 'unchecked',
          location: null,
          createdAt: '',
          updatedAt: '',
        };
        await w.put('note', note);
        target = { type: 'note', id: note.id };
      } else {
        const existing = await ctx.db.checklistItems.where('[tripId+type]').equals([item.tripId, t.kind]).toArray();
        const sort = existing.reduce((m, x) => Math.max(m, x.sortOrder), 0) + 1;
        const base = blankItem(item.tripId, t.kind, title, sort);
        const rec: ChecklistItem = {
          ...base,
          category: t.category || base.category,
          area: t.area ?? base.area,
          plannedDate: t.plannedDate ?? null,
          priority: t.priority ?? 'normal',
          note: joinMemo(t.memo, block),
        };
        await w.put('checklistItem', rec);
        target = { type: 'checklistItem', id: rec.id };
      }
      created.push(target);
      await w.put('link', { id: newId(), tripId: item.tripId, sourceType: 'inboxItem', sourceId: item.id, targetType: target.type, targetId: target.id, createdAt: '', updatedAt: '' });
      for (const m of media)
        await w.put('link', { id: newId(), tripId: item.tripId, sourceType: 'media', sourceId: m.id, targetType: target.type, targetId: target.id, createdAt: '', updatedAt: '' });
    }
    if (created.length) {
      const cur = (await w.get('inboxItem', item.id)) ?? item;
      await w.put('inboxItem', { ...cur, status: 'processed' });
    }
  });
  return created;
}

export interface ConvertedRef {
  type: EntityType;
  id: string;
  label: string;
  kind: TargetKind;
}

/** 変換先の一覧（削除されたものは出さない） */
export async function convertedTo(db: TravelDB, inboxId: string): Promise<ConvertedRef[]> {
  const links = alive(await db.links.where('sourceId').equals(inboxId).toArray()).filter((l) => l.sourceType === 'inboxItem');
  const out: ConvertedRef[] = [];
  for (const l of links) {
    if (l.targetType === 'checklistItem') {
      const i = await db.checklistItems.get(l.targetId);
      if (i && !i.deletedAt) out.push({ type: 'checklistItem', id: i.id, label: i.title, kind: i.type });
    } else if (l.targetType === 'note') {
      const n = await db.notes.get(l.targetId);
      if (n && !n.deletedAt) out.push({ type: 'note', id: n.id, label: n.body.split('\n')[0], kind: 'idea' });
    }
  }
  return out;
}

/** 変換先（リストの項目）から取り込み元を探す */
export async function inboxSourceOf(db: TravelDB, targetId: string): Promise<InboxItem | null> {
  const l = alive(await db.links.where('targetId').equals(targetId).toArray()).find((x) => x.sourceType === 'inboxItem');
  if (!l) return null;
  const x = await db.inboxItems.get(l.sourceId);
  return x && !x.deletedAt ? x : null;
}
