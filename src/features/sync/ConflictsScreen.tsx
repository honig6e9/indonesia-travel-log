import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { ALL_TABLES } from '../../db/repo';
import { ENTITY_TABLE, type ConflictRow, type EntityType } from '../../db/types';
import { Empty } from '../../components/ui';
import { resolveConflictTx } from './engine';
import { DELETED_FIELD, resolveWith } from './merge';

const TYPE_LABEL: Record<EntityType, string> = {
  trip: '旅行の設定',
  questionTemplate: '質問テンプレート',
  dailyLog: '日記（質問・定点観測）',
  answer: '音声日記の回答',
  audioClip: '録音',
  checklistItem: 'リストの項目',
  foodExperience: '実食',
  note: 'メモ',
  expense: '支出',
  media: '写真',
  link: '関連づけ',
};

const FIELD_LABEL: Record<string, string> = {
  [DELETED_FIELD]: '削除するかどうか',
  title: 'タイトル',
  note: 'メモ',
  body: '本文',
  status: '状態（チェック）',
  completedDate: '完了日',
  plannedDate: '予定日',
  rating: '評価',
  ratings: '定点観測',
  questionSnapshots: 'その日の質問文',
  hints: '補助質問',
  enabled: '有効／無効',
  sortOrder: '並び順',
  comment: '感想',
  amount: '金額',
  localDate: '記録対象日',
  caption: '説明',
  visibility: '公開区分',
  tags: 'タグ',
};

function show(v: unknown, field: string, side: Record<string, unknown> | null): string {
  if (field === DELETED_FIELD) return side?.deletedAt ? '削除する' : '残す';
  if (v == null || v === '') return '（空）';
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' / ');
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'はい' : 'いいえ';
  return String(v);
}

export function ConflictsScreen() {
  const { db } = useApp();
  const list = useLiveQuery(() => db.conflicts.where('status').equals('open').toArray(), [db]) ?? [];
  return (
    <div className="screen">
      <h1>競合の確認</h1>
      <p className="muted small">
        同じ記録が複数の端末で別々に変更されました。項目ごとに残す内容を選んでください。選ぶまでは両方の内容を保っており、この記録は送信を止めています。
      </p>
      {list.length === 0 ? <Empty>未解決の競合はありません。</Empty> : list.map((c) => <ConflictCard key={c.id} c={c} />)}
    </div>
  );
}

function ConflictCard({ c }: { c: ConflictRow }) {
  const { db, toast } = useApp();
  const [choices, setChoices] = useState<Record<string, 'local' | 'server'>>(() => Object.fromEntries(c.fields.map((f) => [f, 'local'])));
  const title = (c.local.title ?? c.local.body ?? c.local.name ?? c.local.localDate ?? '') as string;
  return (
    <section className="card">
      <h2>
        {TYPE_LABEL[c.entityType]}：{String(title).slice(0, 40)}
      </h2>
      {c.fields.map((f) => (
        <div key={f} className="conflict-field">
          <p className="small">
            <strong>{FIELD_LABEL[f] ?? f}</strong>
          </p>
          <label className="choice">
            <input type="radio" checked={choices[f] === 'local'} onChange={() => setChoices({ ...choices, [f]: 'local' })} />
            <span>
              <span className="muted small">この端末の内容</span>
              <br />
              {show(c.local[f], f, c.local)}
            </span>
          </label>
          <label className="choice">
            <input type="radio" checked={choices[f] === 'server'} onChange={() => setChoices({ ...choices, [f]: 'server' })} />
            <span>
              <span className="muted small">他端末の内容</span>
              <br />
              {show(c.server?.[f], f, c.server)}
            </span>
          </label>
        </div>
      ))}
      <div className="actions">
        <button className="btn small ghost" onClick={() => setChoices(Object.fromEntries(c.fields.map((f) => [f, 'local'])))}>すべてこの端末</button>
        <button className="btn small ghost" onClick={() => setChoices(Object.fromEntries(c.fields.map((f) => [f, 'server'])))}>すべて他端末</button>
        <button
          className="btn primary"
          onClick={async () => {
            await db.transaction('rw', ALL_TABLES as unknown as string[], async () => {
              const current = ((await db.table(ENTITY_TABLE[c.entityType]).get(c.entityId)) as Record<string, unknown>) ?? c.local;
              await resolveConflictTx(db, c.id, resolveWith(current, c.local, c.server, choices));
            });
            toast('選んだ内容で確定しました。次の同期で送信します');
          }}
        >
          この内容で確定
        </button>
      </div>
    </section>
  );
}
