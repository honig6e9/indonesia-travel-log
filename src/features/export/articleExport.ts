// 記事制作向けエクスポート（Markdown / CSV / 音声 / 写真）。全データ ZIP（復元用）とは用途が別。
// 「公開候補のみ」では、公開区分が「公開候補」のものだけを入れ、対象外の素材やリンクを混ぜない。

import JSZip from 'jszip';
import type { TravelDB } from '../../db/db';
import { alive } from '../../db/repo';
import type {
  Answer,
  AudioClip,
  ChecklistItem,
  DailyLog,
  Expense,
  FoodExperience,
  Media,
  Note,
  Trip,
} from '../../db/types';
import { EVIDENCE_LABEL, VISIBILITY_LABEL } from '../../db/types';
import { dayLabel } from '../../lib/dates';
import { formatMoney } from '../../lib/format';
import { totalsByCurrency } from '../expenses/expenseRepo';

export interface ExportOptions {
  from: string;
  to: string;
  mode: 'all' | 'candidate';
  tag?: string;
  /** 公開候補の写真を再エンコードして位置情報などのメタデータを落とす（ブラウザのみ） */
  stripImage?: (b: Blob) => Promise<Blob>;
}

const CSV_DANGER = /^[=+\-@\t\r]/;
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (CSV_DANGER.test(s)) s = "'" + s; // CSV 式インジェクション対策
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}
export function toCsv(header: string[], rows: unknown[][]): string {
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export async function buildArticleExport(db: TravelDB, trip: Trip, o: ExportOptions): Promise<{ blob: Blob; fileCount: number }> {
  const inRange = (d: string) => d >= o.from && d <= o.to;
  const visOk = (v: string | undefined) => o.mode === 'all' || v === 'candidate';
  const tagOk = (tags: string[] | undefined) => !o.tag || (tags ?? []).includes(o.tag);
  const byTrip = async <T>(t: string) => alive((await db.table(t).where('tripId').equals(trip.id).toArray()) as (T & { deletedAt?: string | null })[]);

  const logs = (await byTrip<DailyLog>('dailyLogs')).filter((l) => inRange(l.localDate));
  const answers = await byTrip<Answer>('answers');
  const clips = await byTrip<AudioClip>('audioClips');
  const items = await byTrip<ChecklistItem>('checklistItems');
  const exps = (await byTrip<FoodExperience>('foodExperiences')).filter((e) => inRange(e.localDate) && visOk(e.visibility));
  const notes = (await byTrip<Note>('notes')).filter((n) => inRange(n.localDate) && visOk(n.visibility) && tagOk(n.tags));
  const expenses = o.mode === 'all' ? (await byTrip<Expense>('expenses')).filter((e) => inRange(e.localDate)) : [];
  const media = (await byTrip<Media>('media')).filter((m) => inRange(m.localDate) && visOk(m.visibility) && tagOk(m.tags));
  const origs = new Map((await db.localOriginals.toArray()).map((x) => [x.mediaId, x.blobId]));

  const zip = new JSZip();
  const root = zip.folder('article-materials')!;
  let fileCount = 0;

  // 音声：回答の公開区分に従う。自由録音は「すべて」のときだけ
  const answerByLogQ = new Map(answers.map((a) => [`${a.dailyLogId}:${a.questionId}`, a]));
  const audioPaths = new Map<string, string>();
  const counters = new Map<string, number>();
  const sortedClips = clips
    .filter((c) => inRange(c.localDate))
    .sort((a, b) => a.localDate.localeCompare(b.localDate) || a.createdAt.localeCompare(b.createdAt));
  for (const c of sortedClips) {
    const ans = c.questionId ? answerByLogQ.get(`${c.dailyLogId}:${c.questionId}`) : undefined;
    if (o.mode === 'candidate' && (!ans || ans.visibility !== 'candidate')) continue;
    if (o.tag && !(ans?.tags ?? []).includes(o.tag)) continue;
    const row = await db.blobs.get(c.blobId);
    if (!row) continue;
    const key = `${c.localDate}_${c.questionId ?? 'free'}`;
    const k = (counters.get(key) ?? 0) + 1;
    counters.set(key, k);
    const name = `${key}_${pad2(k)}.${c.ext}`;
    root.file(`audio/${name}`, row.blob, { binary: true, compression: 'STORE' });
    audioPaths.set(c.id, `../audio/${name}`);
    fileCount++;
  }

  // 写真
  const photoPaths = new Map<string, string>();
  const photoCounters = new Map<string, number>();
  for (const m of media.sort((a, b) => a.localDate.localeCompare(b.localDate) || a.createdAt.localeCompare(b.createdAt))) {
    const blobId = origs.get(m.id) ?? m.blobId;
    const row = (await db.blobs.get(blobId)) ?? (await db.blobs.get(m.blobId));
    if (!row) continue;
    let blob = row.blob;
    let ext = row.ext;
    if (o.mode === 'candidate' && o.stripImage) {
      try {
        blob = await o.stripImage(row.blob);
        ext = 'jpg';
      } catch {
        continue; // メタデータを落とせない画像は公開候補に入れない
      }
    }
    const k = (photoCounters.get(m.localDate) ?? 0) + 1;
    photoCounters.set(m.localDate, k);
    const name = `${m.localDate}_${pad2(k)}.${ext}`;
    root.file(`photos/${name}`, blob, { binary: true, compression: 'STORE' });
    photoPaths.set(m.id, `../photos/${name}`);
    fileCount++;
  }

  // 日別 Markdown
  const days = new Set<string>([
    ...logs.map((l) => l.localDate),
    ...notes.map((n) => n.localDate),
    ...media.map((m) => m.localDate),
    ...exps.map((e) => e.localDate),
    ...expenses.map((e) => e.localDate),
    ...items.filter((i) => i.status === 'done' && i.completedDate && inRange(i.completedDate) && visOk(i.visibility)).map((i) => i.completedDate!),
    ...sortedClips.filter((c) => audioPaths.has(c.id)).map((c) => c.localDate),
  ]);
  const itemById = new Map(items.map((i) => [i.id, i]));
  for (const day of [...days].sort()) {
    const dl = dayLabel(day, trip.startDate, trip.endDate);
    const lines: string[] = [`# ${day} / ${dl.kind === 'during' ? `DAY ${pad2(dl.day)}` : dl.label}`, ''];
    const log = logs.find((l) => l.localDate === day);
    const diaryLines: string[] = [];
    if (log) {
      for (const [i, q] of log.questionSnapshots.entries()) {
        const ans = answerByLogQ.get(`${log.id}:${q.questionId}`);
        const qClips = sortedClips.filter((c) => c.dailyLogId === log.id && c.questionId === q.questionId && audioPaths.has(c.id));
        const note = ans && visOk(ans.visibility) && tagOk(ans.tags) ? ans.note.trim() : '';
        if (!qClips.length && !note) continue;
        diaryLines.push(`### Q${i + 1}. ${q.title}`);
        for (const c of qClips) diaryLines.push(`- 音声: ${audioPaths.get(c.id)}`);
        if (note) diaryLines.push(`- 補足: ${note}`);
        diaryLines.push('');
      }
      const free = sortedClips.filter((c) => c.dailyLogId === log.id && !c.questionId && audioPaths.has(c.id));
      if (free.length) {
        diaryLines.push('### 自由録音');
        for (const c of free) diaryLines.push(`- 音声: ${audioPaths.get(c.id)}`);
        diaryLines.push('');
      }
    }
    if (diaryLines.length) lines.push('## 音声日記', ...diaryLines);
    const done = items.filter((i) => i.type === 'task' && i.status === 'done' && i.completedDate === day && visOk(i.visibility));
    if (done.length) lines.push('## やったこと', ...done.map((i) => `- [x] ${i.title}${i.note ? `：${i.note}` : ''}`), '');
    const ate = exps.filter((e) => e.localDate === day);
    if (ate.length) {
      lines.push('## 食べたもの');
      for (const e of ate) {
        const it = itemById.get(e.checklistItemId);
        const parts = [e.shop, e.price != null ? formatMoney(e.price, e.currency) : '', e.rating ? `評価${e.rating}` : '', e.comment].filter(Boolean);
        lines.push(`- ${it?.localName ?? it?.title ?? '（不明）'}${parts.length ? '：' + parts.join('、') : ''}`);
      }
      lines.push('');
    }
    const dn = notes.filter((n) => n.localDate === day);
    if (dn.length) {
      lines.push('## メモ・記事ネタ');
      for (const n of dn) {
        const meta = [n.category, n.evidenceType ? EVIDENCE_LABEL[n.evidenceType] : '', ...n.tags.map((t) => '#' + t)].filter(Boolean).join(' ');
        lines.push(`- ${n.body.replace(/\n/g, ' ')}${meta ? `（${meta}）` : ''}`);
      }
      lines.push('');
    }
    const dm = media.filter((m) => m.localDate === day && photoPaths.has(m.id));
    if (dm.length) lines.push('## 写真', ...dm.map((m) => `- ${photoPaths.get(m.id)}${m.caption ? `：${m.caption}` : ''}`), '');
    const de = expenses.filter((e) => e.localDate === day);
    if (de.length) {
      lines.push('## 支出');
      for (const t of totalsByCurrency(de)) lines.push(`- ${t.currency}合計：${formatMoney(t.total, t.currency)}（${t.count}件）`);
      lines.push('');
    }
    root.file(`days/${day}.md`, lines.join('\n'));
    fileCount++;
  }

  // CSV
  const tasks = items.filter((i) => i.type === 'task' && visOk(i.visibility));
  const foods = items.filter((i) => i.type === 'food' && visOk(i.visibility));
  const statusJa = (i: ChecklistItem) =>
    i.type === 'task' ? { open: '未完了', done: '完了', skipped: '見送り' }[i.status] : { open: '未体験', done: '食べた', skipped: '見送り' }[i.status];
  root.file('csv/tasks.csv', toCsv(['タイトル', '分類', 'エリア', '予定日', '優先度', '状態', '完了日', '体験メモ', '公開区分'], tasks.map((i) => [i.title, i.category, i.area, i.plannedDate, i.priority, statusJa(i), i.completedDate, i.note, VISIBILITY_LABEL[i.visibility]])));
  root.file('csv/food_wishlist.csv', toCsv(['料理名', '現地表記', '店・地域', '目安予算(IDR)', '予定日', '状態', '食べた日', 'メモ'], foods.map((i) => [i.title, i.localName, i.area, i.targetPrice, i.plannedDate, statusJa(i), i.completedDate, i.note])));
  root.file('csv/food_experiences.csv', toCsv(['日付', '料理', '店名', '価格', '通貨', '評価', '感想', '再訪したい'], exps.map((e) => [e.localDate, itemById.get(e.checklistItemId)?.title, e.shop, e.price, e.currency, e.rating, e.comment, e.revisit == null ? '' : e.revisit ? 'はい' : 'いいえ'])));
  if (o.mode === 'all') {
    root.file('csv/expenses.csv', toCsv(['日付', '種別', '金額', '通貨', '自分の負担', 'カテゴリ', '店名', '人数', '支払方法', 'メモ'], expenses.map((e) => [e.localDate, e.kind === 'refund' ? '返金' : '支出', e.amount, e.currency, e.personalAmount, e.category, e.shop, e.partySize, e.paymentMethod, e.note])));
    root.file('csv/daily_ratings.csv', toCsv(['日付', '生活への慣れ', '語学の通用感', '満足度', '疲労', '帰りたい気持ち', '会話時間(分)'], logs.map((l) => [l.localDate, l.ratings?.adaptation, l.ratings?.language, l.ratings?.satisfaction, l.ratings?.fatigue, l.ratings?.homesick, l.conversationMinutes])));
  }
  root.file('csv/media_index.csv', toCsv(['ファイル', '日付', '説明', 'カテゴリ', 'タグ', '撮影日時(推定)', '公開区分'], media.filter((m) => photoPaths.has(m.id)).map((m) => [photoPaths.get(m.id)!.replace('../', ''), m.localDate, m.caption, m.category, m.tags.join(' '), m.capturedAt, VISIBILITY_LABEL[m.visibility]])));
  fileCount += o.mode === 'all' ? 6 : 4;

  // まとめ
  const totals = totalsByCurrency(expenses);
  root.file(
    'trip_summary.md',
    [
      `# ${trip.name}`,
      '',
      `- 期間：${trip.startDate} 〜 ${trip.endDate}（${trip.timeZone}）`,
      `- 出力範囲：${o.from} 〜 ${o.to}`,
      `- 出力の種類：${o.mode === 'all' ? '全素材（私用）' : '公開候補のみ（要レビュー）'}${o.tag ? `、タグ「${o.tag}」` : ''}`,
      `- やること：完了 ${tasks.filter((i) => i.status === 'done').length} / ${tasks.length}`,
      `- 食べたいもの：食べた ${foods.filter((i) => i.status === 'done').length} / ${foods.length}`,
      `- 音声 ${audioPaths.size} 件、写真 ${photoPaths.size} 枚、メモ ${notes.length} 件`,
      ...(o.mode === 'all' ? totals.map((t) => `- ${t.currency} 合計：${formatMoney(t.total, t.currency)}`) : []),
      '',
    ].join('\n'),
  );
  root.file('README.md', README_TEXT(o.mode));
  fileCount += 2;
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', streamFiles: true });
  return { blob, fileCount };
}

const README_TEXT = (mode: 'all' | 'candidate') => `# 記事素材（Indonesia Travel Log から出力）

${mode === 'all' ? 'これは **全素材（私用）** です。公開用ではありません。' : 'これは **公開候補のみ（要レビュー）** の出力です。'}

## 中身

- \`days/YYYY-MM-DD.md\`：日別のまとめ。音声・写真は相対パスでつながっています
- \`audio/YYYY-MM-DD_q01_01.webm\`：音声日記（日付・質問 ID・連番）。\`free\` は自由録音
- \`photos/\`：写真
- \`csv/\`：一覧（UTF-8・BOM 付き。Excel でそのまま開けます）

## 文字起こし

帰国後にローカルの Whisper などで文字起こしし、音声と同じベース名の \`.txt\` を置くと（例：\`2026-11-29_q01_01.txt\`）、日付と質問を対応づけられます。

## 記事にするときの注意

- 記録にない事実を AI に補わせないでください。素材は「観察」「伝聞」「感想」「要確認」に分けて扱います。
- 「公開候補」にしただけでは、匿名化や本人の同意が済んだことにはなりません。
- 個人名・顔・会話・位置情報・外国人材の支援に関わる情報は、公開前に必ず確認してください。
- 音声の会話内容、写真の顔、位置情報の自動匿名化は行っていません。${mode === 'candidate' ? '\n- 公開候補の写真は再エンコードして、撮影位置などのメタデータを落としています（写っている内容はそのままです）。' : ''}
`;
