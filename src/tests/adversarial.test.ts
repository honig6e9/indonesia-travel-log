// 境目・悪意のある入力での検証（敵対的テスト）
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { TravelDB } from '../db/db';
import { safeHttpUrl } from '../lib/url';
import { parseCoord, locationHistory, type TripData } from '../features/history/historyData';
import { detectSource, extractUrl, guessTitle, normalizeUrl, splitEntries } from '../features/inbox/inboxRepo';
import { endFromText, periodOf } from '../features/checklist/period';
import { findCachedTranslation, normalizeSource } from '../features/interpret/interpretRepo';
import { buildBackup, validateBackup } from '../features/settings/backup';
import { createTrip } from '../features/daily/tripRepo';
import type { ChecklistItem } from '../db/types';

describe('危険な URL', () => {
  it('http・https だけをリンクにする', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl(' JaVaScRiPt:alert(1)')).toBeNull();
    expect(safeHttpUrl('intent://scan/#Intent;scheme=zxing;end')).toBeNull();
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHttpUrl('https://x.com/a')).toBe('https://x.com/a');
    expect(safeHttpUrl('')).toBeNull();
  });

  it('おかしな URL でも取り込みの処理が落ちない', () => {
    expect(() => normalizeUrl('javascript:alert(1)')).not.toThrow();
    expect(() => normalizeUrl('http://[::1')).not.toThrow();
    expect(detectSource('not a url %%', 'manual')).toBe('manual');
    expect(extractUrl('見て→https://example.com/a）')).toBe('https://example.com/a');
    expect(guessTitle({ text: 'https://example.com/' + 'a'.repeat(500) }).length).toBeLessThanOrEqual(80);
    expect(splitEntries('A\r\nB\r\n\r\nC')).toEqual(['A\nB', 'C']);
  });
});

describe('期間の境目', () => {
  const item = (title: string, plannedDate: string, plannedEndDate: string | null = null) =>
    ({ title, note: '', plannedDate, plannedEndDate, status: 'open' }) as unknown as ChecklistItem;
  it('年をまたぐ期間・逆向きの期間・終了日が開始より前', () => {
    expect(endFromText('年越し 12/31〜1/2', '2026-12-31')).toBe('2027-01-02');
    expect(endFromText('12/4〜3', '2026-12-04')).toBeNull();
    expect(periodOf(item('x', '2026-12-05', '2026-12-01'))).toEqual({ start: '2026-12-05', end: '2026-12-05' });
  });
});

describe('位置の履歴の境目', () => {
  it('座標でない場所・範囲外の数字は並べない', () => {
    expect(parseCoord('Jl. Sabang 12')).toBeNull();
    expect(parseCoord('')).toBeNull();
    const d = {
      logs: [], answers: [], clips: [], media: [], expenses: [], items: [], exps: [],
      notes: [{ id: 'n', tripId: 't', localDate: '2026-12-01', createdAt: '2026-12-01T00:00:00Z', updatedAt: '', body: 'x', location: 'ホテルの前' }],
    } as unknown as TripData;
    expect(locationHistory(d, (s) => s.slice(0, 10))).toEqual([]);
  });
});

describe('翻訳の使い回しの境目', () => {
  it('句点だけ・空の文では使い回さない。疑問文に平叙文の訳を使わない', async () => {
    const db = new TravelDB('adv-cache');
    await db.interpretations.put({ id: 'a', createdAt: '2026-12-01T00:00:00Z', mode: 'id-ja', status: 'done', sourceLang: 'id', sourceText: 'Sudah makan.', targetText: 'もう食べました。', via: 'pc' });
    expect(normalizeSource('  。. ')).toBe('');
    expect(await findCachedTranslation(db, '。', 'id')).toBeNull();
    expect(await findCachedTranslation(db, '', 'id')).toBeNull();
    expect(await findCachedTranslation(db, 'Sudah makan?', 'id')).toBeNull();
    expect((await findCachedTranslation(db, 'sudah makan', 'id'))?.id).toBe('a');
  });
});

describe('古い版のバックアップ', () => {
  it('未整理ボックスのない版 2 のバックアップも検証を通る', async () => {
    const db = new TravelDB('adv-backup');
    await createTrip({ db, ownerId: null });
    const { blob } = await buildBackup(db);
    const zip = await JSZip.loadAsync(blob);
    const manifest = JSON.parse(await zip.file('manifest.json')!.async('string'));
    const data = JSON.parse(await zip.file('backup.json')!.async('string'));
    manifest.schemaVersion = 2;
    delete data.tables.inboxItems;
    zip.file('manifest.json', JSON.stringify(manifest));
    zip.file('backup.json', JSON.stringify(data));
    const old = await zip.generateAsync({ type: 'blob' });
    const v = await validateBackup(old);
    expect(v.data.tables.inboxItems).toEqual([]);
  });
});
