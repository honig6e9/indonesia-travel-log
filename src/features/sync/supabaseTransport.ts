import type { SupabaseClient } from '@supabase/supabase-js';
import { TransportError, type DeviceInfo, type PushOp, type PushResult, type ServerRecord, type Transport } from './transport';

export const BUCKET = 'travel-media';

function classify(err: unknown): TransportError {
  if (err instanceof TransportError) return err;
  const e = err as { message?: string; status?: number; statusCode?: string | number; code?: string; name?: string };
  const msg = e?.message ?? String(err);
  const status = Number(e?.status ?? e?.statusCode ?? 0);
  if ((typeof navigator !== 'undefined' && navigator.onLine === false) ||/Failed to fetch|NetworkError|network|fetch failed|Load failed/i.test(msg) || e?.name === 'AbortError')
    return new TransportError('network', msg);
  if (status === 401 || status === 403 || e?.code === '28000' || e?.code === 'PGRST301' || /JWT|not authenticated|invalid claim/i.test(msg))
    return new TransportError('auth', msg);
  if (status === 413 || /too large|exceeded the maximum allowed size|Payload too large/i.test(msg)) return new TransportError('too-large', msg);
  if (/quota|storage limit|insufficient storage|exceed/i.test(msg)) return new TransportError('quota', msg);
  if (e?.code === '22023' || e?.code === '23503' || e?.code === '22P02' || status === 400) return new TransportError('validation', msg);
  return new TransportError('server', msg);
}

export class SupabaseTransport implements Transport {
  constructor(private sb: SupabaseClient) {}

  async push(ops: PushOp[], deviceId: string): Promise<PushResult> {
    const { data, error } = await this.sb.rpc('sync_push', { p_ops: ops, p_device_id: deviceId });
    if (error) throw classify(error);
    return data as PushResult;
  }

  async pull(since: number, limit: number): Promise<ServerRecord[]> {
    const { data, error } = await this.sb
      .from('sync_records')
      .select('entity_type, entity_id, payload, revision, deleted_at')
      .gt('revision', since)
      .order('revision', { ascending: true })
      .limit(limit);
    if (error) throw classify(error);
    return (data ?? []).map((r) => ({ ...r, revision: Number(r.revision) })) as ServerRecord[];
  }

  async uploadBlob(path: string, blob: Blob, mimeType: string): Promise<'ok' | 'exists'> {
    const { error } = await this.sb.storage.from(BUCKET).upload(path, blob, { contentType: mimeType, upsert: false });
    if (!error) return 'ok';
    const e = error as { message?: string; statusCode?: string | number };
    if (String(e.statusCode) === '409' || /already exists|Duplicate/i.test(e.message ?? '')) return 'exists';
    throw classify(error);
  }

  async downloadBlob(path: string): Promise<Blob> {
    const { data, error } = await this.sb.storage.from(BUCKET).download(path);
    if (error || !data) throw classify(error ?? new Error('download failed'));
    return data;
  }

  async registerDevice(deviceId: string, name: string): Promise<void> {
    const { error } = await this.sb.rpc('register_device', { p_device_id: deviceId, p_display_name: name.slice(0, 60) || '端末' });
    if (error) throw classify(error);
  }

  async listDevices(): Promise<DeviceInfo[]> {
    const { data, error } = await this.sb
      .from('device_registry')
      .select('device_id, display_name, last_synced_at')
      .order('last_synced_at', { ascending: false });
    if (error) throw classify(error);
    return (data ?? []) as DeviceInfo[];
  }
}
