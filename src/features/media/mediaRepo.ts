import type { TravelDB } from '../../db/db';
import { alive, transact, type Ctx } from '../../db/repo';
import type { EntityType, Media } from '../../db/types';
import { newId } from '../../lib/ids';
import { sha256Hex } from '../../lib/hash';
import { extFromMime, resizeImage } from '../../lib/image';

export const MEDIA_CATEGORIES = ['風景', '食事', '人・交流', '生活', '物価・レシート', '移動', 'その他'];

export interface AddPhotoOptions {
  tripId: string;
  localDate: string;
  caption?: string;
  category?: string;
  /** 容量節約モード：クラウドには長辺1600px・JPEG 0.8 の圧縮版だけを送る。原本は端末に残す */
  compressForCloud?: boolean;
  linkTo?: { type: EntityType; id: string } | null;
}

export async function addPhoto(ctx: Ctx, file: File, o: AddPhotoOptions): Promise<Media> {
  const mimeType = file.type || 'image/jpeg';
  const origSha = await sha256Hex(file);
  const origId = newId();
  let syncBlob: Blob = file;
  let syncSha = origSha;
  let syncId = origId;
  let syncMime = mimeType;
  if (o.compressForCloud) {
    syncBlob = await resizeImage(file, 1600, 0.8);
    syncSha = await sha256Hex(syncBlob);
    syncId = newId();
    syncMime = 'image/jpeg';
  }
  let thumb: Blob | null = null;
  try {
    thumb = await resizeImage(file, 320, 0.7);
  } catch {
    thumb = null; // HEIC など、ブラウザが読めない形式はサムネイルなし
  }
  const thumbSha = thumb ? await sha256Hex(thumb) : null;
  const thumbId = thumb ? newId() : null;
  const capturedAt = file.lastModified ? new Date(file.lastModified).toISOString() : null;

  return transact(
    ctx,
    async (w) => {
      await w.putBlob({ id: origId, blob: file, size: file.size, mimeType, sha256: origSha, ext: extFromMime(mimeType, 'jpg'), uploaded: 0 });
      if (syncId !== origId) {
        await w.putBlob({ id: syncId, blob: syncBlob, size: syncBlob.size, mimeType: syncMime, sha256: syncSha, ext: 'jpg', uploaded: 0 });
      }
      if (thumb && thumbId && thumbSha) {
        await w.putBlob({ id: thumbId, blob: thumb, size: thumb.size, mimeType: 'image/jpeg', sha256: thumbSha, ext: 'jpg', uploaded: 0 });
      }
      const media = await w.put('media', {
        id: newId(),
        tripId: o.tripId,
        localDate: o.localDate,
        blobId: syncId,
        thumbnailBlobId: thumbId,
        mimeType: syncMime,
        ext: extFromMime(syncMime, 'jpg'),
        size: syncBlob.size,
        sha256: syncSha,
        capturedAt,
        caption: o.caption ?? '',
        category: o.category ?? 'その他',
        tags: [],
        visibility: 'unchecked',
        cloudCompressed: syncId !== origId,
        createdAt: '',
        updatedAt: '',
      });
      if (syncId !== origId) await ctx.db.localOriginals.put({ mediaId: media.id, blobId: origId });
      if (o.linkTo) {
        await w.put('link', {
          id: newId(),
          tripId: o.tripId,
          sourceType: 'media',
          sourceId: media.id,
          targetType: o.linkTo.type,
          targetId: o.linkTo.id,
          createdAt: '',
          updatedAt: '',
        });
      }
      return media;
    },
    { atomic: true },
  );
}

export async function saveMedia(ctx: Ctx, m: Media) {
  await transact(ctx, (w) => w.put('media', m));
}

export async function deleteMedia(ctx: Ctx, id: string) {
  // 写真の Blob は端末から自動削除しない
  await transact(ctx, async (w) => {
    await w.remove('media', id);
    for (const l of alive(await ctx.db.links.where('sourceId').equals(id).toArray())) await w.remove('link', l.id);
  });
}

export async function mediaOn(db: TravelDB, tripId: string, localDate: string) {
  return alive(await db.media.where('[tripId+localDate]').equals([tripId, localDate]).toArray()).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

/** 端末にある最良の Blob（原本 → 同期版の順） */
export async function bestMediaBlobId(db: TravelDB, m: Media): Promise<string> {
  const orig = await db.localOriginals.get(m.id);
  if (orig && (await db.blobs.get(orig.blobId))) return orig.blobId;
  return m.blobId;
}

export async function linkedTo(db: TravelDB, targetId: string, sourceType: EntityType) {
  const links = alive(await db.links.where('targetId').equals(targetId).toArray()).filter((l) => l.sourceType === sourceType);
  return links.map((l) => l.sourceId);
}

export async function addLink(ctx: Ctx, tripId: string, sourceType: EntityType, sourceId: string, targetType: EntityType, targetId: string) {
  await transact(ctx, (w) =>
    w.put('link', { id: newId(), tripId, sourceType, sourceId, targetType, targetId, createdAt: '', updatedAt: '' }),
  );
}
