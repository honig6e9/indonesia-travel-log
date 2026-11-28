import { useEffect, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { AudioPlayer, Field, Sheet, VisibilitySelect, useDraft } from '../../components/ui';
import { alive } from '../../db/repo';
import type { AudioClip, ChecklistItem } from '../../db/types';
import { TYPE_TEXT } from '../checklist/checklistRepo';
import { byPlanned } from '../checklist/period';
import { LocationField } from '../../components/LocationField';
import { EVIDENCE_LABEL, type EvidenceType, type Note } from '../../db/types';
import { parseTags } from '../../lib/format';
import { blankNote, deleteNote, linkedItemIds, NOTE_CATEGORIES, saveNoteWithLinks } from './notesRepo';

export function NoteSheet(props: { note?: Note; date: string; onClose: () => void; linkTo?: string | null }) {
  const { ctx, db, trip, toast } = useApp();
  const initial = props.note ?? blankNote(trip.id, props.date);
  const [n, setN, clearDraft, restored] = useDraft<Note>(`note:${props.note?.id ?? 'new:' + props.date}`, initial);
  const [tags, setTags] = useState(n.tags.join(' '));
  const [saving, setSaving] = useState(false);
  const update = (patch: Partial<Note>) => setN({ ...n, ...patch });
  // 結ぶ項目（やること・食べたいもの・行きたい場所）
  const [itemIds, setItemIds] = useState<string[] | null>(props.note ? null : props.linkTo ? [props.linkTo] : []);
  useEffect(() => {
    if (props.note && itemIds === null) void linkedItemIds(db, props.note.id).then(setItemIds);
  }, [db, props.note, itemIds]);
  const allItems =
    useLiveQuery(async () => alive(await db.checklistItems.where('tripId').equals(trip.id).toArray()).sort(byPlanned), [db, trip.id]) ?? [];
  const linked = (itemIds ?? []).map((id) => allItems.find((i) => i.id === id)).filter((i): i is ChecklistItem => !!i);
  // 「📍 現在地」で一緒に録った音声メモ
  const voices =
    useLiveQuery(async () => {
      if (!props.note) return [];
      const links = alive(await db.links.where('targetId').equals(props.note.id).toArray()).filter((l) => l.sourceType === 'audioClip');
      return alive((await db.audioClips.bulkGet(links.map((l) => l.sourceId))).filter((c): c is AudioClip => !!c));
    }, [db, props.note?.id]) ?? [];

  const save = async () => {
    if (!n.body.trim()) {
      toast('本文を入力してください');
      return;
    }
    setSaving(true);
    try {
      await saveNoteWithLinks(ctx, { ...n, tags: parseTags(tags) }, itemIds ?? (props.note ? await linkedItemIds(db, props.note.id) : []));
      clearDraft();
      toast('メモを端末に保存しました');
      props.onClose();
    } catch (e) {
      toast('保存できませんでした：' + (e as Error).message, { kind: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      title={props.note ? 'メモを編集' : `メモ（${n.localDate}）`}
      onClose={props.onClose}
      footer={
        <>
          {props.note && (
            <button
              className="btn danger ghost"
              onClick={async () => {
                if (!confirm('このメモを削除しますか？')) return;
                await deleteNote(ctx, props.note!.id);
                clearDraft();
                props.onClose();
              }}
            >
              削除
            </button>
          )}
          <button className="btn primary" disabled={saving} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      {restored && <p className="notice">前回の入力途中の内容を復元しました。</p>}
      <Field label="本文">
        <textarea autoFocus rows={4} value={n.body} onChange={(e) => update({ body: e.target.value })} placeholder="1行でも保存できます" />
      </Field>
      <Field label="カテゴリ">
        <div className="chips">
          {NOTE_CATEGORIES.map((c) => (
            <button key={c} type="button" className={'chip' + (n.category === c ? ' on' : '')} onClick={() => update({ category: c })}>
              {c}
            </button>
          ))}
        </div>
      </Field>
      <Field label="種類（任意）">
        <select value={n.evidenceType} onChange={(e) => update({ evidenceType: e.target.value as EvidenceType })}>
          {(Object.keys(EVIDENCE_LABEL) as EvidenceType[]).map((k) => (
            <option key={k} value={k}>
              {EVIDENCE_LABEL[k]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="タグ（空白・読点区切り）">
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="例：物価 KRL 記事ネタ" />
      </Field>
      <LocationField value={n.location} onChange={(location) => update({ location })} />
      {voices.map((v) => (
        <AudioPlayer key={v.id} blobId={v.blobId} durationMs={v.durationMs} label="🎤 音声メモ" />
      ))}
      <Field label="記録対象日">
        <input type="date" value={n.localDate} onChange={(e) => e.target.value && update({ localDate: e.target.value })} />
      </Field>
      <Field label="やることに結ぶ（任意）" hint="結んだメモは、その項目の画面にも出ます">
        <div className="chips">
          {linked.map((i) => (
            <span key={i.id} className="chip on">
              {TYPE_TEXT[i.type].name}：{i.title}
              <button type="button" className="link" aria-label={`${i.title} から外す`} onClick={() => setItemIds((itemIds ?? []).filter((x) => x !== i.id))}>
                ✕
              </button>
            </span>
          ))}
        </div>
        <select
          value=""
          onChange={(e) => {
            const id = e.target.value;
            if (id && !(itemIds ?? []).includes(id)) setItemIds([...(itemIds ?? []), id]);
          }}
          aria-label="結ぶ項目を選ぶ"
        >
          <option value="">＋ 項目を選ぶ</option>
          {(['task', 'food', 'place'] as const).map((t) => (
            <optgroup key={t} label={TYPE_TEXT[t].name}>
              {allItems
                .filter((i) => i.type === t && !(itemIds ?? []).includes(i.id))
                .map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.status === 'done' ? '✓ ' : ''}
                    {i.title}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </Field>
      <VisibilitySelect value={n.visibility} onChange={(visibility) => update({ visibility })} />
    </Sheet>
  );
}
