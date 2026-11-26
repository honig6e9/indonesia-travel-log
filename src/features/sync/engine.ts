// 同期エンジン：outbox の送信（push）→ 他端末の変更の取得（pull）。
// - 端末の時計は競合判定に使わない。サーバーのリビジョンだけで順序を決める。
// - push 成功で pull のカーソルは進めない（他端末の更新を取りこぼさない）。
// - 未送信の変更があるレコードには、取得した版を直接上書きせず 3-way マージに回す。

import type { TravelDB } from '../../db/db';
import { ALL_TABLES, blobIdsOf } from '../../db/repo';
import { ENTITY_TABLE, ENTITY_TYPES, type EntityType, type OutboxOp } from '../../db/types';
import { newId } from '../../lib/ids';
import { sha256Hex } from '../../lib/hash';
import { deepEqual, merge3 } from './merge';
import { MAX_FILE_BYTES, TransportError, blobPath, type PushOp, type Transport } from './transport';

export interface SyncReport {
  pushed: number;
  pulled: number;
  uploaded: number;
  conflicts: number;
  errors: string[];
  stoppedBy?: 'auth' | 'network' | null;
}

const PULL_PAGE = 200;
const PUSH_BATCH = 50;

function backoffMs(attempts: number) {
  const base = Math.min(5 * 60_000, 2000 * 2 ** Math.min(attempts, 8));
  return base / 2 + Math.random() * (base / 2); // ジッター
}

const RETRYABLE = new Set(['network', 'server']);

function kindLabel(e: TransportError) {
  switch (e.kind) {
    case 'auth':
      return 'ログインの有効期限が切れました。再ログインしてください';
    case 'quota':
      return 'クラウドの容量が不足しています';
    case 'too-large':
      return 'ファイルが大きすぎて送信できません（50MB 上限）';
    case 'network':
      return '通信できません（端末には保存済み）';
    case 'validation':
      return 'サーバーが内容を受け付けませんでした: ' + e.message;
    default:
      return 'サーバーエラー: ' + e.message;
  }
}

export async function getMeta<T>(db: TravelDB, key: string, fallback: T): Promise<T> {
  const r = await db.syncMeta.get(key);
  return r === undefined ? fallback : (r.value as T);
}

export class SyncEngine {
  constructor(
    private db: TravelDB,
    private ownerId: string,
    private deviceId: string,
    private deviceName: string,
    private transport: Transport,
  ) {}

  async sync(opts: { uploadMedia: boolean }): Promise<SyncReport> {
    const report: SyncReport = { pushed: 0, pulled: 0, uploaded: 0, conflicts: 0, errors: [] };
    try {
      await this.recoverSending();
      if (opts.uploadMedia) report.uploaded = await this.uploadBlobs(report);
      report.pushed = await this.push(report);
      report.pulled = await this.pull();
      try {
        await this.transport.registerDevice(this.deviceId, this.deviceName);
      } catch {
        /* 端末一覧の更新失敗は同期の失敗としない */
      }
      report.conflicts = await this.db.conflicts.where('status').equals('open').count();
      await this.db.syncMeta.bulkPut([
        { key: 'lastSuccessfulSync', value: new Date().toISOString() },
        { key: 'lastError', value: report.errors[0] ?? null },
        { key: 'lastErrorKind', value: null },
      ]);
    } catch (e) {
      const te = e instanceof TransportError ? e : new TransportError('server', String((e as Error)?.message ?? e));
      report.stoppedBy = te.kind === 'auth' ? 'auth' : te.kind === 'network' ? 'network' : null;
      report.errors.push(kindLabel(te));
      await this.db.syncMeta.bulkPut([
        { key: 'lastError', value: kindLabel(te) },
        { key: 'lastErrorKind', value: te.kind },
      ]);
      await this.recoverSending();
    }
    return report;
  }

  /** 前回の送信中に終了した操作は、同じ operationId のまま送信待ちに戻す（サーバー側で冪等） */
  private async recoverSending() {
    await this.db.outbox.where('status').equals('sending').modify({ status: 'pending' });
  }

  /** この操作の送信に必要なファイルが揃っているか */
  private async blobsReady(op: OutboxOp): Promise<boolean> {
    if (op.deleted) return true;
    for (const id of op.blobIds) {
      const row = await this.db.blobs.get(id);
      if (row && row.uploaded !== 1) return false; // 端末にあって未送信
      // 端末にない Blob は他端末が送信済みのもの（取得前）
    }
    return true;
  }

  // ---------- ファイル送信 ----------

  private async uploadBlobs(report: SyncReport): Promise<number> {
    const ops = await this.db.outbox.filter((o) => o.ownerId === this.ownerId && o.blobIds.length > 0 && !o.deleted).toArray();
    let count = 0;
    const done = new Set<string>();
    for (const op of ops) {
      for (const blobId of op.blobIds) {
        if (done.has(blobId)) continue;
        done.add(blobId);
        const row = await this.db.blobs.get(blobId);
        if (!row || row.uploaded === 1) continue;
        if (row.size > MAX_FILE_BYTES) {
          await this.failOps([op], new TransportError('too-large', 'file too large'));
          report.errors.push(kindLabel(new TransportError('too-large', '')));
          continue;
        }
        const path = blobPath(this.ownerId, op.tripId, blobId, row.ext);
        try {
          const r = await this.transport.uploadBlob(path, row.blob, row.mimeType);
          if (r === 'exists') {
            // 再送時：既存オブジェクトのサイズ・ハッシュを確かめる
            const remote = await this.transport.downloadBlob(path);
            const sha = await sha256Hex(remote);
            if (remote.size !== row.size || sha !== row.sha256) {
              await this.failOps([op], new TransportError('validation', 'クラウド上の同名ファイルが一致しません'));
              report.errors.push('クラウド上の同名ファイルが一致しません');
              continue;
            }
          }
          await this.db.blobs.update(blobId, { uploaded: 1 });
          count++;
        } catch (e) {
          const te = e instanceof TransportError ? e : new TransportError('network', String(e));
          if (te.kind === 'auth' || te.kind === 'network') throw te;
          await this.failOps([op], te);
          report.errors.push(kindLabel(te));
        }
      }
    }
    return count;
  }

  // ---------- push ----------

  private async eligibleBatches(): Promise<OutboxOp[][]> {
    const now = Date.now();
    const all = await this.db.outbox.orderBy('seq').toArray();
    const firstSeqOfEntity = new Map<string, number>();
    for (const o of all) {
      const k = `${o.entityType}:${o.entityId}`;
      if (!firstSeqOfEntity.has(k)) firstSeqOfEntity.set(k, o.seq!);
    }
    const blockedGroups = new Set(all.filter((o) => o.groupId && o.status !== 'pending').map((o) => o.groupId!));
    const ready: OutboxOp[] = [];
    for (const o of all) {
      if (o.ownerId !== this.ownerId || o.status !== 'pending' || o.nextAttemptAt > now) continue;
      if (firstSeqOfEntity.get(`${o.entityType}:${o.entityId}`) !== o.seq) continue; // 同一レコードは先の操作から
      if (o.groupId && blockedGroups.has(o.groupId)) continue;
      if (!(await this.blobsReady(o))) {
        if (o.groupId) blockedGroups.add(o.groupId);
        continue;
      }
      ready.push(o);
    }
    // グループ（原子的に送る単位）は分割しない
    const batches: OutboxOp[][] = [];
    const byGroup = new Map<string, OutboxOp[]>();
    for (const o of ready) {
      if (!o.groupId) continue;
      byGroup.set(o.groupId, [...(byGroup.get(o.groupId) ?? []), o]);
    }
    let current: OutboxOp[] = [];
    const emitted = new Set<string>();
    for (const o of ready) {
      if (o.groupId) {
        if (blockedGroups.has(o.groupId) || emitted.has(o.groupId)) continue;
        emitted.add(o.groupId);
        const g = byGroup.get(o.groupId)!;
        if (current.length + g.length > PUSH_BATCH && current.length) {
          batches.push(current);
          current = [];
        }
        current.push(...g);
      } else {
        current.push(o);
      }
      if (current.length >= PUSH_BATCH) {
        batches.push(current);
        current = [];
      }
    }
    if (current.length) batches.push(current);
    return batches;
  }

  private async push(report: SyncReport): Promise<number> {
    let pushed = 0;
    for (let round = 0; round < 20; round++) {
      const batches = await this.eligibleBatches();
      if (batches.length === 0) break;
      let progressed = false;
      for (const batch of batches) {
        // 送信中にする（この間に来た編集は別の操作として積まれる）
        const sending = await this.db.transaction('rw', this.db.outbox, async () => {
          const fresh: OutboxOp[] = [];
          for (const o of batch) {
            const cur = await this.db.outbox.get(o.seq!);
            if (cur && cur.status === 'pending' && cur.operationId === o.operationId) {
              await this.db.outbox.update(o.seq!, { status: 'sending', attempts: cur.attempts + 1 });
              fresh.push({ ...cur, attempts: cur.attempts + 1 });
            }
          }
          return fresh;
        });
        if (sending.length === 0) continue;
        const pushOps: PushOp[] = sending.map((o) => ({
          operation_id: o.operationId,
          entity_type: o.entityType,
          entity_id: o.entityId,
          trip_id: o.tripId,
          base_revision: o.baseRevision,
          payload: o.desiredPayload,
          deleted: o.deleted,
        }));
        let result;
        try {
          result = await this.transport.push(pushOps, this.deviceId);
        } catch (e) {
          const te = e instanceof TransportError ? e : new TransportError('network', String(e));
          if (te.kind === 'auth' || te.kind === 'network') throw te;
          await this.failOps(sending, te);
          report.errors.push(kindLabel(te));
          continue;
        }
        progressed = true;
        if (result.status === 'ok') {
          await this.db.transaction('rw', ALL_TABLES as unknown as string[], async () => {
            for (const r of result.results) {
              const op = sending.find((o) => o.operationId === r.operation_id);
              if (!op) continue;
              await this.db.outbox.delete(op.seq!);
              await this.db.syncState.put({
                key: `${op.entityType}:${op.entityId}`,
                revision: r.revision,
                basePayload: op.desiredPayload,
              });
              // 送信中に積まれた同じレコードの操作を新しいベースに載せ替える
              const rest = await this.db.outbox.where('[entityType+entityId]').equals([op.entityType, op.entityId]).toArray();
              for (const o of rest) {
                await this.db.outbox.update(o.seq!, { baseRevision: r.revision, basePayload: op.desiredPayload });
              }
              pushed++;
            }
          });
        } else {
          await this.db.transaction('rw', ALL_TABLES as unknown as string[], async () => {
            // 競合時は何も適用されていない。いったん送信待ちに戻してから、競合分をマージに回す
            for (const o of sending) await this.db.outbox.update(o.seq!, { status: 'pending' });
            for (const c of result.conflicts) {
              const payload = c.payload ? { ...c.payload } : null;
              if (payload && c.deleted && !payload.deletedAt) payload.deletedAt = new Date().toISOString();
              await this.reconcile(c.entity_type, c.entity_id, c.revision, payload, true);
            }
          });
        }
      }
      if (!progressed) break;
    }
    return pushed;
  }

  private async failOps(ops: OutboxOp[], e: TransportError) {
    await this.db.transaction('rw', this.db.outbox, async () => {
      for (const o of ops) {
        const cur = await this.db.outbox.get(o.seq!);
        if (!cur) continue;
        if (RETRYABLE.has(e.kind)) {
          await this.db.outbox.update(o.seq!, {
            status: 'pending',
            lastError: kindLabel(e),
            nextAttemptAt: Date.now() + backoffMs(cur.attempts),
          });
        } else {
          // 利用者の対処が必要。無限に再試行しない
          await this.db.outbox.update(o.seq!, { status: 'error', lastError: kindLabel(e) });
        }
      }
    });
  }

  // ---------- pull ----------

  private async pull(): Promise<number> {
    let since = await getMeta<number>(this.db, 'lastAppliedRevision', 0);
    let total = 0;
    for (;;) {
      const page = await this.transport.pull(since, PULL_PAGE);
      if (page.length === 0) break;
      await this.db.transaction('rw', ALL_TABLES as unknown as string[], async () => {
        for (const rec of page) {
          if (!ENTITY_TYPES.includes(rec.entity_type)) continue;
          const payload = { ...rec.payload };
          if (rec.deleted_at && !payload.deletedAt) payload.deletedAt = rec.deleted_at;
          await this.reconcile(rec.entity_type, rec.entity_id, rec.revision, payload, false);
        }
        // ページの適用とカーソル更新は同じトランザクション
        await this.db.syncMeta.put({ key: 'lastAppliedRevision', value: page[page.length - 1].revision });
      });
      total += page.length;
      since = page[page.length - 1].revision;
      if (page.length < PULL_PAGE) break;
    }
    return total;
  }

  /**
   * サーバー版を端末に取り込む。未送信の変更があれば 3-way マージし、
   * 解決できなければ競合として両方を残す。トランザクション内で呼ぶ。
   */
  private async reconcile(
    type: EntityType,
    id: string,
    serverRev: number,
    serverPayload: Record<string, unknown> | null,
    fromPushConflict: boolean,
  ) {
    const db = this.db;
    const key = `${type}:${id}`;
    const table = db.table(ENTITY_TABLE[type]);
    const st = await db.syncState.get(key);
    const ops = (await db.outbox.where('[entityType+entityId]').equals([type, id]).sortBy('seq')).filter(
      (o) => o.status !== 'sending',
    );

    if (ops.length === 0) {
      if (st && st.revision >= serverRev) return; // 既知の版
      if (serverPayload) {
        await table.put(serverPayload);
        await db.syncState.put({ key, revision: serverRev, basePayload: serverPayload });
      }
      return;
    }
    const first = ops[0];
    if (!fromPushConflict && serverRev <= first.baseRevision) return;

    const localRow = ((await table.get(id)) as Record<string, unknown> | undefined) ?? ops[ops.length - 1].desiredPayload;
    const base = first.basePayload;
    const { merged, conflicts } = merge3(type, base, localRow, serverPayload);
    const groupId = first.groupId;
    await db.outbox.bulkDelete(ops.map((o) => o.seq!));
    if (serverPayload) await db.syncState.put({ key, revision: serverRev, basePayload: serverPayload });

    if (conflicts.length === 0) {
      const strip = (p: Record<string, unknown> | null) => {
        if (!p) return p;
        const { updatedAt: _u, createdAt: _c, ...rest } = p;
        void _u;
        void _c;
        return rest;
      };
      if (serverPayload && deepEqual(strip(merged), strip(serverPayload))) {
        await table.put(serverPayload);
        return;
      }
      await table.put(merged);
    } else {
      await table.put(merged);
      const existing = await db.conflicts
        .where('[entityType+entityId]')
        .equals([type, id])
        .filter((c) => c.status === 'open')
        .first();
      await db.conflicts.put({
        id: existing?.id ?? newId(),
        entityType: type,
        entityId: id,
        base,
        local: localRow,
        server: serverPayload,
        serverRevision: serverRev,
        fields: conflicts,
        status: 'open',
        createdAt: new Date().toISOString(),
      });
    }
    await db.outbox.add({
      operationId: newId(),
      ownerId: this.ownerId,
      entityType: type,
      entityId: id,
      tripId: (merged.tripId as string) ?? first.tripId,
      baseRevision: serverRev,
      basePayload: serverPayload,
      desiredPayload: merged,
      deleted: !!merged.deletedAt,
      groupId,
      blobIds: blobIdsOf(type, merged),
      attempts: 0,
      lastError: null,
      status: conflicts.length ? 'conflict' : 'pending',
      nextAttemptAt: 0,
    });
  }

  // ---------- メディアの取得 ----------

  /** 端末にない音声・写真をダウンロードして検証・保存する */
  async fetchMissing(filter?: { localDate?: string; blobIds?: string[] }): Promise<{ fetched: number; failed: string[] }> {
    const targets = await missingBlobs(this.db, filter);
    let fetched = 0;
    const failed: string[] = [];
    for (const t of targets) {
      try {
        const blob = await this.transport.downloadBlob(blobPath(this.ownerId, t.tripId, t.blobId, t.ext));
        if (t.sha256) {
          const sha = await sha256Hex(blob);
          if (sha !== t.sha256) throw new Error('ハッシュが一致しません');
        }
        await this.db.blobs.put({
          id: t.blobId,
          blob,
          size: blob.size,
          mimeType: t.mimeType,
          sha256: t.sha256 || (await sha256Hex(blob)),
          ext: t.ext,
          uploaded: 1,
        });
        fetched++;
      } catch (e) {
        failed.push(t.blobId);
        if (e instanceof TransportError && (e.kind === 'auth' || e.kind === 'network')) {
          failed.push(...targets.slice(targets.indexOf(t) + 1).map((x) => x.blobId));
          break;
        }
      }
    }
    return { fetched, failed };
  }

  async resolveConflict(conflictId: string, result: Record<string, unknown>) {
    const db = this.db;
    await db.transaction('rw', ALL_TABLES as unknown as string[], async () => {
      const c = await db.conflicts.get(conflictId);
      if (!c) return;
      await resolveConflictTx(db, c.id, result);
    });
  }
}

/** 競合の解決（ローカルのみで完結。次の同期で送る） */
export async function resolveConflictTx(db: TravelDB, conflictId: string, result: Record<string, unknown>) {
  const c = await db.conflicts.get(conflictId);
  if (!c) return;
  const table = db.table(ENTITY_TABLE[c.entityType]);
  await table.put(result);
  const ops = await db.outbox.where('[entityType+entityId]').equals([c.entityType, c.entityId]).toArray();
  const op = ops.find((o) => o.status === 'conflict');
  if (op) {
    await db.outbox.update(op.seq!, {
      operationId: newId(),
      desiredPayload: result,
      deleted: !!result.deletedAt,
      blobIds: blobIdsOf(c.entityType, result),
      status: 'pending',
      attempts: 0,
      nextAttemptAt: 0,
      lastError: null,
    });
  }
  await db.conflicts.update(c.id, { status: 'resolved' });
}

export interface MissingBlob {
  blobId: string;
  tripId: string;
  ext: string;
  mimeType: string;
  sha256: string;
  size: number;
  localDate: string;
  kind: 'audio' | 'image' | 'thumbnail';
}

/** 記録はあるが端末に本体がないファイル */
export async function missingBlobs(db: TravelDB, filter?: { localDate?: string; blobIds?: string[] }): Promise<MissingBlob[]> {
  const out: MissingBlob[] = [];
  const have = new Set(await db.blobs.toCollection().primaryKeys());
  const want = (b: MissingBlob) =>
    !have.has(b.blobId) &&
    (!filter?.localDate || b.localDate === filter.localDate) &&
    (!filter?.blobIds || filter.blobIds.includes(b.blobId));
  for (const c of await db.audioClips.toArray()) {
    if (c.deletedAt) continue;
    const b: MissingBlob = { blobId: c.blobId, tripId: c.tripId, ext: c.ext, mimeType: c.mimeType, sha256: c.sha256, size: c.size, localDate: c.localDate, kind: 'audio' };
    if (want(b)) out.push(b);
  }
  for (const m of await db.media.toArray()) {
    if (m.deletedAt) continue;
    const b: MissingBlob = { blobId: m.blobId, tripId: m.tripId, ext: m.ext, mimeType: m.mimeType, sha256: m.sha256, size: m.size, localDate: m.localDate, kind: 'image' };
    if (want(b)) out.push(b);
    if (m.thumbnailBlobId) {
      const t: MissingBlob = { blobId: m.thumbnailBlobId, tripId: m.tripId, ext: 'jpg', mimeType: 'image/jpeg', sha256: '', size: 0, localDate: m.localDate, kind: 'thumbnail' };
      if (want(t)) out.push(t);
    }
  }
  return out;
}
