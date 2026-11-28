// 通訳の訳の管理：過去の訳の使い回し・手で直した訳を上書きしない
import { beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { TravelDB } from '../db/db';
import type { Interpretation } from '../db/types';
import { findCachedTranslation, fixTranslation, normalizeSource, refresh } from '../features/interpret/interpretRepo';

let db: TravelDB;
let n = 0;
beforeEach(() => {
  db = new TravelDB(`interp-${n++}`);
});

const done = (over: Partial<Interpretation>): Interpretation => ({
  id: crypto.randomUUID(),
  createdAt: '2026-12-01T00:00:00Z',
  mode: 'id-ja',
  status: 'done',
  sourceLang: 'id',
  targetLang: 'ja',
  sourceText: 'Kalau ke Bandung, kamu harus coba batagor.',
  targetText: 'バンドンに行くならバタゴールを食べてみて',
  via: 'pc',
  ...over,
});

describe('過去の訳の使い回し', () => {
  it('空白・大文字小文字・文末の句読点が違っても同じ文とみなす', () => {
    expect(normalizeSource('  Kalau ke  BANDUNG, kamu harus coba batagor 。 ')).toBe(normalizeSource('Kalau ke Bandung, kamu harus coba batagor.'));
    // 疑問と平叙は別の文（Sudah makan? と Sudah makan.）
    expect(normalizeSource('Sudah makan?')).not.toBe(normalizeSource('Sudah makan.'));
  });

  it('同じ向きの訳だけを使い、手で直した訳を優先する', async () => {
    const auto = done({ createdAt: '2026-12-02T00:00:00Z' });
    const manual = done({ createdAt: '2026-12-01T00:00:00Z', targetText: 'バンドンに行ったらバタゴールを食べなきゃ', manual: true });
    const otherDir = done({ sourceLang: 'ja', sourceText: 'Kalau ke Bandung, kamu harus coba batagor.' });
    const failed = done({ status: 'error', targetText: null });
    await db.interpretations.bulkPut([auto, manual, otherDir, failed]);
    const hit = await findCachedTranslation(db, 'kalau ke bandung, kamu harus coba batagor', 'id');
    expect(hit?.id).toBe(manual.id);
    expect(await findCachedTranslation(db, 'Apa kabar?', 'id')).toBeNull();
  });

  it('Google 翻訳で開いただけ（未翻訳）のものは使わない', async () => {
    await db.interpretations.put(done({ via: 'google', targetText: null }));
    expect(await findCachedTranslation(db, 'Kalau ke Bandung, kamu harus coba batagor.', 'id')).toBeNull();
  });
});

describe('手で直した訳', () => {
  it('あとから届いた家の PC の訳で上書きしない', async () => {
    const it0 = done({ status: 'processing', targetText: '速い訳' });
    await db.interpretations.put(it0);
    await fixTranslation(db, it0.id, '直した訳');
    const job = { id: it0.id, status: 'done', source_lang: 'id', source_text: it0.sourceText, target_lang: 'ja', target_text: 'PC の訳', reading: '', provider: 'codex', error: null };
    const sb = { from: () => ({ select: () => ({ in: async () => ({ data: [job], error: null }) }) }) } as unknown as SupabaseClient;
    await refresh(db, sb, [it0.id]);
    const after = await db.interpretations.get(it0.id);
    expect(after?.targetText).toBe('直した訳');
    expect(after?.manual).toBe(true);
    expect(after?.status).toBe('done');
  });
});

describe('未整理ボックスの翻訳待ち', () => {
  it('インドネシア語の原文だけ依頼し、届いた訳を入れる。手で入れた訳は上書きしない', async () => {
    const { createTrip } = await import('../features/daily/tripRepo');
    const { buildInboxItem, saveInboxItem } = await import('../features/inbox/inboxRepo');
    const { requestInboxTranslation, applyInboxTranslations, inboxTranslationState } = await import('../features/inbox/inboxTranslate');
    const ctx = { db, ownerId: null };
    const trip = await createTrip(ctx);
    const id1 = await buildInboxItem(trip.id, { sourceType: 'clipboard', sourceText: 'Kalau ke Bandung, kamu harus coba batagor.' });
    const ja = await buildInboxItem(trip.id, { sourceType: 'clipboard', sourceText: '駅の近くのワルン' });
    const manual = { ...(await buildInboxItem(trip.id, { sourceType: 'clipboard', sourceText: 'Jangan pedas, ya.' })), translatedText: '辛くしないでね', translationSource: 'manual' as const };
    for (const x of [id1, ja, manual]) await saveInboxItem(ctx, x);

    expect(await requestInboxTranslation(db, ja)).toBeNull();
    const j1 = (await requestInboxTranslation(db, id1))!;
    const j2 = (await requestInboxTranslation(db, manual))!;
    expect(j1.mode).toBe('id-ja');
    expect((await inboxTranslationState(db, id1.id)).state).toBe('waiting');

    // 家の PC の訳が届いた
    await db.interpretations.update(j1.id, { status: 'done', targetText: 'バンドンに行くならバタゴールを食べてみて', provider: 'codex' });
    await db.interpretations.update(j2.id, { status: 'done', targetText: '辛くしないで', provider: 'codex' });
    expect(await applyInboxTranslations(ctx)).toBe(1);
    expect((await db.inboxItems.get(id1.id))?.translatedText).toBe('バンドンに行くならバタゴールを食べてみて');
    expect((await db.inboxItems.get(id1.id))?.translationSource).toBe('pc');
    expect((await db.inboxItems.get(manual.id))?.translatedText).toBe('辛くしないでね');
    expect((await inboxTranslationState(db, id1.id)).state).toBe('done');
    expect(await applyInboxTranslations(ctx)).toBe(0); // 入れ終えたものはもう触らない
  });
});

describe('ほかの端末の履歴の取り込み', () => {
  it('未整理ボックスの原文と一致する依頼は、通訳の履歴に出さない印を付ける', async () => {
    const { pullHistory } = await import('../features/interpret/interpretRepo');
    await db.inboxItems.put({ id: 'ib1', tripId: 't', createdAt: '', updatedAt: '', sourceType: 'clipboard', sourceTitle: '', sourceText: 'Jangan pedas, ya.', sourceUrl: '', translatedText: '', status: 'pending', title: 'x', memo: '', category: '', area: '', priority: 'normal', urlKey: '', textHash: '' });
    const row = (id: string, text: string) => ({ id, created_at: '2026-12-01T00:00:00Z', mode: 'id-ja', audio_path: null, input_text: text, status: 'done', source_lang: 'id', source_text: text, target_lang: 'ja', target_text: '訳', reading: '', provider: 'codex', error: null });
    const sb = { from: () => ({ select: () => ({ order: () => ({ limit: async () => ({ data: [row('j1', 'Jangan pedas, ya.'), row('j2', 'Apa kabar?')], error: null }) }) }) }) } as unknown as SupabaseClient;
    await pullHistory(db, sb);
    expect((await db.interpretations.get('j1'))?.inboxId).toBe('ib1');
    expect((await db.interpretations.get('j2'))?.inboxId).toBeUndefined();
  });
});
