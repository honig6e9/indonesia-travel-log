// A09・A10・S12：全データ ZIP の作成 → 検証 → 別領域への復元。壊れた ZIP で既存データを壊さない
import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { TravelDB } from '../db/db';
import { alive, type Ctx } from '../db/repo';
import { createTrip, getActiveTrip } from '../features/daily/tripRepo';
import { addItems, listItems, setItemStatus } from '../features/checklist/checklistRepo';
import { blankNote, saveNote } from '../features/notes/notesRepo';
import { loadDiary, saveClip } from '../features/diary/diaryRepo';
import { buildBackup, copyTripAsNew, restoreInto, validateBackup } from '../features/settings/backup';

let n = 0;
const fresh = () => new TravelDB(`backup-test-${n++}`);

async function seeded() {
  const db = fresh();
  const ctx: Ctx = { db, ownerId: null };
  await createTrip(ctx);
  const trip = (await getActiveTrip(db))!;
  await addItems(ctx, trip.id, 'task', ['SIMを設定する', '電車に乗る']);
  const items = await listItems(db, trip.id, 'task');
  await setItemStatus(ctx, items[0], 'done', '2026-11-29');
  await saveNote(ctx, { ...blankNote(trip.id, '2026-11-29'), body: '初日のメモ', tags: ['物価'] });
  await saveClip(ctx, { tripId: trip.id, localDate: '2026-11-29', questionId: 'q01', blob: new Blob(['voice-1'], { type: 'audio/webm' }), mimeType: 'audio/webm', ext: 'webm', durationMs: 1500 });
  return { db, ctx, trip };
}

async function rezip(blob: Blob, mutate: (z: JSZip) => Promise<void> | void) {
  const z = await JSZip.loadAsync(blob);
  await mutate(z);
  return z.generateAsync({ type: 'blob' });
}

describe('バックアップと復元', () => {
  it('A09：別領域に復元すると、テキスト・チェック状態・音声が一致する', async () => {
    const { db, trip } = await seeded();
    const { blob, manifest } = await buildBackup(db);
    expect(manifest.partial).toBe(false);
    expect(manifest.files).toHaveLength(1);
    const v = await validateBackup(blob);
    const target = fresh();
    await restoreInto(target, v);
    const items = await listItems(target, trip.id, 'task');
    expect(items.map((i) => [i.title, i.status, i.completedDate])).toEqual([
      ['SIMを設定する', 'done', '2026-11-29'],
      ['電車に乗る', 'open', null],
    ]);
    expect(alive(await target.notes.toArray())[0].body).toBe('初日のメモ');
    const d = await loadDiary(target, trip.id, '2026-11-29');
    const clip = d.clipsByQuestion.get('q01')![0];
    expect(await (await target.blobs.get(clip.blobId))!.blob.text()).toBe('voice-1');
    expect(d.questions).toHaveLength(8);
  });

  it('A10：壊れた ZIP・改ざん・想定外のパス・未知のバージョンを拒否し、既存データを変更しない', async () => {
    const { db } = await seeded();
    const { blob } = await buildBackup(db);
    const target = fresh();
    const tctx: Ctx = { db: target, ownerId: null };
    await createTrip(tctx, { name: '既存データ' });
    const before = await target.trips.count();

    const broken = new Blob([new Uint8Array(await blob.arrayBuffer()).slice(0, 200)]);
    await expect(validateBackup(broken)).rejects.toThrow(/ZIP/);
    await expect(validateBackup(new Blob(['not a zip']))).rejects.toThrow(/ZIP/);

    const tampered = await rezip(blob, async (z) => {
      const name = Object.values(z.files).find((f) => !f.dir && f.name.startsWith('media/audio/'))!.name;
      z.file(name, 'voice-X');
    });
    await expect(validateBackup(tampered)).rejects.toThrow(/ハッシュ|サイズ/);

    const traversal = await rezip(blob, (z) => void z.file('../evil.txt', 'x'));
    await expect(validateBackup(traversal)).rejects.toThrow(/想定外/);

    const future = await rezip(blob, async (z) => {
      const m = JSON.parse(await z.file('manifest.json')!.async('string'));
      m.schemaVersion = 99;
      z.file('manifest.json', JSON.stringify(m));
    });
    await expect(validateBackup(future)).rejects.toThrow(/未対応/);

    const badJson = await rezip(blob, (z) => void z.file('backup.json', '{oops'));
    await expect(validateBackup(badJson)).rejects.toThrow(/JSON/);

    const missingRef = await rezip(blob, async (z) => {
      const d = JSON.parse(await z.file('backup.json')!.async('string'));
      d.tables.dailyLogs = [];
      z.file('backup.json', JSON.stringify(d));
    });
    await expect(validateBackup(missingRef)).rejects.toThrow(/参照先/);

    expect(await target.trips.count()).toBe(before);
    expect((await target.trips.toArray())[0].name).toBe('既存データ');
  });

  it('復元した旅行を新しい旅行 ID でクラウド領域に写すと、参照が付け替わり送信待ちになる', async () => {
    const { db, trip } = await seeded();
    const cloud = fresh();
    const cctx: Ctx = { db: cloud, ownerId: '00000000-0000-4000-8000-000000000001' };
    const newTrip = await copyTripAsNew(db, trip.id, cctx, '復旧した旅行');
    expect(newTrip).not.toBe(trip.id);
    const d = await loadDiary(cloud, newTrip, '2026-11-29');
    expect(d.clipsByQuestion.get('q01')).toHaveLength(1);
    const clip = d.clipsByQuestion.get('q01')![0];
    expect(await (await cloud.blobs.get(clip.blobId))!.blob.text()).toBe('voice-1');
    expect((await listItems(cloud, newTrip, 'task'))[0].status).toBe('done');
    const ops = await cloud.outbox.toArray();
    expect(ops.length).toBeGreaterThan(10);
    expect(ops.every((o) => o.baseRevision === 0 && o.tripId === newTrip)).toBe(true);
  });
});
