export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function formatMoney(amount: number, currency: string): string {
  return `${currency} ${Math.round(amount).toLocaleString('ja-JP')}`;
}

/** カンマ・スペース区切りのタグ入力を配列にする */
export function parseTags(s: string): string[] {
  return Array.from(
    new Set(
      s
        .split(/[,、\s#＃]+/)
        .map((t) => t.trim())
        .filter(Boolean),
    ),
  );
}

export function percent(done: number, total: number): string {
  if (total === 0) return '—';
  return `${Math.round((done / total) * 100)}%`;
}
