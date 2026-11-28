/** リンクにしてよい URL（http・https だけ）。javascript: や intent: などは null */
export function safeHttpUrl(u: string | null | undefined): string | null {
  const s = (u ?? '').trim();
  if (!/^https?:\/\//i.test(s)) return null;
  try {
    const p = new URL(s);
    return p.protocol === 'http:' || p.protocol === 'https:' ? p.href : null;
  } catch {
    return null;
  }
}
