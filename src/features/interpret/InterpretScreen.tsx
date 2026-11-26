import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { navigate, setNavigationGuard } from '../../app/router';
import { Empty } from '../../components/ui';
import type { Interpretation } from '../../db/types';
import { newId } from '../../lib/ids';
import { formatDuration } from '../../lib/format';
import { supabase } from '../../lib/supabase';
import { extForMime, micErrorMessage, openMic, pickAudioFormat, recordingSupported, requestWakeLock } from '../diary/recorder';
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
  startLiveRecognition,
  submit,
  uploadAudio,
  type LiveRecognition,
  workerState,
  type Mode,
  type WorkerState,
} from './interpretRepo';

const MAX_MS = 60_000;
/** 話し始めたあと、この長さだけ静かなら止める */
const SILENCE_MS = 900;
/** 音声認識で文が確定したあと、この長さだけ続きがなければ止める */
const RECOGNITION_PAUSE_MS = 700;

/**
 * マイクの音量を見て、話し終えた（話し始めたあと静かになった）ら onSilence を呼ぶ。
 * 最初の 0.3 秒で周りの音の大きさを測り、その数倍を「話している」とみなす。戻り値は止める関数。
 */
function watchSilence(stream: MediaStream, onSilence: () => void): () => void {
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AC) return () => undefined;
  const ac = new AC();
  const src = ac.createMediaStreamSource(stream);
  const an = ac.createAnalyser();
  an.fftSize = 1024;
  src.connect(an);
  const buf = new Float32Array(an.fftSize);
  const t0 = Date.now();
  let floor = 0;
  let floorN = 0;
  let spoke = false;
  let lastLoud = Date.now();
  const timer = window.setInterval(() => {
    an.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    const now = Date.now();
    if (now - t0 < 300) {
      floor = (floor * floorN + rms) / ++floorN;
      return;
    }
    const loud = rms > Math.max(0.015, floor * 3);
    if (loud) {
      spoke = true;
      lastLoud = now;
    } else if (spoke && now - lastLoud > SILENCE_MS) {
      stop();
      onSilence();
    }
  }, 50);
  let done = false;
  const stop = () => {
    if (done) return;
    done = true;
    window.clearInterval(timer);
    try {
      src.disconnect();
    } catch {
      /* 切断済み */
    }
    void ac.close().catch(() => undefined);
  };
  return stop;
}
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
  // スマホの音声認識（話しながら文字にする）
  const liveRef = useRef<LiveRecognition | null>(null);
  const liveStopRef = useRef<Promise<string> | null>(null);
  const [liveText, setLiveText] = useState('');
  const vadRef = useRef<(() => void) | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startRef = useRef(0);

  const items = useLiveQuery(() => db.interpretations.orderBy('createdAt').reverse().limit(60).toArray(), [db]) ?? [];
  const current = items.find((i) => i.id === currentId) ?? null;

  // この画面で送った 1 件の訳が届いたら、すぐ全画面で見せる
  const autoShowRef = useRef<string | null>(null);
  useEffect(() => {
    // 聞き取りが出た時点ですぐ開く（確かめる画面）。訳は届きしだい同じ画面に出る
    if (current && current.id === autoShowRef.current && (current.sourceText || current.targetText)) {
      autoShowRef.current = null;
      setBig(current);
    }
  }, [current]);

  // 全画面を開き直したら、前のエラー表示は消す
  const bigId = big?.id;
  useEffect(() => {
    if (bigId) setError(null);
  }, [bigId]);

  // PC の応答状況・履歴の取り込み・未送信の再送
  const sendPending = useCallback(async () => {
    if (!canUsePc || !supabase) return;
    for (const it of await db.interpretations.filter((i) => !!i.audio && !i.audioPath && !!i.inputText && i.status !== 'local').toArray()) {
      await uploadAudio(db, supabase, ws.ownerId!, it).catch(() => undefined);
    }
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
    }, 800);
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
    autoShowRef.current = it.id;
    if (!canUsePc || !supabase) return;
    try {
      await submit(db, supabase, ws.ownerId!, device.id, it);
    } catch {
      toast('いまは送れません。通信が戻ったら自動で送ります（端末に保存済み）');
    }
  };

  const startRec = async (recMode: Mode = mode) => {
    setError(null);
    setLiveText('');
    const fmt = pickAudioFormat();
    if (!fmt) return setError('この端末では録音できません。下の欄に文字で入力してください');
    let stream: MediaStream;
    try {
      stream = await openMic();
    } catch (e) {
      return setError(micErrorMessage(e));
    }
    // 話しながら文字にする言語：「尼→日」と Jawab はインドネシア語、それ以外は日本語
    const liveLang: 'ja' | 'id' = recMode === 'id-ja' ? 'id' : 'ja';
    liveStopRef.current = null;
    // 音声認識で文が確定してから少し続きがなければ、話し終えたとみなして止める
    let pauseTimer: number | null = null;
    liveRef.current = startLiveRecognition(
      liveLang,
      (text, settled) => {
        setLiveText(text);
        if (pauseTimer) window.clearTimeout(pauseTimer);
        if (settled && text) pauseTimer = window.setTimeout(() => stopRef.current(), RECOGNITION_PAUSE_MS);
      },
      () => stopRef.current(),
    );
    vadRef.current = watchSilence(stream, () => stopRef.current());
    streamRef.current = stream;
    const mr = new MediaRecorder(stream, fmt.mimeType ? { mimeType: fmt.mimeType, audioBitsPerSecond: 64000 } : undefined);
    const chunks: Blob[] = [];
    const mimeType = mr.mimeType || fmt.mimeType || 'audio/webm';
    mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    mr.onstop = async () => {
      vadRef.current?.();
      vadRef.current = null;
      stream.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      setRecording(false);
      const blob = new Blob(chunks, { type: mimeType });
      const durationMs = Date.now() - startRef.current;
      // スマホで聞き取れていれば、文字だけを先に送る（家の PC の Whisper を待たない）
      const live = liveRef.current;
      liveRef.current = null;
      const heard = live && !live.failed() ? (await (liveStopRef.current ?? live.stop())).trim() : '';
      liveStopRef.current = null;
      setLiveText('');
      if (heard) {
        await enqueue({
          id: newId(),
          createdAt: new Date().toISOString(),
          mode: liveLang === 'ja' ? 'ja-id' : 'id-ja',
          inputText: heard,
          sourceText: heard,
          audio: blob.size > 0 ? blob : null,
          mimeType,
          ext: extForMime(mimeType, fmt.ext),
          durationMs,
          status: 'local',
          via: 'pc',
        });
        return;
      }
      if (blob.size === 0 || durationMs < 500) return setError('短すぎて録音できませんでした。もう一度どうぞ');
      await enqueue({
        id: newId(),
        createdAt: new Date().toISOString(),
        mode: recMode,
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
    vadRef.current?.();
    vadRef.current = null;
    // 音声認識と録音を同時に止める（認識の最後の文字を取りこぼさない）
    if (liveRef.current && !liveStopRef.current) liveStopRef.current = liveRef.current.stop();
    const mr = mediaRef.current;
    if (mr && mr.state !== 'inactive') mr.stop();
  };
  const stopRef = useRef(stopRec);
  stopRef.current = stopRec;

  const sendText = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    await enqueue({ id: newId(), createdAt: new Date().toISOString(), mode, inputText: t, sourceText: t, status: 'local', via: 'pc' });
  };

  // 全画面は、履歴の最新の内容（速い訳 → 高精度の訳の差し替え）を映す
  const liveBig = big ? (items.find((i) => i.id === big.id) ?? big) : null;

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
      {recording && liveText && <p className="live-text">{liveText}</p>}
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
      {liveBig && (
        <BigCard
          key={liveBig.id}
          item={liveBig}
          onClose={() => setBig(null)}
          // 言い直す：同じ向きでもう一度話す（自動のときは日本語として）
          onRetry={() => void startRec(liveBig.mode === 'auto' ? 'ja-id' : liveBig.mode)}
          // 直す：直した文で訳し直す
          onEdit={(text) =>
            void enqueue({
              id: newId(),
              createdAt: new Date().toISOString(),
              mode: liveBig.mode === 'auto' ? (liveBig.sourceLang === 'id' ? 'id-ja' : 'ja-id') : liveBig.mode,
              inputText: text,
              sourceText: text,
              status: 'local',
              via: 'pc',
            })
          }
          reply={{
            recording,
            elapsed,
            error,
            liveText,
            pending: current && current.id !== liveBig.id && current.status !== 'done' && !current.targetText ? current : null,
            // 返事は、表示中の訳の言語で話してもらい、反対向きに訳す
            start: () => void startRec(liveBig.targetLang === 'ja' ? 'ja-id' : 'id-ja'),
            stop: stopRec,
          }}
        />
      )}
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

/**
 * 相手に見せるための全画面表示。訳文だけを、画面に収まる最大の文字で出す。
 * 読み方・元の文・操作は目立たない小さなボタンにまとめ、必要なときだけ開く。
 */
interface ReplyControls {
  liveText: string;
  recording: boolean;
  elapsed: number;
  error: string | null;
  pending: Interpretation | null;
  start: () => void;
  stop: () => void;
}

/**
 * 日本語を文節に近いかたまりに分ける（Intl.Segmenter の単語に、助詞・句読点などをくっつける）。
 * 全画面ではかたまりの途中で改行しないので、「だいた / い」のような切れ方をしない。
 */
export function japaneseChunks(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: string }) => { segment: (t: string) => Iterable<{ segment: string; isWordLike?: boolean }> } }).Segmenter;
  if (!Seg) return [text];
  const out: string[] = [];
  const attach = /^([ぁ-ゖー]{1,3}|[、。！？!?・…」』）)]+)$/;
  for (const { segment } of new Seg('ja', { granularity: 'word' }).segment(text)) {
    const prev = out[out.length - 1];
    if (/^\s+$/.test(segment)) {
      out.push(segment); // 空白はそのまま区切りにする
      continue;
    }
    // 助詞・句読点と、数字のあとの単位（20分）は前のかたまりにくっつける
    if (prev && !/^\s+$/.test(prev) && (attach.test(segment) || /[0-9０-９]$/.test(prev))) out[out.length - 1] = prev + segment;
    else out.push(segment);
  }
  return out;
}

/** 返事のボタンの文字は、表示中の訳の言語（＝返事をする人の言語）で書く */
const REPLY_TEXT = {
  id: { start: 'Jawab', stop: 'Selesai', wait: 'Sedang menerjemahkan…', fail: 'Maaf, belum bisa diterjemahkan. Coba lagi.' },
  ja: { start: '答える', stop: '終わり', wait: '訳しています…', fail: '訳せませんでした。もう一度どうぞ' },
};

/**
 * 全画面。流れは「話す → 聞き取りが合っているか確かめる → 相手に見せる」。
 * - check：自分が話した直後。聞き取った文を大きく出し、合っていれば「見せる」、違えば言い直すか直す
 * - show ：上下を逆にして、相手に訳文を大きく見せる（相手側に返事のボタン）
 * - read ：相手の返事。訳（日本語）を自分が読む（「答える」ボタン）
 */
function BigCard({
  item,
  onClose,
  reply,
  onRetry,
  onEdit,
}: {
  item: Interpretation;
  onClose: () => void;
  reply: ReplyControls;
  onRetry: () => void;
  onEdit: (text: string) => void;
}) {
  const { toast } = useApp();
  const [flip, setFlip] = useState(false);
  const [details, setDetails] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLParagraphElement>(null);
  const t = item.targetText ?? '';
  const lang: 'ja' | 'id' = (item.targetLang as 'ja' | 'id') ?? (item.mode === 'id-ja' ? 'ja' : 'id');
  const userSpoke = item.mode === 'ja-id' || (item.mode === 'auto' && item.sourceLang === 'ja');
  const phase: 'check' | 'show' | 'read' = flip ? 'show' : userSpoke ? 'check' : 'read';

  // 枠に収まる最大の文字の大きさを探す（画面の向きや大きさが変わったら探し直す）
  const fit = useCallback(() => {
    const box = boxRef.current;
    const el = textRef.current;
    if (!box || !el) return;
    // 大きすぎると読みにくいので、上限は画面の短い辺の 12%（スマホで 45px 前後）
    const cap = Math.max(28, Math.round(Math.min(window.innerWidth, window.innerHeight) * 0.12));
    const largest = () => {
      let lo = 16;
      let hi = cap + 1;
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2);
        el.style.fontSize = `${mid}px`;
        if (el.scrollHeight <= box.clientHeight && el.scrollWidth <= box.clientWidth) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    // 日本語：文節の途中で折り返さない並べ方を試し、文字が 2 割以上小さくなるなら普通に折り返す
    el.classList.remove('chunked');
    const free = largest();
    let size = free;
    if (el.querySelector('.nowrap')) {
      el.classList.add('chunked');
      const chunked = largest();
      if (chunked >= free * 0.8) size = chunked;
      else el.classList.remove('chunked');
    }
    el.style.fontSize = `${size}px`;
  }, []);

  useLayoutEffect(() => {
    fit();
  }, [fit, t, details, phase]);

  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    window.addEventListener('resize', fit);
    let wake: { release: () => void } | null = null;
    void requestWakeLock().then((w) => (wake = w)); // 表示している間は画面を暗くしない
    return () => {
      window.removeEventListener('keydown', on);
      window.removeEventListener('resize', fit);
      wake?.release();
    };
  }, [onClose, fit]);

  const rt = REPLY_TEXT[lang];
  const failed = reply.pending?.status === 'error' || (!!reply.error && !reply.recording);
  const heardLabel = item.audio || item.audioPath ? '聞き取り' : '入力';
  const refining = item.status === 'processing' && !!t;

  // ---------- 確かめる ----------
  if (phase === 'check') {
    return (
      <div className="bigcard" role="dialog" aria-modal="true" aria-label="聞き取りの確認">
        <div className="check">
          <p className="check-label">{reply.recording ? '聞き取り中…' : `${heardLabel}（タップで直せます）`}</p>
          {editing ? (
            <div className="check-edit">
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={3} autoFocus />
              <div className="actions">
                <button
                  className="btn primary"
                  disabled={!draft.trim()}
                  onClick={() => {
                    setEditing(false);
                    onEdit(draft.trim());
                  }}
                >
                  訳し直す
                </button>
                <button className="btn ghost" onClick={() => setEditing(false)}>
                  やめる
                </button>
              </div>
            </div>
          ) : (
            <button
              className="check-source"
              disabled={reply.recording}
              onClick={() => {
                setDraft(item.sourceText ?? '');
                setEditing(true);
              }}
            >
              {reply.recording ? reply.liveText || '…' : item.sourceText || '聞き取り中…'}
            </button>
          )}
          <div className="check-target" lang={lang}>
            {item.status === 'error' ? (
              <span className="bigcard-fail">{item.error ?? '訳せませんでした'}</span>
            ) : t ? (
              <>
                {t}
                {refining && <span className="check-refining">（より正確な訳を確認中…）</span>}
              </>
            ) : (
              <span className="check-wait">訳しています…</span>
            )}
          </div>
          {details && item.reading && <p className="bigcard-reading">{item.reading}</p>}
        </div>
        <div className="check-actions">
          <button className={'btn check-retry' + (reply.recording ? ' on' : '')} onClick={() => (reply.recording ? reply.stop() : onRetry())}>
            {reply.recording ? `■ 終わり ${formatDuration(reply.elapsed)}` : '🎤 言い直す'}
          </button>
          <button className="btn primary check-show" disabled={!t || reply.recording} onClick={() => setFlip(true)}>
            ↻ 見せる
          </button>
        </div>
        <div className="bigcard-actions">
          <span className="bigcard-spacer" />
          {item.reading && (
            <button className={'bigcard-icon' + (details ? ' on' : '')} aria-label="読み方" onClick={() => setDetails((d) => !d)}>
              ア
            </button>
          )}
          <button className="bigcard-icon" aria-label="閉じる" onClick={onClose} disabled={reply.recording}>
            ✕
          </button>
        </div>
      </div>
    );
  }

  // ---------- 見せる／読む ----------
  return (
    <div className={'bigcard' + (flip ? ' flipped' : '')} role="dialog" aria-modal="true" aria-label="訳文">
      {item.sourceText && (
        // 聞き取った元の文。逆さにしても回さず、こちら側から確かめられるようにする
        <p className="bigcard-heard">
          {heardLabel}：{item.sourceText}
          {refining && '（より正確な訳を確認中…）'}
        </p>
      )}
      <div className={'bigcard-main' + (flip ? ' flip' : '')}>
        <div ref={boxRef} className="bigcard-body">
          {t ? (
            <p ref={textRef} className="bigcard-target" lang={lang}>
              {lang === 'ja'
                ? japaneseChunks(t).map((c, i) => (
                    <span key={i} className="nowrap">
                      {c}
                    </span>
                  ))
                : t}
            </p>
          ) : item.status === 'error' ? (
            <p className="bigcard-fail">{item.error ?? rt.fail}</p>
          ) : (
            <p className="bigcard-wait">{rt.wait}</p>
          )}
        </div>
        <div className="bigcard-reply" lang={lang}>
          {reply.recording && reply.liveText && <p className="bigcard-live">{reply.liveText}</p>}
          {reply.pending && reply.pending.status !== 'error' ? (
            <p className="bigcard-wait">{rt.wait}</p>
          ) : (
            <button
              className={'bigcard-mic' + (reply.recording ? ' on' : '')}
              onClick={() => (reply.recording ? reply.stop() : reply.start())}
              aria-label={reply.recording ? rt.stop : rt.start}
            >
              <span aria-hidden>{reply.recording ? '■' : '🎤'}</span> {reply.recording ? `${rt.stop} ${formatDuration(reply.elapsed)}` : rt.start}
            </button>
          )}
          {failed && <p className="bigcard-fail">{rt.fail}</p>}
        </div>
      </div>
      {details && item.reading && (
        <div className="bigcard-details">
          <p className="bigcard-reading">{item.reading}</p>
        </div>
      )}
      <div className="bigcard-actions">
        {flip && (
          <button className="bigcard-show on" onClick={() => setFlip(false)}>
            ↺ 戻す
          </button>
        )}
        <span className="bigcard-spacer" />
        <button className="bigcard-icon" aria-label="読み上げ" onClick={() => !speak(t, lang) && toast('この端末では読み上げられません')} disabled={!t}>
          🔊
        </button>
        {item.reading && (
          <button className={'bigcard-icon' + (details ? ' on' : '')} aria-label="読み方" onClick={() => setDetails((d) => !d)}>
            ア
          </button>
        )}
        <button className="bigcard-icon" aria-label="閉じる" onClick={onClose} disabled={reply.recording}>
          ✕
        </button>
      </div>
    </div>
  );
}
