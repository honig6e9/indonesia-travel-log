import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { navigate, setNavigationGuard } from '../../app/router';
import { Empty } from '../../components/ui';
import type { Interpretation } from '../../db/types';
import { newId } from '../../lib/ids';
import { formatDuration } from '../../lib/format';
import { supabase } from '../../lib/supabase';
import { extForMime, micErrorMessage, openMic, pickAudioFormat, recordingSupported } from '../diary/recorder';
import {
  WAIT_FALLBACK_MS,
  fetchAudio,
  googleTranslateUrl,
  guessLang,
  pullHistory,
  recognizeOnce,
  refresh,
  speak,
  speechRecognitionAvailable,
  submit,
  workerState,
  type Mode,
  type WorkerState,
} from './interpretRepo';

const MAX_MS = 60_000;
const MODE_LABEL: Record<Mode, string> = { auto: '自動', 'ja-id': '日→尼', 'id-ja': '尼→日' };

function ago(iso: string | null) {
  if (!iso) return '記録なし';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}秒前`;
  if (s < 3600) return `${Math.round(s / 60)}分前`;
  if (s < 86400) return `${Math.round(s / 3600)}時間前`;
  return `${Math.round(s / 86400)}日前`;
}

export function InterpretScreen() {
  const { db, ws, session, device, toast, recordingRef } = useApp();
  const canUsePc = !!supabase && !!session && ws.kind === 'cloud' && session.user.id === ws.ownerId;
  const [mode, setModeState] = useState<Mode>(() => (localStorage.getItem('itl-interpret-mode') as Mode) || 'auto');
  const setMode = (m: Mode) => {
    localStorage.setItem('itl-interpret-mode', m);
    setModeState(m);
  };
  const [worker, setWorker] = useState<WorkerState | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [text, setText] = useState('');
  const [big, setBig] = useState<Interpretation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const mediaRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startRef = useRef(0);

  const items = useLiveQuery(() => db.interpretations.orderBy('createdAt').reverse().limit(60).toArray(), [db]) ?? [];
  const current = items.find((i) => i.id === currentId) ?? null;

  // PC の応答状況・履歴の取り込み・未送信の再送
  const sendPending = useCallback(async () => {
    if (!canUsePc || !supabase) return;
    const locals = await db.interpretations.where('status').equals('local').toArray();
    for (const it of locals) {
      if (it.via === 'google') continue;
      try {
        await submit(db, supabase, ws.ownerId!, device.id, it);
      } catch {
        /* 通信が戻ったら再送する */
      }
    }
  }, [canUsePc, db, ws.ownerId, device.id]);

  useEffect(() => {
    if (!canUsePc || !supabase) return;
    const sb = supabase;
    const tick = async () => {
      try {
        setWorker(await workerState(sb));
      } catch {
        setWorker(null);
      }
    };
    void tick();
    void pullHistory(db, sb).catch(() => undefined);
    void sendPending();
    const t = window.setInterval(() => {
      void tick();
      void sendPending();
    }, 15_000);
    window.addEventListener('online', sendPending);
    return () => {
      window.clearInterval(t);
      window.removeEventListener('online', sendPending);
    };
  }, [canUsePc, db, sendPending]);

  // 結果待ちのあいだは 1.5 秒ごとに確かめる
  const waiting = items.some((i) => i.status === 'queued' || i.status === 'processing');
  useEffect(() => {
    if (!waiting || !canUsePc || !supabase) return;
    const sb = supabase;
    const t = window.setInterval(() => {
      void refresh(db, sb).catch(() => undefined);
      setNow(Date.now());
    }, 1500);
    return () => window.clearInterval(t);
  }, [waiting, canUsePc, db]);

  // 録音中は移動させない
  useEffect(() => {
    recordingRef.current = recording;
    setNavigationGuard(recording ? () => '録音中です。もう一度マイクを押して止めてから移動してください' : null);
    return () => setNavigationGuard(null);
  }, [recording, recordingRef]);

  useEffect(() => () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
  }, []);

  const enqueue = async (it: Interpretation) => {
    await db.interpretations.put(it);
    setCurrentId(it.id);
    if (!canUsePc || !supabase) return;
    try {
      await submit(db, supabase, ws.ownerId!, device.id, it);
    } catch {
      toast('いまは送れません。通信が戻ったら自動で送ります（端末に保存済み）');
    }
  };

  const startRec = async () => {
    setError(null);
    const fmt = pickAudioFormat();
    if (!fmt) return setError('この端末では録音できません。下の欄に文字で入力してください');
    let stream: MediaStream;
    try {
      stream = await openMic();
    } catch (e) {
      return setError(micErrorMessage(e));
    }
    streamRef.current = stream;
    const mr = new MediaRecorder(stream, fmt.mimeType ? { mimeType: fmt.mimeType, audioBitsPerSecond: 64000 } : undefined);
    const chunks: Blob[] = [];
    const mimeType = mr.mimeType || fmt.mimeType || 'audio/webm';
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setRecording(false);
      const blob = new Blob(chunks, { type: mimeType });
      const durationMs = Date.now() - startRef.current;
      if (blob.size === 0 || durationMs < 500) return setError('短すぎて録音できませんでした。もう一度どうぞ');
      await enqueue({
        id: newId(),
        createdAt: new Date().toISOString(),
        mode,
        audio: blob,
        mimeType,
        ext: extForMime(mimeType, fmt.ext),
        durationMs,
        status: 'local',
        via: 'pc',
      });
    };
    mediaRef.current = mr;
    startRef.current = Date.now();
    setElapsed(0);
    mr.start();
    setRecording(true);
    const t = window.setInterval(() => {
      const ms = Date.now() - startRef.current;
      setElapsed(ms);
      if (ms >= MAX_MS || mr.state === 'inactive') {
        window.clearInterval(t);
        if (mr.state !== 'inactive') mr.stop();
      }
    }, 200);
  };

  const stopRec = () => {
    const mr = mediaRef.current;
    if (mr && mr.state !== 'inactive') mr.stop();
  };

  const sendText = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    await enqueue({ id: newId(), createdAt: new Date().toISOString(), mode, inputText: t, sourceText: t, status: 'local', via: 'pc' });
  };

  const pcDown = !canUsePc || (worker !== null && !worker.online);
  const stuck = !!current && (current.status === 'queued' || current.status === 'local') && now - Date.parse(current.createdAt) > WAIT_FALLBACK_MS;

  return (
    <div className="screen interpret">
      <header className="diary-head">
        <strong>通訳</strong>
        <span className={'pill ' + (canUsePc && worker?.online ? 'ok' : 'skip')}>
          {!canUsePc ? '家の PC：ログインが必要' : worker === null ? '家の PC：確認中' : worker.online ? `家の PC：接続中（${ago(worker.lastSeen)}）` : `家の PC：応答なし（最終 ${ago(worker.lastSeen)}）`}
        </span>
      </header>

      <div className="segmented">
        {(Object.keys(MODE_LABEL) as Mode[]).map((m) => (
          <button key={m} className={mode === m ? 'on' : ''} onClick={() => setMode(m)}>
            {MODE_LABEL[m]}
          </button>
        ))}
      </div>

      <button
        className={'mic-big' + (recording ? ' on' : '')}
        onClick={() => (recording ? stopRec() : void startRec())}
        disabled={!recordingSupported()}
        aria-label={recording ? '録音を止めて訳す' : '話して訳す'}
      >
        <span className="mic-icon" aria-hidden>{recording ? '■' : '🎤'}</span>
        <span>{recording ? `止めて訳す ${formatDuration(elapsed)}` : '押して話す'}</span>
      </button>
      {error && <p className="error-box">{error}</p>}

      <div className="add-row">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void sendText()} placeholder="文字で入力して訳す" aria-label="訳す文" />
        <button className="btn primary" onClick={() => void sendText()}>訳す</button>
      </div>

      {current && <ResultCard item={current} onBig={() => setBig(current)} />}

      {(pcDown || stuck) && <Fallback item={current} mode={mode} reason={!canUsePc ? 'login' : stuck ? 'stuck' : 'down'} />}

      <h2>履歴</h2>
      {items.length === 0 ? (
        <Empty>まだ通訳の履歴はありません。</Empty>
      ) : (
        <ul className="list">
          {items.map((it) => (
            <li key={it.id}>
              <button className="row-btn interp-row" onClick={() => (it.targetText ? setBig(it) : setCurrentId(it.id))}>
                <span className="small muted">
                  {new Date(it.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}　{statusLabel(it)}
                </span>
                <span>{it.sourceText ?? (it.audio || it.audioPath ? '（音声）' : '')}</span>
                {it.targetText && <strong>{it.targetText}</strong>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!canUsePc && (
        <p className="small muted">
          家の PC で訳すには、設定の「アカウント・端末」でログインしてください。<button className="link" onClick={() => navigate('settings/account')}>ログインへ</button>
        </p>
      )}
      <p className="small muted">相手の声を録るときは、相手の了解をとってください。音声と訳はご自身の Supabase と家の PC に保存されます。</p>
      {big && <BigCard item={big} onClose={() => setBig(null)} />}
    </div>
  );
}

function statusLabel(it: Interpretation) {
  if (it.via === 'google') return 'Google 翻訳で表示';
  switch (it.status) {
    case 'local':
      return '未送信（端末に保存済み）';
    case 'queued':
      return '家の PC の順番待ち';
    case 'processing':
      return '家の PC で処理中';
    case 'done':
      return `完了${it.provider ? `（${it.provider}）` : ''}`;
    case 'error':
      return '失敗';
  }
}

function ResultCard({ item, onBig }: { item: Interpretation; onBig: () => void }) {
  const { db, toast } = useApp();
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);
  const lang = (item.targetLang as 'ja' | 'id') ?? 'id';
  return (
    <section className="card result-card">
      <p className="small muted">{statusLabel(item)}</p>
      {item.sourceText && <p className="source">{item.sourceText}</p>}
      {item.status === 'done' && item.targetText ? (
        <>
          <p className="target">{item.targetText}</p>
          {item.reading && <p className="reading">{item.reading}</p>}
          <div className="actions">
            <button className="btn primary" onClick={onBig}>大きく表示</button>
            <button className="btn" onClick={() => !speak(item.targetText!, lang) && toast('この端末では読み上げられません')}>🔊 読み上げ</button>
          </div>
        </>
      ) : item.status === 'error' ? (
        <p className="error-box">{item.error ?? '訳せませんでした'}</p>
      ) : (
        <p className="waiting">{item.status === 'processing' ? '家の PC で文字にして訳しています…' : item.status === 'queued' ? '家の PC に送りました。順番を待っています…' : '送信待ちです（端末に保存済み）'}</p>
      )}
      {(item.audio || item.audioPath) && (
        <div>
          {audioUrl ? (
            <audio controls src={audioUrl} />
          ) : (
            <button
              className="btn small ghost"
              onClick={async () => {
                try {
                  const b = item.audio ?? (supabase ? await fetchAudio(db, supabase, item) : null);
                  if (b) setAudioUrl(URL.createObjectURL(b));
                } catch {
                  toast('音声を取得できませんでした', { kind: 'error' });
                }
              }}
            >
              元の音声を再生
            </button>
          )}
        </div>
      )}
    </section>
  );
}

/** 家の PC につながらないときの代わり：Chrome の音声認識で文字にして Google 翻訳で開く */
function Fallback({ item, mode, reason }: { item: Interpretation | null; mode: Mode; reason: 'login' | 'down' | 'stuck' }) {
  const { db, toast } = useApp();
  const [listening, setListening] = useState<null | { stop: () => void }>(null);
  const [heard, setHeard] = useState<{ text: string; lang: 'ja' | 'id' } | null>(null);
  const known = heard?.text ?? item?.inputText ?? item?.sourceText ?? null;
  const knownLang = heard?.lang ?? (known ? guessLang(known) : 'ja');

  const open = async (src: string, from: 'ja' | 'id') => {
    const to = from === 'ja' ? 'id' : 'ja';
    window.open(googleTranslateUrl(src, from, to), '_blank', 'noopener');
    await db.interpretations.put({
      id: newId(),
      createdAt: new Date().toISOString(),
      mode: from === 'ja' ? 'ja-id' : 'id-ja',
      sourceText: src,
      sourceLang: from,
      targetLang: to,
      status: 'done',
      via: 'google',
    });
  };

  const listen = (lang: 'ja' | 'id') => {
    const r = recognizeOnce(lang);
    setListening(r);
    // 開くのはボタンを押したとき（自動で開くと、ポップアップとして止められることがある）
    r.promise
      .then((t) => setHeard({ text: t, lang }))
      .catch((e: Error) => toast(e.message, { kind: 'error' }))
      .finally(() => setListening(null));
  };

  const langs: ('ja' | 'id')[] = mode === 'ja-id' ? ['ja'] : mode === 'id-ja' ? ['id'] : ['ja', 'id'];
  return (
    <section className="card warn-card">
      <h2>代わりの方法</h2>
      <p className="small">
        {reason === 'login'
          ? '家の PC を使うにはログインが必要です。'
          : reason === 'stuck'
            ? '家の PC からまだ返事がありません。'
            : '家の PC が応答していません。'}
        下の方法なら PC なしで訳せます（Chrome の音声認識と Google 翻訳を使います。通信が必要です）。
        {reason !== 'login' && ' 送った音声は端末と Supabase に保存してあり、PC が戻れば自動で訳されます。'}
      </p>
      {known && (
        <button className="btn primary" onClick={() => void open(known, knownLang)}>
          「{known.slice(0, 20)}{known.length > 20 ? '…' : ''}」を Google 翻訳で開く
        </button>
      )}
      {speechRecognitionAvailable() ? (
        listening ? (
          <button className="btn primary" onClick={() => listening.stop()}>■ 聞き取りを止める</button>
        ) : (
          <div className="actions">
            {langs.map((l) => (
              <button key={l} className="btn" onClick={() => listen(l)}>
                {l === 'ja' ? '🎤 日本語で話す' : '🎤 インドネシア語で話す'}
              </button>
            ))}
          </div>
        )
      ) : (
        <p className="small muted">この端末では Chrome の音声認識が使えません。上の欄に文字で入力し、キーボードのマイクも使えます。</p>
      )}
      <p className="small muted">通信もないときは、履歴の訳を「大きく表示」で見せられます。</p>
    </section>
  );
}

/** 相手に見せるための全画面表示。「向きを変える」で、向かいの相手に読みやすく 180 度回せる */
function BigCard({ item, onClose }: { item: Interpretation; onClose: () => void }) {
  const { toast } = useApp();
  const [flip, setFlip] = useState(false);
  const t = item.targetText ?? '';
  const size = t.length <= 16 ? '14vw' : t.length <= 40 ? '10vw' : t.length <= 90 ? '8vw' : '6vw';
  const lang = (item.targetLang as 'ja' | 'id') ?? 'id';
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="bigcard" role="dialog" aria-modal="true" aria-label="大きく表示">
      <div className={'bigcard-body' + (flip ? ' flip' : '')}>
        <p className="bigcard-target" style={{ fontSize: size }} lang={lang}>{t}</p>
        {item.reading && <p className="bigcard-reading">{item.reading}</p>}
        {item.sourceText && <p className="bigcard-source">{item.sourceText}</p>}
      </div>
      <div className="bigcard-actions">
        <button className="btn" onClick={() => !speak(t, lang) && toast('この端末では読み上げられません')}>🔊 読み上げ</button>
        <button className="btn" onClick={() => setFlip((f) => !f)}>↻ 向きを変える</button>
        <button className="btn primary" onClick={onClose}>閉じる</button>
      </div>
    </div>
  );
}
