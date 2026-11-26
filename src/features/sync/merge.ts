// 共通ベースからの 3-way マージ。
// 別フィールドの変更は合わせ、同じ値なら解決済みとし、同じフィールドへの異なる変更は競合として返す。

import type { EntityType, QuestionSnapshot } from '../../db/types';

type P = Record<string, unknown> | null;

export const DELETED_FIELD = '__deleted__';
const META = new Set(['createdAt', 'updatedAt', 'deletedAt']);

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) if (!deepEqual(ao[k], bo[k])) return false;
  return true;
}

export interface MergeResult {
  merged: Record<string, unknown>;
  conflicts: string[];
}

const isDeleted = (p: P) => !!p && !!p.deletedAt;

/** 質問スナップショットの同時作成：質問 ID の和集合。同じ ID で文が違えば競合 */
function mergeSnapshots(local: unknown, server: unknown): { value: QuestionSnapshot[]; conflict: boolean } {
  const l = (Array.isArray(local) ? local : []) as QuestionSnapshot[];
  const s = (Array.isArray(server) ? server : []) as QuestionSnapshot[];
  const out: QuestionSnapshot[] = [...s];
  let conflict = false;
  for (const q of l) {
    const other = out.find((x) => x.questionId === q.questionId);
    if (!other) out.push(q);
    else if (!deepEqual(other, q)) conflict = true;
  }
  return { value: out, conflict };
}

export function merge3(type: EntityType, base: P, local: Record<string, unknown>, server: P): MergeResult {
  if (!server) return { merged: local, conflicts: [] };
  const ld = isDeleted(local);
  const sd = isDeleted(server);
  const conflicts: string[] = [];
  const merged: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(local), ...Object.keys(server), ...Object.keys(base ?? {})]);
  for (const k of keys) {
    if (META.has(k)) continue;
    const l = local[k];
    const s = server[k];
    const b = base ? base[k] : undefined;
    if (deepEqual(l, s)) merged[k] = l ?? s;
    else if (base && deepEqual(l, b)) merged[k] = s;
    else if (base && deepEqual(s, b)) merged[k] = l;
    else if (!base && (l === undefined || l === null)) merged[k] = s;
    else if (!base && (s === undefined || s === null)) merged[k] = l;
    else if (type === 'dailyLog' && k === 'questionSnapshots') {
      const r = mergeSnapshots(l, s);
      merged[k] = r.value;
      if (r.conflict) conflicts.push(k);
    } else {
      merged[k] = l; // 確定までは端末の内容を表示しつつ、競合として両方を残す
      conflicts.push(k);
    }
  }
  const lc = typeof local.createdAt === 'string' ? local.createdAt : '';
  const sc = typeof server.createdAt === 'string' ? server.createdAt : '';
  merged.createdAt = lc && sc ? (lc < sc ? lc : sc) : lc || sc;
  const lu = typeof local.updatedAt === 'string' ? local.updatedAt : '';
  const su = typeof server.updatedAt === 'string' ? server.updatedAt : '';
  merged.updatedAt = lu > su ? lu : su;

  // 削除と編集
  if (ld && sd) {
    merged.deletedAt = local.deletedAt;
  } else if (ld || sd) {
    const editedOther = ld
      ? !deepEqual(stripMeta(server), stripMeta(base))
      : !deepEqual(stripMeta(local), stripMeta(base));
    if (base && !editedOther) {
      merged.deletedAt = ld ? local.deletedAt : server.deletedAt;
    } else {
      merged.deletedAt = null;
      conflicts.push(DELETED_FIELD);
    }
  } else {
    merged.deletedAt = null;
  }
  return { merged, conflicts };
}

function stripMeta(p: P): Record<string, unknown> | null {
  if (!p) return null;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (!META.has(k)) o[k] = v;
  return o;
}

/** 競合の解決：フィールドごとに 'local' | 'server' を選んだ結果を作る */
export function resolveWith(
  merged: Record<string, unknown>,
  local: Record<string, unknown>,
  server: Record<string, unknown> | null,
  choices: Record<string, 'local' | 'server'>,
): Record<string, unknown> {
  const out = { ...merged };
  for (const [field, pick] of Object.entries(choices)) {
    const src = pick === 'local' ? local : (server ?? {});
    if (field === DELETED_FIELD) out.deletedAt = src.deletedAt ?? null;
    else out[field] = src[field];
  }
  out.updatedAt = new Date().toISOString();
  return out;
}
