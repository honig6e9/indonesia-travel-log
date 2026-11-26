import type { TravelDB } from '../../db/db';
import { alive, transact, type Ctx, type Writer } from '../../db/repo';
import type { Answer, AudioClip, DailyLog, QuestionSnapshot } from '../../db/types';
import { answerId as detAnswerId, dailyLogId as detDailyLogId, newId } from '../../lib/ids';
import { sha256Hex } from '../../lib/hash';
import { listTemplates } from '../daily/tripRepo';

export async function getDailyLog(db: TravelDB, tripId: string, localDate: string) {
  const log = await db.dailyLogs.get(detDailyLogId(tripId, localDate));
  return log && !log.deletedAt ? log : undefined;
}

/** その日の質問：日記があればスナップショット、なければ現在のテンプレート */
export async function questionsFor(db: TravelDB, tripId: string, localDate: string): Promise<QuestionSnapshot[]> {
  const log = await getDailyLog(db, tripId, localDate);
  if (log) return log.questionSnapshots;
  const tpls = await listTemplates(db, tripId);
  return tpls.filter((t) => t.enabled).map((t) => ({ questionId: t.questionId, title: t.title, hints: t.hints }));
}

/** 記録を始めた時点の質問文を日記に保存する（後のテンプレート編集で書き換えない） */
export async function ensureDailyLog(w: Writer, db: TravelDB, tripId: string, localDate: string): Promise<DailyLog> {
  const id = detDailyLogId(tripId, localDate);
  const existing = await w.get('dailyLog', id);
  if (existing && !existing.deletedAt) return existing;
  const tpls = await listTemplates(db, tripId);
  return w.put('dailyLog', {
    id,
    tripId,
    localDate,
    questionSnapshots: tpls
      .filter((t) => t.enabled)
      .map((t) => ({ questionId: t.questionId, title: t.title, hints: [...t.hints] })),
    ratings: existing?.ratings ?? null,
    conversationMinutes: existing?.conversationMinutes ?? null,
    createdAt: existing?.createdAt ?? '',
    updatedAt: '',
  });
}

async function ensureAnswer(w: Writer, log: DailyLog, questionId: string): Promise<Answer> {
  const id = detAnswerId(log.id, questionId);
  const existing = await w.get('answer', id);
  if (existing && !existing.deletedAt) return existing;
  const order = log.questionSnapshots.findIndex((q) => q.questionId === questionId);
  return w.put('answer', {
    id,
    tripId: log.tripId,
    dailyLogId: log.id,
    questionId,
    status: 'open',
    note: '',
    visibility: 'unchecked',
    tags: [],
    sortOrder: order < 0 ? 999 : order,
    createdAt: existing?.createdAt ?? '',
    updatedAt: '',
  });
}

export interface NewClip {
  tripId: string;
  localDate: string;
  questionId: string | null;
  blob: Blob;
  mimeType: string;
  ext: string;
  durationMs: number;
  interrupted?: boolean;
}

/** 音声 Blob・メタデータ・outbox を 1 つのトランザクションで保存する */
export async function saveClip(ctx: Ctx, c: NewClip): Promise<AudioClip> {
  const sha256 = await sha256Hex(c.blob); // トランザクションの外で計算する
  const blobId = newId();
  return transact(ctx, async (w) => {
    const log = await ensureDailyLog(w, ctx.db, c.tripId, c.localDate);
    let answerIdValue: string | null = null;
    if (c.questionId) {
      const ans = await ensureAnswer(w, log, c.questionId);
      answerIdValue = ans.id;
      if (ans.status === 'skipped') await w.put('answer', { ...ans, status: 'open' });
    }
    await w.putBlob({ id: blobId, blob: c.blob, size: c.blob.size, mimeType: c.mimeType, sha256, ext: c.ext, uploaded: 0 });
    const siblings = await ctx.db.audioClips.where('dailyLogId').equals(log.id).count();
    return w.put('audioClip', {
      id: newId(),
      tripId: c.tripId,
      answerId: answerIdValue,
      dailyLogId: log.id,
      localDate: c.localDate,
      questionId: c.questionId,
      blobId,
      durationMs: Math.round(c.durationMs),
      mimeType: c.mimeType,
      ext: c.ext,
      size: c.blob.size,
      sha256,
      interrupted: c.interrupted ?? false,
      sortOrder: siblings,
      createdAt: '',
      updatedAt: '',
    });
  });
}

export async function removeClip(ctx: Ctx, clipId: string) {
  // Blob 本体は残す（参照確認後の明示的な整理でのみ消す）
  await transact(ctx, (w) => w.remove('audioClip', clipId));
}

export async function setAnswerNote(ctx: Ctx, tripId: string, localDate: string, questionId: string, note: string) {
  await transact(ctx, async (w) => {
    const log = await ensureDailyLog(w, ctx.db, tripId, localDate);
    const ans = await ensureAnswer(w, log, questionId);
    if (ans.note !== note) await w.put('answer', { ...ans, note });
  });
}

export async function updateAnswer(ctx: Ctx, ans: Answer, patch: Partial<Answer>) {
  await transact(ctx, (w) => w.put('answer', { ...ans, ...patch }));
}

export async function setSkipped(ctx: Ctx, tripId: string, localDate: string, questionId: string, skipped: boolean) {
  await transact(ctx, async (w) => {
    const log = await ensureDailyLog(w, ctx.db, tripId, localDate);
    const ans = await ensureAnswer(w, log, questionId);
    const status = skipped ? 'skipped' : 'open';
    if (ans.status !== status) await w.put('answer', { ...ans, status });
  });
}

export async function saveRatings(ctx: Ctx, tripId: string, localDate: string, patch: Partial<DailyLog>) {
  await transact(ctx, async (w) => {
    const log = await ensureDailyLog(w, ctx.db, tripId, localDate);
    await w.put('dailyLog', { ...log, ...patch });
  });
}

export interface DiaryState {
  log: DailyLog | undefined;
  questions: QuestionSnapshot[];
  answers: Map<string, Answer>;
  clips: AudioClip[];
  clipsByQuestion: Map<string, AudioClip[]>;
  freeClips: AudioClip[];
  answeredIds: Set<string>;
  skippedIds: Set<string>;
}

export async function loadDiary(db: TravelDB, tripId: string, localDate: string): Promise<DiaryState> {
  const log = await getDailyLog(db, tripId, localDate);
  const questions = await questionsFor(db, tripId, localDate);
  const answers = new Map<string, Answer>();
  let clips: AudioClip[] = [];
  if (log) {
    for (const a of alive(await db.answers.where('dailyLogId').equals(log.id).toArray())) answers.set(a.questionId, a);
    clips = alive(await db.audioClips.where('dailyLogId').equals(log.id).toArray()).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }
  const clipsByQuestion = new Map<string, AudioClip[]>();
  const freeClips: AudioClip[] = [];
  for (const c of clips) {
    if (!c.questionId) freeClips.push(c);
    else clipsByQuestion.set(c.questionId, [...(clipsByQuestion.get(c.questionId) ?? []), c]);
  }
  const answeredIds = new Set<string>();
  const skippedIds = new Set<string>();
  for (const q of questions) {
    const a = answers.get(q.questionId);
    const has = (clipsByQuestion.get(q.questionId)?.length ?? 0) > 0 || !!a?.note.trim();
    if (has) answeredIds.add(q.questionId);
    else if (a?.status === 'skipped') skippedIds.add(q.questionId);
  }
  return { log, questions, answers, clips, clipsByQuestion, freeClips, answeredIds, skippedIds };
}
