import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../app/context';
import { Field, Sheet } from '../../components/ui';
import { transact } from '../../db/repo';
import { formatPosition, getCurrentPosition, mapUrl, type Position } from '../../lib/geo';
import { timeIn } from '../../lib/dates';
import { formatDuration } from '../../lib/format';
import { newId } from '../../lib/ids';
import { extForMime, micErrorMessage, openMic, pickAudioFormat, recordingSupported } from '../diary/recorder';
import { saveClip } from '../diary/diaryRepo';
import { blankNote, NOTE_CATEGORIES } from './notesRepo';

const MAX_VOICE_MS = 3 * 60_000;

interface Voice {
  blob: Blob;
  mimeType: string;
  ext: string;
  durationMs: number;
  url: string;
}

/**
 * 「📍 現在地」：開いたらすぐ現在地を取り、メモと音声メモを付けて記録する。
 * 記録はメモ（場所つき）になり、音声メモはその日の自由録音として保存してメモと結ぶ。
 */
export function HereSheet(props: { onClose: () => void }) {
  const { ctx, trip, today, toast } = useApp();
  const [pos, setPos] = useState<Position | null>(null);
  const [posError, setPosError] = useState<string | null>(null);
  const [locating, setLocating] = useState(true);
  const [memo, setMemo] = useState('');
  const [category, setCategory] = useState('観光・移動');
  const [voice, setVoice] = useState<Voice | null>(null);
  const [rec, setRec] = useState<{ stop: () => void; startedAt: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);
  const voiceUrl = useRef<string | null>(null);
  const openedAt = useRef(new Date().toISOString());

  const locate = async () => {
    setLocating(true);
    setPosError(null);
    try {
      setPos(await getCurrentPosition());
    } catch (e) {
      setPosError((e as Error).message);
    } finally {
      setLocating(false);
    }
  };

  useEffect(() => {
    void locate();
    return () => {
      if (voiceUrl.current) URL.revokeObjectURL(voiceUrl.current);
    };
    // 開いたときに 1 回だけ取る
  }, []);

  useEffect(() => {
    if (!rec) return;
    const t = window.setInterval(() => {
      const ms = Date.now() - rec.startedAt;
      setElapsed(ms);
      if (ms >= MAX_VOICE_MS) rec.stop();
    }, 200);
    return () => window.clearInterval(t);
  }, [rec]);

  const startVoice = async () => {
    const fmt = pickAudioFormat();
    if (!fmt) return toast('この端末では録音できません。メモに文字で書いてください', { kind: 'error' });
    let stream: MediaStream;
    try {
      stream = await openMic();
    } catch (e) {
      return toast(micErrorMessage(e), { kind: 'error' });
    }
    const mr = new MediaRecorder(stream, fmt.mimeType ? { mimeType: fmt.mimeType, audioBitsPerSecond: 64000 } : undefined);
    const mimeType = mr.mimeType || fmt.mimeType || 'audio/webm';
    const chunks: Blob[] = [];
    const startedAt = Date.now();
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      setRec(null);
      const blob = new Blob(chunks, { type: mimeType });
      if (!blob.size) return toast('録音できませんでした。もう一度どうぞ', { kind: 'error' });
      if (voiceUrl.current) URL.revokeObjectURL(voiceUrl.current);
      voiceUrl.current = URL.createObjectURL(blob);
      setVoice({ blob, mimeType, ext: extForMime(mimeType, fmt.ext), durationMs: Date.now() - startedAt, url: voiceUrl.current });
    };
    mr.start(1000);
    setElapsed(0);
    setRec({ stop: () => mr.state !== 'inactive' && mr.stop(), startedAt });
  };

  const save = async () => {
    if (rec) return toast('録音中です。■ で止めてから記録してください');
    if (!pos && !memo.trim() && !voice) return toast('記録する内容がありません');
    setSaving(true);
    try {
      const time = timeIn(trip.timeZone, openedAt.current);
      const note = {
        ...blankNote(trip.id, today),
        body: [`📍 ${pos ? '現在地' : '場所なし'}（${time}）`, memo.trim()].filter(Boolean).join('\n'),
        category,
        location: pos ? formatPosition(pos) : null,
      };
      await transact(ctx, (w) => w.put('note', note));
      if (voice) {
        const clip = await saveClip(ctx, { tripId: trip.id, localDate: today, questionId: null, blob: voice.blob, mimeType: voice.mimeType, ext: voice.ext, durationMs: voice.durationMs });
        await transact(ctx, (w) =>
          w.put('link', { id: newId(), tripId: trip.id, sourceType: 'audioClip', sourceId: clip.id, targetType: 'note', targetId: note.id, createdAt: '', updatedAt: '' }),
        );
      }
      toast(pos ? `現在地を記録しました（±${Math.round(pos.accuracy)}m）` : '場所なしでメモを記録しました');
      props.onClose();
    } catch (e) {
      toast((e as Error).name === 'QuotaExceededError' ? '端末の容量が足りず、保存できませんでした' : `保存できませんでした：${(e as Error).message}`, { kind: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const url = pos ? mapUrl(formatPosition(pos)) : null;

  return (
    <Sheet
      title="📍 現在地を記録"
      onClose={() => {
        rec?.stop();
        props.onClose();
      }}
      footer={
        <button className="btn primary" disabled={saving || locating || !!rec} onClick={() => void save()}>
          {saving ? '記録中…' : locating ? '現在地を取得中…' : '記録する'}
        </button>
      }
    >
      <div className="here-pos">
        {locating ? (
          <p className="muted">現在地を取得しています…</p>
        ) : pos ? (
          <p>
            {formatPosition(pos)}
            {url && (
              <>
                {' '}
                <a className="link" href={url} target="_blank" rel="noopener noreferrer">
                  地図で開く
                </a>
              </>
            )}
          </p>
        ) : (
          <p className="error-text">{posError}</p>
        )}
        {!locating && (
          <button className="btn small ghost" onClick={() => void locate()}>
            取り直す
          </button>
        )}
      </div>
      <Field label="メモ（任意）" hint="キーボードのマイクで話して入力することもできます">
        <textarea rows={3} value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="例：このワルンのソトが安くておいしい" />
      </Field>
      <Field label="音声メモ（任意）">
        <div className="here-voice">
          {rec ? (
            <button className="btn rec stop" onClick={() => rec.stop()}>
              ■ 止める {formatDuration(elapsed)}
            </button>
          ) : (
            <button className="btn rec" disabled={!recordingSupported()} onClick={() => void startVoice()}>
              🎤 {voice ? '録り直す' : '録音する'}
            </button>
          )}
          {voice && !rec && (
            <>
              <audio controls preload="metadata" src={voice.url} />
              <button className="btn small ghost" onClick={() => setVoice(null)}>
                消す
              </button>
            </>
          )}
        </div>
      </Field>
      <Field label="分類">
        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          {NOTE_CATEGORIES.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
      </Field>
    </Sheet>
  );
}
