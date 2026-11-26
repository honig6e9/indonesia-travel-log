import type { EntityType } from '../../db/types';

export interface PushOp {
  operation_id: string;
  entity_type: EntityType;
  entity_id: string;
  trip_id: string;
  base_revision: number;
  payload: Record<string, unknown>;
  deleted: boolean;
}

export interface PushOk {
  status: 'ok';
  results: { operation_id: string; entity_type: EntityType; entity_id: string; revision: number }[];
  replayed?: boolean;
}

export interface PushConflict {
  status: 'conflict';
  conflicts: {
    operation_id: string;
    entity_type: EntityType;
    entity_id: string;
    revision: number;
    payload: Record<string, unknown> | null;
    deleted: boolean;
  }[];
}

export type PushResult = PushOk | PushConflict;

export interface ServerRecord {
  entity_type: EntityType;
  entity_id: string;
  payload: Record<string, unknown>;
  revision: number;
  deleted_at: string | null;
}

export interface DeviceInfo {
  device_id: string;
  display_name: string;
  last_synced_at: string | null;
}

export type TransportErrorKind = 'network' | 'auth' | 'quota' | 'too-large' | 'validation' | 'server';

export class TransportError extends Error {
  constructor(
    public kind: TransportErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/** クラウドとの通信の抽象。本番は Supabase、テストは PGlite と メモリ内ストレージ */
export interface Transport {
  push(ops: PushOp[], deviceId: string): Promise<PushResult>;
  pull(since: number, limit: number): Promise<ServerRecord[]>;
  /** 既に存在すれば 'exists'（上書きはしない） */
  uploadBlob(path: string, blob: Blob, mimeType: string): Promise<'ok' | 'exists'>;
  downloadBlob(path: string): Promise<Blob>;
  registerDevice(deviceId: string, name: string): Promise<void>;
  listDevices(): Promise<DeviceInfo[]>;
}

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

export function blobPath(ownerId: string, tripId: string, blobId: string, ext: string) {
  const safeExt = ext.replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  return `${ownerId}/${tripId}/${blobId}.${safeExt}`;
}
