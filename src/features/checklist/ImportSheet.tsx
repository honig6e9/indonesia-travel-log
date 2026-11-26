import { useState } from 'react';
import { useApp } from '../../app/context';
import { Sheet } from '../../components/ui';
import type { ChecklistItem } from '../../db/types';
import { importItems, isDuplicate, type ImportItem } from './checklistRepo';

/** 取り込み用ファイルの中身を確かめてから、やること・食べたいものに入れる */
export function ImportSheet(props: { items: ImportItem[]; errors: string[]; existing: ChecklistItem[]; onClose: () => void }) {
  const { ctx, trip, toast } = useApp();
  const [skipDup, setSkipDup] = useState(true);
  const [busy, setBusy] = useState(false);
  const dups = props.items.filter((i) => isDuplicate(i, props.existing));
  const toAdd = skipDup ? props.items.filter((i) => !isDuplicate(i, props.existing)) : props.items;
  const tasks = toAdd.filter((i) => i.type === 'task');
  const foods = toAdd.filter((i) => i.type === 'food');
  return (
    <Sheet
      title="ファイルから取り込む"
      onClose={props.onClose}
      footer={
        <button
          className="btn primary"
          disabled={busy || toAdd.length === 0}
          onClick={async () => {
            setBusy(true);
            try {
              await importItems(ctx, trip.id, toAdd);
              toast(`やること ${tasks.length} 件、食べたいもの ${foods.length} 件を取り込みました`);
              props.onClose();
            } catch (e) {
              toast('取り込めませんでした：' + (e as Error).message, { kind: 'error' });
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? '取り込み中…' : `${toAdd.length} 件を取り込む`}
        </button>
      }
    >
      <ul className="kv">
        <li><span>やること</span><span>{tasks.length} 件（予定日あり {tasks.filter((i) => i.plannedDate).length}）</span></li>
        <li><span>食べたいもの</span><span>{foods.length} 件</span></li>
        <li><span>すでにある項目と同じ名前</span><span>{dups.length} 件</span></li>
      </ul>
      <label className="check-inline">
        <input type="checkbox" checked={skipDup} onChange={(e) => setSkipDup(e.target.checked)} /> 同じ名前の項目は取り込まない
      </label>
      {props.errors.length > 0 && (
        <div className="notice small">
          取り込めない行がありました（{props.errors.length} 件）。
          <ul>
            {props.errors.slice(0, 10).map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      <ul className="bulk-preview">
        {toAdd.slice(0, 200).map((i, k) => (
          <li key={k}>
            <span className="pill">{i.type === 'task' ? 'やること' : '食べたい'}</span> {i.plannedDate && <span className="muted small">{i.plannedDate} </span>}
            {i.title}
          </li>
        ))}
      </ul>
    </Sheet>
  );
}
