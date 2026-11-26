import { v4 as uuidv4, v5 as uuidv5 } from 'uuid';

// 決定的 ID の名前空間（このアプリ専用。変更しないこと）
export const APP_NAMESPACE = '6f1c2b0e-8d3a-4f6e-9b6a-2a7d1c9e5f40';

export const newId = (): string => uuidv4();

const det = (name: string) => uuidv5(name, APP_NAMESPACE);

/** 日記は (tripId, localDate) から決まる */
export const dailyLogId = (tripId: string, localDate: string) => det(`dailyLog:${tripId}:${localDate}`);
/** 回答は (dailyLogId, questionId) から決まる */
export const answerId = (dailyLogIdValue: string, questionId: string) => det(`answer:${dailyLogIdValue}:${questionId}`);
/** 質問テンプレートは (tripId, questionId) から決まる */
export const templateId = (tripId: string, questionId: string) => det(`template:${tripId}:${questionId}`);
/** 「食べた」チェックで作る初回の実食 */
export const firstExperienceId = (checklistItemId: string) => det(`firstExperience:${checklistItemId}`);
/** 実食から自動作成する支出 */
export const experienceExpenseId = (experienceId: string) => det(`experienceExpense:${experienceId}`);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: unknown): s is string => typeof s === 'string' && UUID_RE.test(s);
