// メモとやることの結びつき
import { describe, expect, it } from 'vitest';
import { TravelDB } from '../db/db';
import { createTrip } from '../features/daily/tripRepo';
import { addItems, listItems } from '../features/checklist/checklistRepo';
import { blankNote, deleteNote, linkedItemIds, notesLinkedTo, saveNoteWithLinks } from '../features/notes/notesRepo';

describe('メモをやることに結ぶ', () => {
  it('結ぶ・外す・項目側から見る・メモを消すと結びつきも消える', async () => {
    const db = new TravelDB('note-links');
    const ctx = { db, ownerId: null };
    const trip = await createTrip(ctx);
    await addItems(ctx, trip.id, 'task', ['KRLに乗る', 'Monasに行く']);
    const [krl, monas] = await listItems(db, trip.id, 'task');
    const note = { ...blankNote(trip.id, '2026-12-01'), body: '切符は駅の窓口で' };

    await saveNoteWithLinks(ctx, note, [krl.id, monas.id]);
    expect((await linkedItemIds(db, note.id)).sort()).toEqual([krl.id, monas.id].sort());
    expect((await notesLinkedTo(db, krl.id)).map((n) => n.body)).toEqual(['切符は駅の窓口で']);

    // 1 つ外す（何度保存しても増えない）
    await saveNoteWithLinks(ctx, note, [krl.id]);
    await saveNoteWithLinks(ctx, note, [krl.id]);
    expect(await linkedItemIds(db, note.id)).toEqual([krl.id]);
    expect(await notesLinkedTo(db, monas.id)).toEqual([]);

    await deleteNote(ctx, note.id);
    expect(await linkedItemIds(db, note.id)).toEqual([]);
    expect(await notesLinkedTo(db, krl.id)).toEqual([]);
    expect((await listItems(db, trip.id, 'task')).length).toBe(2); // 項目は消さない
  });
});
