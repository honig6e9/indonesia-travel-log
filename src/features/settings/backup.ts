// 全データ ZIP（復元用）の作成・検証・復元。
// 復元は必ず検証してから、単一の IndexedDB 書込みトランザクションで行う。失敗すれば既存データは変わらない。

import JSZip from 'jszip';
import { RECORD_TABLES, SCHEMA_VERSION, type RecordTableName, type TravelDB } from '../../db/db';
import { ALL_TABLES, transact, type Ctx } from '../../db/repo';
import type { AudioClip, BlobRow, ConflictRow, Media, OutboxOp, Trip } from '../../db/types';
import { sha256Hex } from '../../lib/hash';
import { isLocalDate } from '../../lib/dates';
import { answerId, dailyLogId, experienceExpenseId, firstExperienceId, isUuid, newId, templateId } from '../../lib/ids';
import { missingBlobs, type MissingBlob } from '../sync/engine';

export const BACKUP_FORMAT = 'indonesia-travel-log-backup';

export interface ManifestFile {
  path: string;
  blobId: string;
  kind: 'audio' | 'image' | 'original' | 'thumbnail';
  ref: string; // clipId / mediaId
  size: number;
  sha256: string;
  mimeType: string;
}

export interface Manifest {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  exportType: 'full';
  createdAt: string;
  appVersion: string;
  trips: Pick<Trip, 'id' | 'name' | 'startDate' | 'endDate' | 'timeZone'>[];
  counts: Record<string, number>;
  files: ManifestFile[];
  partial: boolean;
  missing: { blobId: string; kind: string; localDate: string }[];
  pendingChanges: number;
  openConflicts: number;
}

export interface BackupData {
  tables: Record<RecordTableName, Record<string, unknown>[]>;
  localOriginals: { mediaId: string; blobId: string }[];
  /** 私用：未送信の変更と競合の両版（復元時に再送はしない） */
  unsent: Pick<OutboxOp, 'entityType' | 'entityId' | 'desiredPayload' | 'deleted' | 'status' | 'lastError'>[];
  conflicts: ConflictRow[];
}

const AUDIO_EXT_RE = /^[a-z0-9]{1,8}$/;

function fileName(kind: ManifestFile['kind'], ref: string, ext: string) {
  const e = AUDIO_EXT_RE.test(ext) ? ext : 'bin';
  switch (kind) {
    case 'audio':
      return `media/audio/${ref}.${e}`;
    case 'image':
      return `media/images/${ref}.${e}`;
    case 'original':
      return `media/images/${ref}.original.${e}`;
    case 'thumbnail':
      return `media/thumbnails/${ref}.jpg`;
  }
}

export interface BackupPreflight {
  pending: number;
  conflicts: number;
  missing: MissingBlob[];
  totalBytes: number;
}

export async function backupPreflight(db: TravelDB): Promise<BackupPreflight> {
  const blobs = await db.blobs.toArray();
  return {
    pending: await db.outbox.count(),
    conflicts: await db.conflicts.where('status').equals('open').count(),
    missing: await missingBlobs(db),
    totalBytes: blobs.reduce((s, b) => s + b.size, 0),
  };
}

export async function buildBackup(db: TravelDB, appVersion = '0.1.0'): Promise<{ blob: Blob; manifest: Manifest }> {
  const tables = {} as BackupData['tables'];
  const counts: Record<string, number> = {};
  for (const t of RECORD_TABLES) {
    tables[t] = (await db.table(t).toArray()) as Record<string, unknown>[];
    counts[t] = tables[t].filter((r) => !r.deletedAt).length;
  }
  const outbox = await db.outbox.toArray();
  const data: BackupData = {
    tables,
    localOriginals: await db.localOriginals.toArray(),
    unsent: outbox.map((o) => ({
      entityType: o.entityType,
      entityId: o.entityId,
      desiredPayload: o.desiredPayload,
      deleted: o.deleted,
      status: o.status,
      lastError: o.lastError,
    })),
    conflicts: await db.conflicts.where('status').equals('open').toArray(),
  };

  const zip = new JSZip();
  const files: ManifestFile[] = [];
  const add = async (kind: ManifestFile['kind'], ref: string, blobId: string) => {
    const row = await db.blobs.get(blobId);
    if (!row) return false;
    const path = fileName(kind, ref, row.ext);
    if (files.some((f) => f.path === path)) return true;
    zip.file(path, row.blob, { binary: true, compression: 'STORE' });
    files.push({ path, blobId, kind, ref, size: row.size, sha256: row.sha256, mimeType: row.mimeType });
    return true;
  };
  const missing: Manifest['missing'] = [];
  for (const c of tables.audioClips as unknown as AudioClip[]) {
    if (!(await add('audio', c.id, c.blobId)) && !c.deletedAt) missing.push({ blobId: c.blobId, kind: 'audio', localDate: c.localDate });
  }
  for (const m of tables.media as unknown as Media[]) {
    if (!(await add('image', m.id, m.blobId)) && !m.deletedAt) missing.push({ blobId: m.blobId, kind: 'image', localDate: m.localDate });
    if (m.thumbnailBlobId) await add('thumbnail', m.id, m.thumbnailBlobId);
  }
  for (const o of data.localOriginals) await add('original', o.mediaId, o.blobId);

  const trips = (tables.trips as unknown as Trip[]).filter((t) => !t.deletedAt);
  const manifest: Manifest = {
    format: BACKUP_FORMAT,
    schemaVersion: SCHEMA_VERSION,
    exportType: 'full',
    createdAt: new Date().toISOString(),
    appVersion,
    trips: trips.map(({ id, name, startDate, endDate, timeZone }) => ({ id, name, startDate, endDate, timeZone })),
    counts,
    files,
    partial: missing.length > 0,
    missing,
    pendingChanges: outbox.length,
    openConflicts: data.conflicts.length,
  };
  zip.file('manifest.json', JSON.stringify(manifest, null, 2));
  zip.file('backup.json', JSON.stringify(data));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', streamFiles: true });
  return { blob, manifest };
}

// ---------- 検証 ----------

export interface ValidatedBackup {
  manifest: Manifest;
  data: BackupData;
  blobs: Map<string, BlobRow>;
  totalBytes: number;
  warnings: string[];
}

const LIMITS = {
  zipBytes: 4 * 1024 * 1024 * 1024,
  totalUncompressed: 4 * 1024 * 1024 * 1024,
  jsonBytes: 300 * 1024 * 1024,
  entries: 50000,
};
const ALLOWED_PATH = /^(manifest\.json|backup\.json|media\/(audio|images|thumbnails)\/[0-9a-f-]{36}(\.original)?\.[a-z0-9]{1,8})$/;

export class BackupError extends Error {}

export async function validateBackup(file: Blob): Promise<ValidatedBackup> {
  if (file.size > LIMITS.zipBytes) throw new BackupError('ZIP が大きすぎます。日別の出力などに分けてください');
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file, { checkCRC32: true });
  } catch {
    throw new BackupError('ZIP を読み込めません（壊れているか、ZIP ではありません）');
  }
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  if (entries.length > LIMITS.entries) throw new BackupError('ファイル数が多すぎます');
  let declared = 0;
  for (const e of entries) {
    if (!ALLOWED_PATH.test(e.name)) throw new BackupError(`想定外のファイルが含まれています: ${e.name.slice(0, 80)}`);
    const size = (e as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
    if (typeof size === 'number') declared += size;
  }
  if (declared > LIMITS.totalUncompressed) throw new BackupError('展開後のサイズが大きすぎます');

  const readJson = async (name: string) => {
    const f = zip.file(name);
    if (!f) throw new BackupError(`${name} がありません`);
    const size = (f as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize ?? 0;
    if (size > LIMITS.jsonBytes) throw new BackupError(`${name} が大きすぎます`);
    const text = await f.async('string');
    if (text.length > LIMITS.jsonBytes) throw new BackupError(`${name} が大きすぎます`);
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new BackupError(`${name} の JSON が不正です`);
    }
  };

  const manifest = (await readJson('manifest.json')) as Manifest;
  if (!manifest || manifest.format !== BACKUP_FORMAT) throw new BackupError('このアプリのバックアップではありません');
  if (typeof manifest.schemaVersion !== 'number' || manifest.schemaVersion > SCHEMA_VERSION || manifest.schemaVersion < 1)
    throw new BackupError(`未対応のバージョンです（schemaVersion ${manifest.schemaVersion}）。アプリを更新してください`);
  if (!Array.isArray(manifest.files)) throw new BackupError('manifest.json の形式が不正です');

  const data = (await readJson('backup.json')) as BackupData;
  if (!data || typeof data !== 'object' || !data.tables) throw new BackupError('backup.json の形式が不正です');
  // 版 2 までのバックアップには未整理ボックスがない
  if (manifest.schemaVersion < 3 && data.tables.inboxItems === undefined) data.tables.inboxItems = [];
  for (const t of RECORD_TABLES) {
    if (!Array.isArray(data.tables[t])) throw new BackupError(`backup.json に ${t} がありません`);
  }
  data.localOriginals = Array.isArray(data.localOriginals) ? data.localOriginals : [];
  data.unsent = Array.isArray(data.unsent) ? data.unsent : [];
  data.conflicts = Array.isArray(data.conflicts) ? data.conflicts : [];

  // レコードの検証：ID・重複・日付・参照
  const ids: Record<string, Set<string>> = {};
  for (const t of RECORD_TABLES) {
    const set = new Set<string>();
    for (const r of data.tables[t]) {
      if (!r || typeof r !== 'object' || !isUuid(r.id)) throw new BackupError(`${t} に不正な ID があります`);
      if (set.has(r.id as string)) throw new BackupError(`${t} に重複した ID があります`);
      set.add(r.id as string);
      if (!isUuid(r.tripId)) throw new BackupError(`${t} に旅行 ID のないレコードがあります`);
      if ('localDate' in r && !isLocalDate(r.localDate)) throw new BackupError(`${t} に不正な日付があります`);
    }
    ids[t] = set;
  }
  const warnings: string[] = [];
  const ref = (t: RecordTableName, field: string, target: RecordTableName, nullable = false) => {
    for (const r of data.tables[t]) {
      const v = r[field];
      if (v == null && nullable) continue;
      if (!ids[target].has(v as string)) throw new BackupError(`${t}.${field} の参照先がありません`);
    }
  };
  for (const t of RECORD_TABLES) if (t !== 'trips') ref(t, 'tripId', 'trips');
  ref('answers', 'dailyLogId', 'dailyLogs');
  ref('audioClips', 'dailyLogId', 'dailyLogs');
  ref('audioClips', 'answerId', 'answers', true);
  ref('foodExperiences', 'checklistItemId', 'checklistItems');
  for (const r of data.tables.foodExperiences) {
    if (r.expenseId && !ids.expenses.has(r.expenseId as string)) warnings.push('支出が見つからない実食があります（リンクのみ外れます）');
  }

  // ファイルの検証：存在・サイズ・SHA-256
  const blobs = new Map<string, BlobRow>();
  let totalBytes = 0;
  const missingSet = new Set((manifest.missing ?? []).map((m) => m.blobId));
  for (const f of manifest.files) {
    if (!ALLOWED_PATH.test(f.path) || !isUuid(f.blobId)) throw new BackupError('manifest.json のファイル情報が不正です');
    const entry = zip.file(f.path);
    if (!entry) throw new BackupError(`ファイルがありません: ${f.path}`);
    const ab = await entry.async('arraybuffer');
    if (ab.byteLength !== f.size) throw new BackupError(`ファイルのサイズが一致しません: ${f.path}`);
    if (f.sha256) {
      const sha = await sha256Hex(ab);
      if (sha !== f.sha256) throw new BackupError(`ファイルが壊れています（ハッシュ不一致）: ${f.path}`);
    }
    const ext = f.path.split('.').pop() ?? 'bin';
    blobs.set(f.blobId, {
      id: f.blobId,
      blob: new Blob([ab], { type: f.mimeType }),
      size: f.size,
      mimeType: f.mimeType,
      sha256: f.sha256,
      ext,
      uploaded: 0,
    });
    totalBytes += f.size;
  }
  for (const c of data.tables.audioClips) {
    if (c.deletedAt) continue;
    if (!blobs.has(c.blobId as string)) {
      if (missingSet.has(c.blobId as string)) continue;
      throw new BackupError('音声ファイルが不足しています');
    }
    if (c.sha256 && blobs.get(c.blobId as string)!.sha256 !== c.sha256) throw new BackupError('音声ファイルとレコードが一致しません');
  }
  for (const m of data.tables.media) {
    if (m.deletedAt) continue;
    if (!blobs.has(m.blobId as string) && !missingSet.has(m.blobId as string)) throw new BackupError('写真ファイルが不足しています');
  }
  if (manifest.partial) warnings.push(`部分バックアップです（取得できていないファイル ${manifest.missing.length} 件）`);
  if (data.unsent.length) warnings.push(`作成時点で未送信だった変更 ${data.unsent.length} 件を含みます（復元しても自動では送信しません）`);
  if (data.conflicts.length) warnings.push(`未解決の競合 ${data.conflicts.length} 件の両版を含みます`);
  return { manifest, data, blobs, totalBytes, warnings };
}

/**
 * 検証済みのバックアップで、同期していない領域（ローカル専用・復元用）を置き換える。
 * 単一の書込みトランザクションなので、途中で失敗すれば既存データは元のまま残る。
 */
export async function restoreInto(db: TravelDB, v: ValidatedBackup): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
    try {
      const est = await navigator.storage.estimate();
      if (est.quota && est.usage != null && est.quota - est.usage < v.totalBytes * 1.2)
        throw new BackupError('端末の空き容量が足りないため復元しません');
    } catch (e) {
      if (e instanceof BackupError) throw e;
    }
  }
  await db.transaction('rw', ALL_TABLES as unknown as string[], async () => {
    for (const t of RECORD_TABLES) await db.table(t).clear();
    await db.blobs.clear();
    await db.localOriginals.clear();
    await db.outbox.clear();
    await db.syncState.clear();
    await db.conflicts.clear();
    for (const t of RECORD_TABLES) await db.table(t).bulkPut(v.data.tables[t]);
    await db.blobs.bulkPut([...v.blobs.values()]);
    await db.localOriginals.bulkPut(v.data.localOriginals.filter((o) => v.blobs.has(o.blobId)));
    // 競合の両版は復元領域でも参照できるよう残す（送信はしない）
    await db.conflicts.bulkPut(v.data.conflicts.map((c) => ({ ...c, status: 'open' as const })));
  });
}

/**
 * ある領域の旅行を、新しい旅行 ID で別の領域（通常はクラウド同期中の領域）に写す。
 * 参照 ID はすべて付け替え、過去の operationId・revision は持ち込まない（新規レコードとして送る）。
 */
export async function copyTripAsNew(src: TravelDB, srcTripId: string, dst: Ctx, newName?: string): Promise<string> {
  const newTrip = newId();
  const map = new Map<string, string>();
  const blobMap = new Map<string, string>();
  const get = async <T>(t: RecordTableName) =>
    ((await src.table(t).where('tripId').equals(srcTripId).toArray()) as (T & { deletedAt?: string | null })[]).filter((r) => !r.deletedAt);
  const trip = (await src.trips.get(srcTripId))!;
  const templates = await get<import('../../db/types').QuestionTemplate>('questionTemplates');
  const logs = await get<import('../../db/types').DailyLog>('dailyLogs');
  const answers = (await src.answers.toArray()).filter((a) => !a.deletedAt && logs.some((l) => l.id === a.dailyLogId));
  const clips = await get<AudioClip>('audioClips');
  const items = await get<import('../../db/types').ChecklistItem>('checklistItems');
  const exps = await get<import('../../db/types').FoodExperience>('foodExperiences');
  const notes = await get<import('../../db/types').Note>('notes');
  const expenses = await get<import('../../db/types').Expense>('expenses');
  const media = await get<Media>('media');
  const links = await get<import('../../db/types').Link>('links');
  const inbox = await get<import('../../db/types').InboxItem>('inboxItems');
  const origs = await src.localOriginals.toArray();
  const conflicts = await src.conflicts.where('status').equals('open').toArray();

  map.set(trip.id, newTrip);
  for (const t of templates) map.set(t.id, templateId(newTrip, t.questionId));
  for (const l of logs) map.set(l.id, dailyLogId(newTrip, l.localDate));
  for (const a of answers) map.set(a.id, answerId(map.get(a.dailyLogId)!, a.questionId));
  for (const i of items) map.set(i.id, newId());
  for (const e of exps) map.set(e.id, e.id === firstExperienceId(e.checklistItemId) ? firstExperienceId(map.get(e.checklistItemId)!) : newId());
  for (const e of expenses) {
    const fromExp = exps.find((x) => x.expenseId === e.id && e.id === experienceExpenseId(x.id));
    map.set(e.id, fromExp ? experienceExpenseId(map.get(fromExp.id)!) : newId());
  }
  for (const r of [...clips, ...notes, ...media, ...inbox, ...links]) map.set(r.id, newId());
  const m = (id: string | null | undefined) => (id ? (map.get(id) ?? null) : null);
  const blobOut = async (blobId: string | null | undefined) => {
    if (!blobId) return null;
    if (!blobMap.has(blobId)) blobMap.set(blobId, newId());
    return blobMap.get(blobId)!;
  };

  // 別 DB の読み取りは書込みトランザクションの前に済ませる（途中で別 DB を待つとトランザクションが閉じる）
  const srcBlobIds = new Set<string>();
  for (const c of clips) srcBlobIds.add(c.blobId);
  for (const x of media) {
    srcBlobIds.add(x.blobId);
    if (x.thumbnailBlobId) srcBlobIds.add(x.thumbnailBlobId);
  }
  for (const o of origs) if (media.some((x) => x.id === o.mediaId)) srcBlobIds.add(o.blobId);
  const srcBlobs = new Map((await src.blobs.bulkGet([...srcBlobIds])).filter((b): b is BlobRow => !!b).map((b) => [b.id, b]));

  // 作成日時（記録情報）は元のまま残す。更新日時と同期情報は新しく付け直す
  const base = { updatedAt: '', deletedAt: null };
  await transact(
    dst,
    async (w) => {
      await w.put('trip', { ...trip, ...base, id: newTrip, tripId: newTrip, name: newName ?? trip.name });
      for (const t of templates) await w.put('questionTemplate', { ...t, ...base, id: m(t.id)!, tripId: newTrip });
      for (const l of logs) await w.put('dailyLog', { ...l, ...base, id: m(l.id)!, tripId: newTrip });
      for (const a of answers) await w.put('answer', { ...a, ...base, id: m(a.id)!, tripId: newTrip, dailyLogId: m(a.dailyLogId)! });
      for (const i of items) await w.put('checklistItem', { ...i, ...base, id: m(i.id)!, tripId: newTrip });
      for (const e of expenses) await w.put('expense', { ...e, ...base, id: m(e.id)!, tripId: newTrip, receiptMediaId: m(e.receiptMediaId) });
      for (const e of exps)
        await w.put('foodExperience', { ...e, ...base, id: m(e.id)!, tripId: newTrip, checklistItemId: m(e.checklistItemId)!, expenseId: m(e.expenseId) });
      for (const n of notes) await w.put('note', { ...n, ...base, id: m(n.id)!, tripId: newTrip });
      for (const x of inbox) await w.put('inboxItem', { ...x, ...base, id: m(x.id)!, tripId: newTrip, shareId: null });
      for (const c of clips) {
        const nb = (await blobOut(c.blobId))!;
        await w.put('audioClip', { ...c, ...base, id: m(c.id)!, tripId: newTrip, dailyLogId: m(c.dailyLogId)!, answerId: m(c.answerId), blobId: nb });
      }
      for (const x of media) {
        const nb = (await blobOut(x.blobId))!;
        const nt = await blobOut(x.thumbnailBlobId);
        await w.put('media', { ...x, ...base, id: m(x.id)!, tripId: newTrip, blobId: nb, thumbnailBlobId: nt });
        const o = origs.find((y) => y.mediaId === x.id);
        if (o) await dst.db.localOriginals.put({ mediaId: m(x.id)!, blobId: (await blobOut(o.blobId))! });
      }
      for (const l of links) {
        if (!m(l.sourceId) || !m(l.targetId)) continue;
        await w.put('link', { ...l, ...base, id: m(l.id)!, tripId: newTrip, sourceId: m(l.sourceId)!, targetId: m(l.targetId)! });
      }
      for (const [oldId, nid] of blobMap) {
        const row = srcBlobs.get(oldId);
        if (row) await w.putBlob({ ...row, id: nid, uploaded: 0 });
      }
      // 未解決だった競合の「他端末の版」はメモとして残す（どちらも失わない）
      for (const c of conflicts) {
        if (!c.server) continue;
        await w.put('note', {
          id: newId(),
          tripId: newTrip,
          localDate: (c.server.localDate as string) ?? trip.startDate,
          body: `【復元時に未解決だった競合：他端末の版】${c.entityType}\n${JSON.stringify(c.server, null, 1).slice(0, 4000)}`,
          category: 'その他',
          tags: ['復元', '競合'],
          evidenceType: '',
          visibility: 'private',
          location: null,
          createdAt: '',
          ...base,
        });
      }
    },
    { atomic: false },
  );
  return newTrip;
}
