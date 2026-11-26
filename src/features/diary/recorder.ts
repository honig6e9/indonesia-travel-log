// 録音まわり（UI から分離）。MIME は実行時に対応を判定する。

export interface AudioFormat {
  mimeType: string;
  ext: string;
}

const CANDIDATES: AudioFormat[] = [
  { mimeType: 'audio/webm;codecs=opus', ext: 'webm' },
  { mimeType: 'audio/webm', ext: 'webm' },
  { mimeType: 'audio/mp4;codecs=mp4a.40.2', ext: 'm4a' },
  { mimeType: 'audio/mp4', ext: 'm4a' },
  { mimeType: 'audio/ogg;codecs=opus', ext: 'ogg' },
];

export function recordingSupported(): boolean {
  return typeof window !== 'undefined' && 'MediaRecorder' in window && !!navigator.mediaDevices?.getUserMedia;
}

export function pickAudioFormat(): AudioFormat | null {
  if (!recordingSupported()) return null;
  for (const c of CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(c.mimeType)) return c;
    } catch {
      /* 判定できない環境は次へ */
    }
  }
  return { mimeType: '', ext: 'webm' }; // ブラウザの既定に任せる
}

export function extForMime(mime: string, fallback: string): string {
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('mp4') || mime.includes('aac')) return 'm4a';
  if (mime.includes('ogg')) return 'ogg';
  return fallback;
}

export function micErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name ?? '';
  if (!window.isSecureContext) return 'HTTPS で開いていないため、マイクを使えません。HTTPS の URL から開いてください。';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'マイクの使用が許可されていません。アドレスバーの鍵アイコン（サイトの設定）からマイクを「許可」にして、再試行してください。';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'マイクが見つかりません。';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'マイクを使えません。通話中か、ほかのアプリがマイクを使っている可能性があります。';
    case 'SecurityError':
      return 'セキュリティの設定によりマイクを使えません。';
    default:
      return 'マイクを開始できませんでした（' + (name || String(e)) + '）。';
  }
}

export async function openMic(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('getUserMedia unavailable'), { name: 'NotSupportedError' });
  return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
}

/** 画面スリープを防ぐ（使えない環境では何もしない。失敗しても録音は続ける） */
export async function requestWakeLock(): Promise<{ release: () => void }> {
  try {
    const wl = (navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
    if (wl) {
      const s = await wl.request('screen');
      return { release: () => void s.release().catch(() => undefined) };
    }
  } catch {
    /* 補助なので無視 */
  }
  return { release: () => undefined };
}
