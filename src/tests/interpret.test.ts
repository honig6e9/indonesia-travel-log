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
    expect(normalizeSource('  Kalau ke  BANDUNG, kamu harus coba batagor ! ')).toBe(normalizeSource('Kalau ke Bandung, kamu harus coba batagor.'));
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
