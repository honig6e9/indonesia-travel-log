import Dexie, { type Table } from 'dexie';
import type {
  Answer,
  AudioClip,
  BlobRow,
  ChecklistItem,
  ConflictRow,
  DailyLog,
  Expense,
  FoodExperience,
  Link,
  LocalOriginal,
  Media,
  Note,
  OutboxOp,
  QuestionTemplate,
  RecordingDraft,
  SettingRow,
  SyncStateRow,
  Trip,
} from './types';

export const DB_BASE_NAME = 'indonesia-travel-log';
export const SCHEMA_VERSION = 1;

/**
 * 1 つの「領域（ワークスペース）」の DB。
 * ローカル専用・アカウントごと・復元用で DB を分け、ユーザー ID で隔離する。
 * スキーマを変えるときは version を足し、既存データを消すマイグレーションは書かない。
 */
export class TravelDB extends Dexie {
  trips!: Table<Trip, string>;
  questionTemplates!: Table<QuestionTemplate, string>;
  dailyLogs!: Table<DailyLog, string>;
  answers!: Table<Answer, string>;
  audioClips!: Table<AudioClip, string>;
  checklistItems!: Table<ChecklistItem, string>;
  foodExperiences!: Table<FoodExperience, string>;
  notes!: Table<Note, string>;
  expenses!: Table<Expense, string>;
  media!: Table<Media, string>;
  links!: Table<Link, string>;
  blobs!: Table<BlobRow, string>;
  localOriginals!: Table<LocalOriginal, string>;
  settings!: Table<SettingRow, string>;
  outbox!: Table<OutboxOp, number>;
  syncState!: Table<SyncStateRow, string>;
  syncMeta!: Table<SettingRow, string>;
  conflicts!: Table<ConflictRow, string>;
  drafts!: Table<RecordingDraft, string>;

  constructor(name: string) {
    super(name);
    this.version(SCHEMA_VERSION).stores({
      trips: 'id',
      questionTemplates: 'id, tripId',
      dailyLogs: 'id, tripId, [tripId+localDate]',
      answers: 'id, tripId, dailyLogId, [dailyLogId+questionId]',
      audioClips: 'id, tripId, dailyLogId, answerId, blobId, localDate',
      checklistItems: 'id, tripId, [tripId+type]',
      foodExperiences: 'id, tripId, checklistItemId, localDate, expenseId',
      notes: 'id, tripId, [tripId+localDate]',
      expenses: 'id, tripId, [tripId+localDate]',
      media: 'id, tripId, [tripId+localDate], blobId',
      links: 'id, tripId, sourceId, targetId',
      blobs: 'id, uploaded',
      localOriginals: 'mediaId, blobId',
      settings: 'key',
      outbox: '++seq, &operationId, [entityType+entityId], status, groupId',
      syncState: 'key',
      syncMeta: 'key',
      conflicts: 'id, [entityType+entityId], status',
      drafts: 'id, dailyLogId',
    });
  }
}

export const RECORD_TABLES = [
  'trips',
  'questionTemplates',
  'dailyLogs',
  'answers',
  'audioClips',
  'checklistItems',
  'foodExperiences',
  'notes',
  'expenses',
  'media',
  'links',
] as const;
export type RecordTableName = (typeof RECORD_TABLES)[number];

// ---- 領域（ワークスペース）の管理 ----

export type WorkspaceKind = 'local' | 'cloud' | 'restore';

export interface Workspace {
  id: string;
  kind: WorkspaceKind;
  ownerId: string | null;
  email?: string | null;
  label: string;
  dbName: string;
  createdAt: string;
}

class MetaDB extends Dexie {
  workspaces!: Table<Workspace, string>;
  kv!: Table<SettingRow, string>;
  constructor() {
    super(DB_BASE_NAME + '-meta');
    this.version(1).stores({ workspaces: 'id, kind, ownerId', kv: 'key' });
  }
}

export const metaDb = new MetaDB();

export const LOCAL_WORKSPACE_ID = 'local';

export function cloudWorkspaceId(ownerId: string) {
  return 'u_' + ownerId;
}

export async function ensureLocalWorkspace(): Promise<Workspace> {
  const existing = await metaDb.workspaces.get(LOCAL_WORKSPACE_ID);
  if (existing) return existing;
  const ws: Workspace = {
    id: LOCAL_WORKSPACE_ID,
    kind: 'local',
    ownerId: null,
    label: 'この端末だけ（ローカル）',
    dbName: DB_BASE_NAME,
    createdAt: new Date().toISOString(),
  };
  await metaDb.workspaces.put(ws);
  return ws;
}

export async function ensureCloudWorkspace(ownerId: string, email: string | null): Promise<Workspace> {
  const id = cloudWorkspaceId(ownerId);
  const existing = await metaDb.workspaces.get(id);
  if (existing) {
    if (email && existing.email !== email) await metaDb.workspaces.update(id, { email });
    return { ...existing, email: email ?? existing.email };
  }
  const ws: Workspace = {
    id,
    kind: 'cloud',
    ownerId,
    email,
    label: `アカウント ${email ?? ''}`.trim(),
    dbName: `${DB_BASE_NAME}__u_${ownerId}`,
    createdAt: new Date().toISOString(),
  };
  await metaDb.workspaces.put(ws);
  return ws;
}

export async function createRestoreWorkspace(label: string): Promise<Workspace> {
  const id = 'restore_' + crypto.randomUUID();
  const ws: Workspace = {
    id,
    kind: 'restore',
    ownerId: null,
    label,
    dbName: `${DB_BASE_NAME}__${id}`,
    createdAt: new Date().toISOString(),
  };
  await metaDb.workspaces.put(ws);
  return ws;
}

export async function getActiveWorkspaceId(): Promise<string | null> {
  return ((await metaDb.kv.get('activeWorkspaceId'))?.value as string | undefined) ?? null;
}

export async function setActiveWorkspaceId(id: string) {
  await metaDb.kv.put({ key: 'activeWorkspaceId', value: id });
}

const openDbs = new Map<string, TravelDB>();
export function openWorkspaceDb(ws: Workspace): TravelDB {
  let db = openDbs.get(ws.dbName);
  if (!db) {
    db = new TravelDB(ws.dbName);
    openDbs.set(ws.dbName, db);
  }
  return db;
}

export async function deleteWorkspace(ws: Workspace) {
  const db = openDbs.get(ws.dbName);
  if (db) {
    db.close();
    openDbs.delete(ws.dbName);
  }
  await Dexie.delete(ws.dbName);
  await metaDb.workspaces.delete(ws.id);
}

// 端末ごとの設定（同期しない）
export async function getSetting<T>(db: TravelDB, key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key);
  return row === undefined ? fallback : (row.value as T);
}
export async function setSetting(db: TravelDB, key: string, value: unknown) {
  await db.settings.put({ key, value });
}
