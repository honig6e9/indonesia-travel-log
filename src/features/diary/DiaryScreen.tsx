import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { navigate, setNavigationGuard } from '../../app/router';
import { AudioPlayer, Field, Sheet, VisibilitySelect } from '../../components/ui';
import { getSetting, setSetting } from '../../db/db';
import type { AudioClip, RecordingDraft } from '../../db/types';
import { dailyLogId as detDailyLogId, newId } from '../../lib/ids';
import { formatBytes, formatDuration, parseTags } from '../../lib/format';
import { shortDate } from '../../lib/dates';
import { loadDiary, removeClip, saveClip, setAnswerNote, setSkipped, updateAnswer } from './diaryRepo';
import { extForMime, micErrorMessage, openMic, pickAudioFormat, recordingSupported, requestWakeLock } from './recorder';

type RecState = 'idle' | 'starting' | 'recording' | 'saving' | 'saved' | 'failed';
const FREE = '__free__';

export function DiaryScreen(props: { initialQuestion: string | null }) {
  const { db, ctx, trip, date, toast, recordingRef } = useApp();
  const diary = useLiveQuery(() => loadDiary(db, trip.id, date), [db, trip.id, date]);
  const drafts = useLiveQuery(() => db.drafts.toArray(), [db]) ?? [];
  const maxMinutes = useLiveQuery(() => getSetting<number>(db, 'maxClipMinutes', 15), [db]) ?? 15;

  const [qid, setQid] = useState<string | null>(props.initialQuestion);
  const [listOpen, setListOpen] = useState(false);
  const [rec, setRec] = useState<RecState>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [replaceTarget, setReplaceTargetState] = useState<AudioClip | null>(null);
  const replaceRef = useRef<AudioClip | null>(null);
  const setReplaceTarget = (c: AudioClip | null) => {
    replaceRef.current = c;
    setReplaceTargetState(c);
  };

  const mediaRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const draftIdRef = useRef<string | null>(null);
  const startRef = useRef(0);
  const wakeRef = useRef<{ release: () => void } | null>(null);
  const timerRef = useRef<number | null>(null);
  const stopRef = useRef<() => void>(() => undefined);

  // 初回は先頭、再開時は直前の質問へ
  useEffect(() => {
    if (qid || !diary) return;
    void (async () => {
      const last = await getSetting<string | null>(db, `lastQ:${trip.id}:${date}`, null);
      const exists = last === FREE || diary.questions.some((q) => q.questionId === last);
      setQid(exists && last ? last : (diary.questions[0]?.questionId ?? FREE));
    })();
  }, [qid, diary, db, trip.id, date]);

  useEffect(() => {
    if (qid) void setSetting(db, `lastQ:${trip.id}:${date}`, qid);
  }, [qid, db, trip.id, date]);

  const busy = rec === 'recording' || rec === 'starting' || rec === 'saving';
  useEffect(() => {
    recordingRef.current = busy;
    setNavigationGuard(busy ? () => (rec === 'saving' ? '保存中です。少しお待ちください' : '録音中です。「停止して保存」を押してから移動してください') : null);
    return () => setNavigationGuard(null);
  }, [busy, rec, recordingRef]);

  const cleanupStream = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    wakeRef.current?.release();
    wakeRef.current = null;
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
  };

  const start = useCallback(async () => {
    setError(null);
    const fmt = pickAudioFormat();
    if (!fmt) {
      setError('このブラウザは録音に対応していません。補足メモ（文字）で記録できます。');
      return;
    }
    setRec('starting');
    let stream: MediaStream;
    try {
      stream = await openMic();
    } catch (e) {
      setRec('idle');
      setError(micErrorMessage(e) + ' 補足メモ（文字）でも記録できます。');
      return;
    }
    streamRef.current = stream;
    let mr: MediaRecorder;
    try {
      mr = new MediaRecorder(stream, fmt.mimeType ? { mimeType: fmt.mimeType, audioBitsPerSecond: 64000 } : { audioBitsPerSecond: 64000 });
    } catch {
      mr = new MediaRecorder(stream);
    }
    const mimeType = mr.mimeType || fmt.mimeType || 'audio/webm';
    const ext = extForMime(mimeType, fmt.ext);
    const draftId = newId();
    const questionId = qid === FREE ? null : qid;
    const draft: RecordingDraft = {
      id: draftId,
      dailyLogId: detDailyLogId(trip.id, date),
      localDate: date,
      questionId,
      answerId: null,
      mimeType,
      ext,
      chunks: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    chunksRef.current = [];
    draftIdRef.current = draftId;
    try {
      await db.drafts.put(draft);
    } catch {
      /* 下書きが保存できなくても録音は続ける */
    }
    mr.ondataavailable = (ev) => {
      if (!ev.data || ev.data.size === 0) return;
      chunksRef.current.push(ev.data);
      // 途中のチャンクを定期保存（中断時に回復できる可能性を残す。完全な復旧は保証しない）
      void db.drafts.update(draftId, { chunks: [...chunksRef.current], updatedAt: new Date().toISOString() }).catch(() => undefined);
    };
    mr.onstop = async () => {
      cleanupStream();
      setRec('saving');
      const blob = new Blob(chunksRef.current, { type: mimeType });
      const durationMs = Date.now() - startRef.current;
      if (blob.size === 0) {
        setRec('failed');
        setError('音声が記録されませんでした。もう一度お試しください。');
        await db.drafts.delete(draftId).catch(() => undefined);
        return;
      }
      try {
        await saveClip(ctx, { tripId: trip.id, localDate: date, questionId, blob, mimeType, ext, durationMs });
        await db.drafts.delete(draftId).catch(() => undefined);
        draftIdRef.current = null;
        setRec('saved');
        toast(`端末に保存しました（${formatDuration(durationMs)}）`);
        if (replaceRef.current) {
          const old = replaceRef.current;
          replaceRef.current = null;
          setReplaceTargetState(null);
          if (confirm(`新しい録音を保存しました。以前の録音（${formatDuration(old.durationMs)}）を削除しますか？\n「キャンセル」で両方残します。`)) {
            await removeClip(ctx, old.id);
          }
        }
      } catch (e) {
        setRec('failed');
        const quota = (e as Error)?.name === 'QuotaExceededError';
        setError(
          (quota ? '端末の容量が足りず保存できませんでした。' : '保存に失敗しました。') +
            '録音は「中断された録音」に残っています（以前の録音は消していません）。',
        );
      }
    };
    mediaRef.current = mr;
    startRef.current = Date.now();
    setElapsed(0);
    mr.start(5000);
    setRec('recording');
    wakeRef.current = await requestWakeLock();
    timerRef.current = window.setInterval(() => {
      const ms = Date.now() - startRef.current;
      setElapsed(ms);
      if (ms >= maxMinutes * 60_000) {
        toast(`録音時間の上限（${maxMinutes}分）に達したので保存します`);
        stopRef.current();
      }
    }, 250);
  }, [db, ctx, trip.id, date, qid, toast, maxMinutes]);

  const stop = useCallback(() => {
    const mr = mediaRef.current;
    if (mr && mr.state !== 'inactive') {
      try {
        mr.requestData();
      } catch {
        /* 古い実装 */
      }
      mr.stop();
    }
  }, []);
  stopRef.current = stop;

  // 画面を離れるとき（強制的な切替など）は保存を試みる
  useEffect(() => () => {
    if (mediaRef.current && mediaRef.current.state !== 'inactive') mediaRef.current.stop();
    cleanupStream();
  }, []);

  const questions = useMemo(() => diary?.questions ?? [], [diary]);
  const idx = qid === FREE ? questions.length : Math.max(0, questions.findIndex((q) => q.questionId === qid));
  const q = qid === FREE ? null : questions[idx];
  const clips = qid === FREE ? (diary?.freeClips ?? []) : q ? (diary?.clipsByQuestion.get(q.questionId) ?? []) : [];
  const answer = q ? diary?.answers.get(q.questionId) : undefined;
  const go = (i: number) => {
    if (busy) return;
    setRec('idle');
    setError(null);
    setReplaceTarget(null);
    setQid(i >= questions.length ? FREE : questions[Math.max(0, i)].questionId);
  };

  if (!diary || !qid) return <div className="screen">読み込み中…</div>;
  const otherDrafts = drafts.filter((d) => d.id !== draftIdRef.current);

  return (
    <div className="screen diary">
      <header className="diary-head">
        <button className="btn ghost" disabled={busy} onClick={() => navigate('today')}>← {shortDate(date)}</button>
        <strong>音声日記</strong>
        <span>{qid === FREE ? '自由録音' : `${idx + 1}/${questions.length}`}</span>
      </header>
      <p className="muted center">
        回答済み {diary.answeredIds.size} / スキップ {diary.skippedIds.size} / 未回答 {questions.length - diary.answeredIds.size - diary.skippedIds.size}
      </p>

      {otherDrafts.length > 0 && <DraftRecovery drafts={otherDrafts} />}

      <section className="question">
        {q ? (
          <>
            <h1>
              Q{idx + 1}. {q.title}
            </h1>
            <ul className="hints">
              {q.hints.map((h) => (
                <li key={h}>{h}</li>
              ))}
            </ul>
            {diary.skippedIds.has(q.questionId) && <p className="badge">スキップ済み</p>}
          </>
        ) : (
          <>
            <h1>自由録音</h1>
            <p className="muted">質問にとらわれず、続けて話したいときに使います。</p>
          </>
        )}
      </section>

      {clips.length > 0 && (
        <section className="clips">
          {clips.map((c, i) => (
            <div key={c.id} className="clip">
              <AudioPlayer blobId={c.blobId} durationMs={c.durationMs} label={`録音${i + 1}（${formatDuration(c.durationMs)}）${c.interrupted ? '・中断から回復' : ''}`} />
              <div className="clip-actions">
                <button className="btn small ghost" disabled={busy} onClick={() => { setReplaceTarget(c); void start(); }}>
                  録り直し
                </button>
                <button
                  className="btn small ghost danger"
                  disabled={busy}
                  onClick={async () => {
                    if (confirm('この録音を削除しますか？（同期先でも削除扱いになります）')) await removeClip(ctx, c.id);
                  }}
                >
                  削除
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {q && <AnswerNote key={`${date}:${q.questionId}`} questionId={q.questionId} initial={answer?.note ?? ''} />}

      {q && answer && (
        <details className="answer-meta">
          <summary>タグ・公開区分</summary>
          <Field label="タグ">
            <input defaultValue={answer.tags.join(' ')} onBlur={(e) => void updateAnswer(ctx, answer, { tags: parseTags(e.target.value) })} />
          </Field>
          <VisibilitySelect value={answer.visibility} onChange={(visibility) => void updateAnswer(ctx, answer, { visibility })} />
        </details>
      )}

      {error && <p className="error-box" role="alert">{error}</p>}
      <p className="muted small center">録音中は画面を開いたままにしてください。周囲の人を録音・公開する場合は、本人の同意を確認してください。</p>

      <div className="rec-bar">
        <div className={'rec-state ' + rec}>
          {rec === 'recording' && (
            <>
              <span className="rec-dot" aria-hidden>●</span> 録音中 {formatDuration(elapsed)}
              {replaceTarget && '（録り直し）'}
            </>
          )}
          {rec === 'starting' && 'マイクを準備中…'}
          {rec === 'saving' && '保存中…'}
          {rec === 'saved' && '✓ 端末に保存済み'}
          {rec === 'failed' && '✕ 保存失敗'}
          {rec === 'idle' && (recordingSupported() ? '' : '録音に非対応（文字で記録できます）')}
        </div>
        {rec === 'recording' ? (
          <button className="btn rec stop" onClick={stop}>
            ■ 停止して保存
          </button>
        ) : (
          <button className="btn rec" disabled={busy} onClick={() => { setReplaceTarget(null); void start(); }}>
            ● {clips.length ? '追記録音' : '録音開始'}
          </button>
        )}
        <div className="rec-nav">
          <button className="btn small" disabled={busy || idx === 0} onClick={() => go(idx - 1)}>前へ</button>
          {q && (
            <button
              className="btn small"
              disabled={busy}
              onClick={async () => {
                const skipped = diary.skippedIds.has(q.questionId);
                await setSkipped(ctx, trip.id, date, q.questionId, !skipped);
                if (!skipped) go(idx + 1);
              }}
            >
              {diary.skippedIds.has(q.questionId) ? 'スキップ解除' : 'スキップ'}
            </button>
          )}
          <button className="btn small" disabled={busy || qid === FREE} onClick={() => go(idx + 1)}>
            {busy ? '録音中は移動不可' : '次へ'}
          </button>
          <button className="btn small ghost" disabled={busy} onClick={() => setListOpen(true)}>質問一覧</button>
        </div>
      </div>

      {listOpen && (
        <Sheet title="質問一覧" onClose={() => setListOpen(false)}>
          <ul className="qlist">
            {questions.map((x, i) => {
              const st = diary.answeredIds.has(x.questionId) ? '回答済み' : diary.skippedIds.has(x.questionId) ? 'スキップ' : '未回答';
              return (
                <li key={x.questionId}>
                  <button className="row-btn" onClick={() => { go(i); setListOpen(false); }}>
                    <span>Q{i + 1}. {x.title}</span>
                    <span className={'pill ' + (st === '回答済み' ? 'ok' : st === 'スキップ' ? 'skip' : '')}>
                      {st}
                      {(diary.clipsByQuestion.get(x.questionId)?.length ?? 0) > 0 && ` 🎙${diary.clipsByQuestion.get(x.questionId)!.length}`}
                    </span>
                  </button>
                </li>
              );
            })}
            <li>
              <button className="row-btn" onClick={() => { go(questions.length); setListOpen(false); }}>
                <span>自由録音</span>
                <span className="pill">🎙{diary.freeClips.length}</span>
              </button>
            </li>
          </ul>
          <p className="muted small">回答順は自由です。必須の質問はありません。</p>
        </Sheet>
      )}
    </div>
  );
}

function AnswerNote(props: { questionId: string; initial: string }) {
  const { ctx, trip, date, toast } = useApp();
  const key = `itl-draft:answer:${trip.id}:${date}:${props.questionId}`;
  const [text, setText] = useState(() => localStorage.getItem(key) ?? props.initial);
  const [saved, setSaved] = useState(true);
  const save = async () => {
    if (saved) return;
    try {
      await setAnswerNote(ctx, trip.id, date, props.questionId, text);
      localStorage.removeItem(key);
      setSaved(true);
    } catch {
      toast('補足メモを保存できませんでした', { kind: 'error' });
    }
  };
  return (
    <Field label={`補足メモ（文字）${saved ? '' : '・未保存'}`}>
      <textarea
        rows={2}
        value={text}
        placeholder="録音できないときや、話し忘れの補足に"
        onChange={(e) => {
          setText(e.target.value);
          setSaved(false);
          localStorage.setItem(key, e.target.value);
        }}
        onBlur={() => void save()}
      />
      {!saved && (
        <button className="btn small" onClick={() => void save()}>
          補足を保存
        </button>
      )}
    </Field>
  );
}

/** 中断された録音：保存済みクリップとは区別して表示し、回復か破棄を選ぶ */
function DraftRecovery(props: { drafts: RecordingDraft[] }) {
  const { db, ctx, trip, toast } = useApp();
  const [playing, setPlaying] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => () => {
    if (playing) URL.revokeObjectURL(playing.url);
  }, [playing]);
  return (
    <section className="card warn-card">
      <h2>⚠ 中断された録音（未保存）</h2>
      <p className="small">アプリの終了や画面ロックで保存されなかった録音です。途中までの音声は再生できない場合があります。</p>
      {props.drafts.map((d) => {
        const size = d.chunks.reduce((s, c) => s + c.size, 0);
        return (
          <div key={d.id} className="draft">
            <span>
              {d.localDate} {d.questionId ?? '自由録音'}・{formatBytes(size)}・開始 {d.startedAt.slice(11, 16)}(UTC)
            </span>
            {playing?.id === d.id && <audio controls src={playing.url} />}
            <div className="actions">
              <button
                className="btn small"
                disabled={size === 0}
                onClick={() => {
                  if (playing) URL.revokeObjectURL(playing.url);
                  setPlaying({ id: d.id, url: URL.createObjectURL(new Blob(d.chunks, { type: d.mimeType })) });
                }}
              >
                再生してみる
              </button>
              <button
                className="btn small primary"
                disabled={size === 0}
                onClick={async () => {
                  const blob = new Blob(d.chunks, { type: d.mimeType });
                  await saveClip(ctx, { tripId: trip.id, localDate: d.localDate, questionId: d.questionId, blob, mimeType: d.mimeType, ext: d.ext, durationMs: Date.parse(d.updatedAt) - Date.parse(d.startedAt), interrupted: true });
                  await db.drafts.delete(d.id);
                  toast('中断された録音をクリップとして保存しました');
                }}
              >
                クリップとして保存
              </button>
              <button
                className="btn small danger ghost"
                onClick={async () => {
                  if (confirm('この中断された録音を破棄しますか？元に戻せません。')) await db.drafts.delete(d.id);
                }}
              >
                破棄
              </button>
            </div>
          </div>
        );
      })}
    </section>
  );
}
