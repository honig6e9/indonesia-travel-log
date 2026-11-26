// 画像の縮小。ブラウザの canvas で再エンコードするため、EXIF（位置情報を含む）は落ちる。

async function decode(blob: Blob): Promise<{ w: number; h: number; draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void }> {
  if ('createImageBitmap' in globalThis) {
    const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    return { w: bmp.width, h: bmp.height, draw: (c, w, h) => c.drawImage(bmp, 0, 0, w, h) };
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('画像を読み込めませんでした'));
      i.src = url;
    });
    return { w: img.naturalWidth, h: img.naturalHeight, draw: (c, w, h) => c.drawImage(img, 0, 0, w, h) };
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** 長辺を maxSide 以下にして JPEG にする */
export async function resizeImage(blob: Blob, maxSide: number, quality = 0.8): Promise<Blob> {
  const src = await decode(blob);
  const scale = Math.min(1, maxSide / Math.max(src.w, src.h));
  const w = Math.max(1, Math.round(src.w * scale));
  const h = Math.max(1, Math.round(src.h * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas が使えません');
  src.draw(ctx, w, h);
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('画像を変換できませんでした'))), 'image/jpeg', quality),
  );
}

export function extFromMime(mime: string, fallback = 'bin'): string {
  const m = mime.toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('heic')) return 'heic';
  if (m.includes('heif')) return 'heif';
  if (m.includes('gif')) return 'gif';
  if (m.includes('webm')) return 'webm';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'm4a';
  if (m.includes('ogg')) return 'ogg';
  if (m.includes('mpeg')) return 'mp3';
  if (m.includes('wav')) return 'wav';
  return fallback;
}
