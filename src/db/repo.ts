import type { Transaction } from 'dexie';
import { RECORD_TABLES, type TravelDB } from './db';
import { ENTITY_TABLE, type BaseRecord, type BlobRow, type EntityMap, type EntityType, type OutboxOp } from './types';
import { newId } from '../lib/ids';
import { nowIso } from '../lib/dates';

/** 書込みの文脈。ownerId があればクラウド同期用の outbox にも積む */
export interface Ctx {
  db: TravelDB;
  ownerId: string | null;
}

export const ALL_TABLES = [
  ...RECORD_TABLES,
  'blobs',
  'localOriginals',
  'settings',
  'outbox',
  'syncState',
  'syncMeta',
  'conflicts',
  'drafts',
] as const;

export function toPayload(rec: object): Record<string, unknown> {
  return JSON.parse(JSON.stringify(rec)) as Record<string, unknown>;
}

export function blobIdsOf(type: EntityType, rec: Record<string, unknown>): string[] {
  if (type === 'audioClip') return [rec.blobId as string];
  if (type === 'media') return [rec.blobId as string, rec.thumbnailBlobId as string].filter(Boolean);
  return [];
}

export class Writer {
  private groupId: string | null;
  constructor(
    private ctx: Ctx,
    atomic: boolean,
  ) {
    this.groupId = atomic ? newId() : null;
  }

  private table(type: EntityType) {
    return this.ctx.db.table(ENTITY_TABLE[type]);
  }

  async get<T extends EntityType>(type: T, id: string): Promise<EntityMap[T] | undefined> {
    return (await this.table(type).get(id)) as EntityMap[T] | undefined;
  }

  /** 作成または更新。createdAt は初回のまま保つ */
  async put<T extends EntityType>(type: T, rec: EntityMap[T]): Promise<EntityMap[T]> {
    const prev = (await this.table(type).get(rec.id)) as BaseRecord | undefined;
    const now = nowIso();
    const next = {
      ...rec,
      createdAt: prev?.createdAt || rec.createdAt || now,
      updatedAt: now,
      deletedAt: rec.deletedAt ?? null,
    } as EntityMap[T];
    await this.table(type).put(next);
    await this.enqueue(type, next, false);
    return next;
  }

  /** 墓石化（同期のため行は残す） */
  async remove(type: EntityType, id: string): Promise<void> {
    const prev = (await this.table(type).get(id)) as BaseRecord | undefined;
    if (!prev || prev.deletedAt) return;
    const now = nowIso();
    const next = { ...prev, deletedAt: now, updatedAt: now };
    await this.table(type).put(next);
    await this.enqueue(type, next, true);
  }

  async putBlob(row: BlobRow) {
    await this.ctx.db.blobs.put(row);
  }

  private async enqueue(type: EntityType, rec: BaseRecord, deleted: boolean) {
    const { db, ownerId } = this.ctx;
    if (!ownerId) return;
    const payload = toPayload(rec);
    const blobIds = blobIdsOf(type, payload);
    const existing = await db.outbox
      .where('[entityType+entityId]')
      .equals([type, rec.id])
      // 一度でも送信した操作（応答を失った可能性がある）は内容を変えない
      .filter((o) => o.ownerId === ownerId && (o.status === 'conflict' || o.status === 'error' || (o.status === 'pending' && o.attempts === 0)))
      .last();
    if (existing) {
      // 送信前の同一レコードはベース版を残してまとめる（送信開始済みの operationId は変えない）
      const patch: Partial<OutboxOp> = {
        desiredPayload: payload,
        deleted,
        blobIds,
        groupId: existing.groupId ?? this.groupId,
      };
      if (existing.status === 'error') {
        patch.status = 'pending';
        patch.attempts = 0;
        patch.nextAttemptAt = 0;
        patch.operationId = newId();
      }
      await db.outbox.update(existing.seq!, patch);
      if (existing.status === 'conflict') {
        const c = await db.conflicts
          .where('[entityType+entityId]')
          .equals([type, rec.id])
          .filter((x) => x.status === 'open')
          .first();
        if (c) await db.conflicts.update(c.id, { local: payload });
      }
      return;
    }
    const st = await db.syncState.get(`${type}:${rec.id}`);
    await db.outbox.add({
      operationId: newId(),
      ownerId,
      entityType: type,
      entityId: rec.id,
      tripId: rec.tripId,
      baseRevision: st?.revision ?? 0,
      basePayload: st?.basePayload ?? null,
      desiredPayload: payload,
      deleted,
      groupId: this.groupId,
      blobIds,
      attempts: 0,
      lastError: null,
      status: 'pending',
      nextAttemptAt: 0,
    });
  }
}

/**
 * ローカル変更と outbox 登録を 1 つの IndexedDB トランザクションで行う。
 * atomic=true のとき、含まれる変更はクラウドへも 1 つのバッチで送る（例：実食と支出）。
 */
export async function transact<R>(
  ctx: Ctx,
  fn: (w: Writer, tx: Transaction) => Promise<R>,
  opts: { atomic?: boolean } = {},
): Promise<R> {
  return ctx.db.transaction('rw', ALL_TABLES as unknown as string[], async (tx) => {
    const w = new Writer(ctx, opts.atomic ?? false);
    return fn(w, tx);
  });
}

export function alive<T extends { deletedAt?: string | null }>(rows: T[]): T[] {
  return rows.filter((r) => !r.deletedAt);
}
