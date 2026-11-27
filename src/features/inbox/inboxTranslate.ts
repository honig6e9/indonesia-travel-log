// 未整理ボックスの原文（インドネシア語）を家の PC で訳す。通訳と同じ受付（interpret_jobs）を使う。
// 通信や家の PC がないときは翻訳待ちとして端末に残し、つながったら送って、届いた訳を「日本語訳」に入れる。
// 手で入れた日本語訳は上書きしない。

import type { SupabaseClient } from '@supabase/supabase-js';
import type { TravelDB } from '../../db/db';
import { transact, type Ctx } from '../../db/repo';
import type { InboxItem, Interpretation } from '../../db/types';
import { newId } from '../../lib/ids';
import { guessLang, refresh, submit } from '../interpret/interpretRepo';

export type InboxTranslationState = 'none' | 'waiting' | 'translating' | 'done' | 'failed';

/** 訳せる原文か（インドネシア語・英語など、日本語でない文） */
export function needsTranslation(item: InboxItem): boolean {
  return !!item.sourceText.trim() && guessLang(item.sourceText) === 'id';
}

/** 家の PC に訳を頼む（端末に翻訳待ちとして残す。送るのは processInboxTranslations） */
export async function requestInboxTranslation(db: TravelDB, item: InboxItem): Promise<Interpretation | null> {
  if (!needsTranslation(item)) return null;
  const text = item.sourceText.trim().slice(0, 2000);
  const it: Interpretation = {
    id: newId(),
    createdAt: new Date().toISOString(),
    mode: 'id-ja',
    inputText: text,
    sourceText: text,
    status: 'local',
    via: 'pc',
    speaker: 'them',
    inboxId: item.id,
  };
  await db.interpretations.put(it);
  return it;
}

/** その項目の最新の翻訳依頼の状態 */
export async function inboxTranslationState(db: TravelDB, inboxId: string): Promise<{ state: InboxTranslationState; job: Interpretation | null }> {
  const jobs = (await db.interpretations.filter((i) => i.inboxId === inboxId).toArray()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const job = jobs[0] ?? null;
  if (!job) return { state: 'none', job };
  const state: InboxTranslationState =
    job.status === 'local' || job.status === 'queued' ? 'waiting' : job.status === 'processing' ? 'translating' : job.status === 'error' ? 'failed' : 'done';
  return { state, job };
}

/** 届いた訳を未整理ボックスに入れる（手で入れた訳は上書きしない）。入れた数を返す */
export async function applyInboxTranslations(ctx: Ctx): Promise<number> {
  const done = await ctx.db.interpretations.filter((i) => !!i.inboxId && !i.inboxDone && i.status === 'done' && !!i.targetText).toArray();
  let n = 0;
  for (const j of done) {
    await transact(ctx, async (w) => {
      const cur = await w.get('inboxItem', j.inboxId!);
      if (cur && !cur.deletedAt && cur.translationSource !== 'manual') {
        await w.put('inboxItem', { ...cur, translatedText: j.targetText!, translationSource: 'pc' });
        n++;
      }
    });
    await ctx.db.interpretations.update(j.id, { inboxDone: true });
  }
  return n;
}

/** 翻訳待ちを送り、状態を取り込み、届いた訳を入れる（ログインして同期しているときだけ送れる） */
export async function processInboxTranslations(ctx: Ctx, sb: SupabaseClient | null, ownerId: string | null, deviceId: string): Promise<number> {
  if (sb && ownerId) {
    for (const it of await ctx.db.interpretations.filter((i) => !!i.inboxId && i.status === 'local').toArray()) {
      try {
        await submit(ctx.db, sb, ownerId, deviceId, it);
      } catch {
        /* 通信が戻ったら送り直す */
      }
    }
    const pending = await ctx.db.interpretations.filter((i) => !!i.inboxId && (i.status === 'queued' || i.status === 'processing')).primaryKeys();
    if (pending.length) await refresh(ctx.db, sb, pending as string[]).catch(() => undefined);
  }
  return applyInboxTranslations(ctx);
}
