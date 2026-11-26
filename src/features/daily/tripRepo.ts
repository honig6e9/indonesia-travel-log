import { getSetting, setSetting, type TravelDB } from '../../db/db';
import { alive, transact, type Ctx } from '../../db/repo';
import type { QuestionTemplate, Trip } from '../../db/types';
import { newId, templateId } from '../../lib/ids';

export const DEFAULT_TRIP = {
  name: 'インドネシア滞在 2026',
  startDate: '2026-11-29',
  endDate: '2026-12-28',
  timeZone: 'Asia/Jakarta',
};

export const DEFAULT_QUESTIONS: { questionId: string; title: string; hints: string[] }[] = [
  { questionId: 'q01', title: '今日はどこで何をした？', hints: ['場所・移動手段', '印象に残った出来事'] },
  { questionId: 'q02', title: '何を食べ、何を買った？', hints: ['料理名・店・味', '値段・量', '再訪したいか'] },
  { questionId: 'q03', title: '誰とどんな話をした？', hints: ['印象に残った会話は？', '相手の考え方や価値観は？', '自分が感じたことは？'] },
  { questionId: 'q04', title: '日本との違い・現地の日常で気づいたことは？', hints: ['生活習慣・交通・接客', '価値観', '前回との違い'] },
  { questionId: 'q05', title: '驚き・疑問・発見は？', hints: ['事実として確認できたこと', 'まだ分からないこと'] },
  { questionId: 'q06', title: '困ったこと・失敗と、その対処は？', hints: ['原因', '解決方法', '次の旅行者に伝えたいこと'] },
  { questionId: 'q07', title: '今日使ったインドネシア語は？', hints: ['通じた言葉', '通じなかった言葉', '会話の場面'] },
  { questionId: 'q08', title: '今日の気持ちと、今後の記事ネタは？', hints: ['心境・疲労', '生活への慣れ', '書きたいテーマ'] },
];

export async function createTrip(ctx: Ctx, partial: Partial<typeof DEFAULT_TRIP> = {}): Promise<Trip> {
  const id = newId();
  return transact(ctx, async (w) => {
    const trip = await w.put('trip', {
      id,
      tripId: id,
      ...DEFAULT_TRIP,
      ...partial,
      jpyPerIdr: null,
      rateDate: null,
      createdAt: '',
      updatedAt: '',
    });
    for (const [i, q] of DEFAULT_QUESTIONS.entries()) {
      await w.put('questionTemplate', {
        id: templateId(id, q.questionId),
        tripId: id,
        questionId: q.questionId,
        title: q.title,
        hints: q.hints,
        sortOrder: i,
        enabled: true,
        createdAt: '',
        updatedAt: '',
      });
    }
    return trip;
  });
}

export async function listTrips(db: TravelDB): Promise<Trip[]> {
  return alive(await db.trips.toArray()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getActiveTrip(db: TravelDB): Promise<Trip | null> {
  const trips = await listTrips(db);
  if (trips.length === 0) return null;
  const id = await getSetting<string | null>(db, 'activeTripId', null);
  return trips.find((t) => t.id === id) ?? trips[0];
}

export async function setActiveTrip(db: TravelDB, tripId: string) {
  await setSetting(db, 'activeTripId', tripId);
}

export async function listTemplates(db: TravelDB, tripId: string): Promise<QuestionTemplate[]> {
  return alive(await db.questionTemplates.where('tripId').equals(tripId).toArray()).sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
}

export async function updateTrip(ctx: Ctx, trip: Trip, patch: Partial<Trip>) {
  await transact(ctx, (w) => w.put('trip', { ...trip, ...patch }));
}

export async function saveTemplate(ctx: Ctx, tpl: QuestionTemplate) {
  await transact(ctx, (w) => w.put('questionTemplate', tpl));
}

export async function addTemplate(ctx: Ctx, tripId: string, title: string, hints: string[], sortOrder: number) {
  const questionId = 'c' + newId().slice(0, 8);
  await transact(ctx, (w) =>
    w.put('questionTemplate', {
      id: templateId(tripId, questionId),
      tripId,
      questionId,
      title,
      hints,
      sortOrder,
      enabled: true,
      createdAt: '',
      updatedAt: '',
    }),
  );
}

export async function reorderTemplates(ctx: Ctx, tpls: QuestionTemplate[]) {
  await transact(ctx, async (w) => {
    for (const [i, t] of tpls.entries()) if (t.sortOrder !== i) await w.put('questionTemplate', { ...t, sortOrder: i });
  });
}
