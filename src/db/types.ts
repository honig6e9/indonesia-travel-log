// 旅行データの型。クラウド同期の対象（EntityType）と端末固有のものを分ける。

export type Visibility = 'unchecked' | 'candidate' | 'private';
export const VISIBILITY_LABEL: Record<Visibility, string> = {
  unchecked: '未確認',
  candidate: '公開候補',
  private: '非公開',
};

export interface BaseRecord {
  id: string;
  tripId: string;
  createdAt: string; // ISO 8601 UTC
  updatedAt: string; // ISO 8601 UTC
  deletedAt?: string | null; // 墓石（同期のため物理削除しない）
}

export interface Trip extends BaseRecord {
  name: string;
  startDate: string; // YYYY-MM-DD
  endDate: string;
  timeZone: string;
  /** 手動の換算レート：1 IDR あたりの JPY（任意） */
  jpyPerIdr?: number | null;
  rateDate?: string | null;
}

export interface QuestionTemplate extends BaseRecord {
  questionId: string; // 旅行内で安定（q01 など）
  title: string;
  hints: string[];
  sortOrder: number;
  enabled: boolean;
}

export interface QuestionSnapshot {
  questionId: string;
  title: string;
  hints: string[];
}

export interface Ratings {
  adaptation?: number | null; // 生活への慣れ
  language?: number | null; // 語学の通用感
  satisfaction?: number | null; // 満足度
  fatigue?: number | null; // 疲労
  homesick?: number | null; // 日本に帰りたい気持ち
}

export interface DailyLog extends BaseRecord {
  localDate: string;
  questionSnapshots: QuestionSnapshot[];
  ratings?: Ratings | null;
  conversationMinutes?: number | null;
  /** 最後に開いていた質問（再開用） */
  lastQuestionId?: string | null;
}

export interface Answer extends BaseRecord {
  dailyLogId: string;
  questionId: string;
  /** open=通常, skipped=スキップ。「回答済み」は録音か補足メモの有無で判定する */
  status: 'open' | 'skipped';
  note: string;
  visibility: Visibility;
  tags: string[];
  sortOrder: number;
}

export interface AudioClip extends BaseRecord {
  answerId: string | null; // 自由録音は null
  dailyLogId: string;
  localDate: string;
  questionId: string | null;
  blobId: string;
  durationMs: number;
  mimeType: string;
  ext: string;
  size: number;
  sha256: string;
  interrupted: boolean;
  sortOrder: number;
}

export type ChecklistType = 'task' | 'food';
export type TaskStatus = 'open' | 'done' | 'skipped';
export type Priority = 'high' | 'normal' | 'low';

export interface ChecklistItem extends BaseRecord {
  type: ChecklistType;
  title: string;
  category: string;
  area: string;
  plannedDate?: string | null;
  status: TaskStatus; // food は open=未体験, done=食べた, skipped=見送り
  completedDate?: string | null;
  priority: Priority;
  localName?: string | null;
  targetPrice?: number | null;
  note: string;
  sortOrder: number;
  visibility: Visibility;
}

export interface FoodExperience extends BaseRecord {
  checklistItemId: string;
  localDate: string;
  shop: string;
  price?: number | null;
  currency: Currency;
  rating?: number | null;
  comment: string;
  revisit?: boolean | null;
  expenseId?: string | null;
  visibility: Visibility;
  /** 「食べた」チェックで自動作成された初回レコード */
  auto?: boolean;
}

export type EvidenceType = '' | 'fact' | 'hearsay' | 'opinion' | 'unverified';
export const EVIDENCE_LABEL: Record<EvidenceType, string> = {
  '': '指定なし',
  fact: '事実',
  hearsay: '伝聞',
  opinion: '感想',
  unverified: '未確認',
};

export interface Note extends BaseRecord {
  localDate: string;
  body: string;
  category: string;
  tags: string[];
  evidenceType: EvidenceType;
  visibility: Visibility;
  location?: string | null;
}

export type Currency = 'IDR' | 'JPY';

export interface Expense extends BaseRecord {
  localDate: string;
  amount: number; // 非負整数
  currency: Currency;
  personalAmount?: number | null; // 自分の負担額
  category: string;
  shop: string;
  partySize?: number | null;
  paymentMethod: string;
  note: string;
  kind: 'expense' | 'refund';
  receiptMediaId?: string | null;
}

export interface Media extends BaseRecord {
  localDate: string;
  blobId: string;
  thumbnailBlobId?: string | null;
  mimeType: string;
  ext: string;
  size: number;
  sha256: string;
  capturedAt?: string | null;
  caption: string;
  category: string;
  tags: string[];
  visibility: Visibility;
  /** クラウドには容量節約用の圧縮版だけがある */
  cloudCompressed?: boolean;
}

export interface Link extends BaseRecord {
  sourceType: EntityType;
  sourceId: string;
  targetType: EntityType;
  targetId: string;
}

export type EntityType =
  | 'trip'
  | 'questionTemplate'
  | 'dailyLog'
  | 'answer'
  | 'audioClip'
  | 'checklistItem'
  | 'foodExperience'
  | 'note'
  | 'expense'
  | 'media'
  | 'link';

export interface EntityMap {
  trip: Trip;
  questionTemplate: QuestionTemplate;
  dailyLog: DailyLog;
  answer: Answer;
  audioClip: AudioClip;
  checklistItem: ChecklistItem;
  foodExperience: FoodExperience;
  note: Note;
  expense: Expense;
  media: Media;
  link: Link;
}

export const ENTITY_TABLE = {
  trip: 'trips',
  questionTemplate: 'questionTemplates',
  dailyLog: 'dailyLogs',
  answer: 'answers',
  audioClip: 'audioClips',
  checklistItem: 'checklistItems',
  foodExperience: 'foodExperiences',
  note: 'notes',
  expense: 'expenses',
  media: 'media',
  link: 'links',
} as const satisfies Record<EntityType, string>;

export const ENTITY_TYPES = Object.keys(ENTITY_TABLE) as EntityType[];

/** 同期の送信順（親を先に送る） */
export const ENTITY_ORDER: Record<EntityType, number> = {
  trip: 0,
  questionTemplate: 1,
  dailyLog: 2,
  answer: 3,
  checklistItem: 3,
  note: 3,
  media: 4,
  audioClip: 4,
  expense: 5,
  foodExperience: 6,
  link: 7,
};

// ---- 端末固有 ----

export interface BlobRow {
  id: string;
  blob: Blob;
  size: number;
  mimeType: string;
  sha256: string;
  ext: string;
  /** 1=クラウドへ送信済み（または他端末から取得した） */
  uploaded: 0 | 1;
}

export interface LocalOriginal {
  mediaId: string;
  blobId: string;
}

export interface OutboxOp {
  seq?: number;
  operationId: string;
  ownerId: string;
  entityType: EntityType;
  entityId: string;
  tripId: string;
  baseRevision: number;
  basePayload: Record<string, unknown> | null;
  desiredPayload: Record<string, unknown>;
  deleted: boolean;
  groupId: string | null;
  blobIds: string[];
  attempts: number;
  lastError: string | null;
  status: 'pending' | 'sending' | 'conflict' | 'error';
  nextAttemptAt: number;
}

export interface SyncStateRow {
  key: string; // `${entityType}:${entityId}`
  revision: number;
  basePayload: Record<string, unknown> | null;
}

export interface ConflictRow {
  id: string;
  entityType: EntityType;
  entityId: string;
  base: Record<string, unknown> | null;
  local: Record<string, unknown>;
  server: Record<string, unknown> | null;
  serverRevision: number;
  fields: string[];
  status: 'open' | 'resolved';
  createdAt: string;
}

export interface RecordingDraft {
  id: string;
  dailyLogId: string;
  localDate: string;
  questionId: string | null;
  answerId: string | null;
  mimeType: string;
  ext: string;
  chunks: Blob[];
  startedAt: string;
  updatedAt: string;
}

export interface SettingRow {
  key: string;
  value: unknown;
}

/** 通訳の 1 件（端末固有。受付と結果は Supabase の interpret_jobs にもある） */
export interface Interpretation {
  id: string;
  createdAt: string;
  mode: 'auto' | 'ja-id' | 'id-ja';
  audio?: Blob | null;
  mimeType?: string | null;
  ext?: string | null;
  audioPath?: string | null;
  durationMs?: number | null;
  inputText?: string | null;
  /** local=未送信, queued=受付済み, processing=PC で処理中, done=完了, error=失敗 */
  status: 'local' | 'queued' | 'processing' | 'done' | 'error';
  sourceLang?: string | null;
  sourceText?: string | null;
  targetLang?: string | null;
  targetText?: string | null;
  reading?: string | null;
  provider?: string | null;
  error?: string | null;
  /** pc=家の PC, google=Google 翻訳で代わりに訳した */
  via?: 'pc' | 'google' | null;
}
