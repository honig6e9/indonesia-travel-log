import type { TravelDB } from '../../db/db';
import { alive, transact, type Ctx } from '../../db/repo';
import type { Note } from '../../db/types';
import { newId } from '../../lib/ids';

export const NOTE_CATEGORIES = ['生活', '物価', '交流', '外国人材', '観光・移動', '語学', '自分の変化', '記事ネタ', 'その他'];

export function blankNote(tripId: string, localDate: string): Note {
  return {
    id: newId(),
    tripId,
    localDate,
    body: '',
    category: 'その他',
    tags: [],
    evidenceType: '',
    visibility: 'unchecked',
    location: null,
    createdAt: '',
    updatedAt: '',
  };
}

export async function saveNote(ctx: Ctx, note: Note) {
  return transact(ctx, (w) => w.put('note', note));
}

export async function deleteNote(ctx: Ctx, id: string) {
  await transact(ctx, async (w) => {
    await w.remove('note', id);
    // 項目との結びつきも外す（項目そのものは消さない）
    for (const l of alive(await ctx.db.links.where('sourceId').equals(id).toArray())) if (l.sourceType === 'note') await w.remove('link', l.id);
  });
}

export async function notesOn(db: TravelDB, tripId: string, localDate: string) {
  return alive(await db.notes.where('[tripId+localDate]').equals([tripId, localDate]).toArray()).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

/** メモが結ばれている項目（やること・食べたいもの・行きたい場所）の ID */
export async function linkedItemIds(db: TravelDB, noteId: string): Promise<string[]> {
  return alive(await db.links.where('sourceId').equals(noteId).toArray())
    .filter((l) => l.sourceType === 'note' && l.targetType === 'checklistItem')
    .map((l) => l.targetId);
}

/** 項目に結ばれているメモ（新しい順） */
export async function notesLinkedTo(db: TravelDB, itemId: string): Promise<Note[]> {
  const ids = alive(await db.links.where('targetId').equals(itemId).toArray())
    .filter((l) => l.sourceType === 'note')
    .map((l) => l.sourceId);
  return alive((await db.notes.bulkGet(ids)).filter((n): n is Note => !!n)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** メモを保存し、結ぶ項目をこの一覧のとおりにする（外した項目のリンクは消す） */
export async function saveNoteWithLinks(ctx: Ctx, note: Note, itemIds: string[]) {
  await transact(ctx, async (w) => {
    await w.put('note', note);
    const links = alive(await ctx.db.links.where('sourceId').equals(note.id).toArray()).filter((l) => l.sourceType === 'note' && l.targetType === 'checklistItem');
    const want = new Set(itemIds);
    for (const l of links) if (!want.has(l.targetId)) await w.remove('link', l.id);
    const have = new Set(links.map((l) => l.targetId));
    for (const id of want)
      if (!have.has(id)) await w.put('link', { id: newId(), tripId: note.tripId, sourceType: 'note', sourceId: note.id, targetType: 'checklistItem', targetId: id, createdAt: '', updatedAt: '' });
  });
}
