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
  await transact(ctx, (w) => w.remove('note', id));
}

export async function notesOn(db: TravelDB, tripId: string, localDate: string) {
  return alive(await db.notes.where('[tripId+localDate]').equals([tripId, localDate]).toArray()).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}
