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
  findCachedTranslation,
  fixTranslation,
} from './interpretRepo';

const MAX_MS = 60_000;
const LIVE_STATUS_KEY = 'itl-live-status';
/** 高速モードで録音も一緒にするか（同時に使えない端末では off にする） */
const LIVE_REC_KEY = 'itl-live-rec';
const LIVE_REC_MISS_KEY = 'itl-live-rec-miss';
/** 録音がこれより小さい音しか拾えていなければ、無音（マイクを取り合って録れていない）とみなす */
const SILENT_PEAK = 0.02;

/**
 * 音声認識と並べて録音する（高速モード用）。音声認識がマイクをつかんでから始めるので、
 * 端末によっては無音しか録れない。そのときは peak が小さくなるので、呼び出し側で捨てる。
 */
interface SideRecording {
  stop: () => Promise<{ blob: Blob; mimeType: string; ext: string; peak: number } | null>;
}
async function startSideRecording(): Promise<SideRecording | null> {
  const fmt = pickAudioFormat();
  if (!fmt) return null;
  let stream: MediaStream;
  try {
    stream = await openMic();
  } catch {
    return null;
  }
  const mr = new MediaRecorder(stream, fmt.mimeType ? { mimeType: fmt.mimeType, audioBitsPerSecond: 64000 } : undefined);
  const mimeType = mr.mimeType || fmt.mimeType || 'audio/webm';
  const chunks: Blob[] = [];
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  // 録れている音の大きさ（最大）を測る
  let peak = 0;
  const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  const ac = AC ? new AC() : null;
  const an = ac?.createAnalyser();
  const src = ac && an ? ac.createMediaStreamSource(stream) : null;
  if (src && an) src.connect(an);
  const buf = new Float32Array(an?.fftSize ?? 0);
  const timer = an
    ? window.setInterval(() => {
        an.getFloatTimeDomainData(buf);
        for (const v of buf) if (Math.abs(v) > peak) peak = Math.abs(v);
      }, 60)
    : null;
  mr.start();
  return {
    stop: () =>
      new Promise((resolve) => {
        const done = () => {
          if (timer) window.clearInterval(timer);
          stream.getTracks().forEach((t) => t.stop());
          void ac?.close().catch(() => undefined);
          const blob = new Blob(chunks, { type: mimeType });
          resolve(blob.size ? { blob, mimeType, ext: extForMime(mimeType, fmt.ext), peak: an ? peak : 1 } : null);
        };
        if (mr.state === 'inactive') return done();
        mr.onstop = done;
        try {
          mr.stop();
        } catch {
          done();
        }
      }),
  };
}

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
/** 国旗（絵文字の国旗が出ない端末でも同じに見えるよう、図で描く） */
function Flag({ lang }: { lang: 'ja' | 'id' }) {
  return (
    <svg className="mic-flag" viewBox="0 0 30 20" aria-hidden>
      {lang === 'ja' ? (
        <>
          <rect width="30" height="20" fill="#fff" />
          <circle cx="15" cy="10" r="6" fill="#bc002d" />
        </>
      ) : (
        <>
          <rect width="30" height="10" fill="#e70011" />
          <rect y="10" width="30" height="10" fill="#fff" />
        </>
      )}
      <rect width="30" height="20" fill="none" stroke="rgba(0,0,0,.25)" />
    </svg>
  );
}

/** 訳した AI の表示名 */
export const PROVIDER_LABEL: Record<string, string> = {
  claude: 'Claude',
  codex: 'ChatGPT',
  gemini: 'Gemini',
  ollama: 'ローカル AI',
  google: 'Google 翻訳',
};
const providerName = (p?: string | null) => (p ? (PROVIDER_LABEL[p] ?? p) : '');

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
  // 文字で入力したときは、言語を家の PC で見分ける。話すときは国旗のボタンで言語を決める
  const mode: Mode = 'auto';
  const [recLang, setRecLang] = useState<'ja' | 'id' | null>(null);
  const [worker, setWorker] = useState<WorkerState | null>(null);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [text, setText] = useState('');
  const [big, setBig] = useState<Interpretation | null>(null);
  // よく使う文は「隣に見せる」状態ですぐ出す
  const [bigInit, setBigInit] = useState<'none' | 'side'>('none');
  const openBig = (it: Interpretation, init: 'none' | 'side' = 'none') => {
    setBigInit(init);
    setBig(it);
  };
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const mediaRef = useRef<MediaRecorder | null>(null);
  // スマホの音声認識（話しながら文字にする）
  const liveRef = useRef<LiveRecognition | null>(null);
  const liveStopRef = useRef<Promise<string> | null>(null);
  const [liveText, setLiveText] = useState('');
  const vadRef = useRef<(() => void) | null>(null);
  const [liveStatus, setLiveStatusState] = useState(() => {
    const v = localStorage.getItem(LIVE_STATUS_KEY) ?? '';
    // 以前の方式（録音と音声認識を同時に使う）の表示は、いまは当てはまらないので出さない
    return /^(使え|録音と同時|この端末では音声認識が使えません)/.test(v) ? '' : v;
  });
  const setLiveStatus = (s: string) => {
    localStorage.setItem(LIVE_STATUS_KEY, s);
    setLiveStatusState(s);
  };
  const liveTimerRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const startRef = useRef(0);

  // 未整理ボックスの翻訳依頼は通訳の履歴に出さない
  const items = useLiveQuery(async () => (await db.interpretations.orderBy('createdAt').reverse().limit(120).toArray()).filter((i) => !i.inboxId).slice(0, 60), [db]) ?? [];
  const current = items.find((i) => i.id === currentId) ?? null;

  // この画面で送った 1 件の訳が届いたら、すぐ全画面で見せる
  const autoShowRef = useRef<string | null>(null);
  useEffect(() => {
    // 聞き取りが出た時点ですぐ開く（確かめる画面）。訳は届きしだい同じ画面に出る
    if (current && current.id === autoShowRef.current && (current.sourceText || current.targetText)) {
      autoShowRef.current = null;
      setBigInit('none');
      setBig(current);
    }
  }, [current]);

  // 全画面を開いたら履歴に 1 つ積み、スマホの「戻る」では全画面だけを閉じる（通訳の画面に戻る）
  const bigOpen = !!big;
  const pushedRef = useRef(false);
  useEffect(() => {
    if (!bigOpen) {
      pushedRef.current = false;
      return;
    }
    if (!pushedRef.current) {
      history.pushState({ itlBig: true }, '', location.hash);
      pushedRef.current = true;
    }
    const onPop = () => {
      pushedRef.current = false;
      setBig(null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [bigOpen]);
  // ✕ で閉じるときも、積んだ分を戻す（戻ると popstate で閉じる）
  const closeBig = () => {
    if (pushedRef.current && (history.state as { itlBig?: boolean } | null)?.itlBig) history.back();
    else setBig(null);
  };

  // よく使う（☆）
  const favorites = useLiveQuery(() => db.interpretations.filter((i) => !!i.favorite).toArray(), [db]) ?? [];
  const toggleFavorite = (it: Interpretation) => void db.interpretations.update(it.id, { favorite: !it.favorite });

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

  const enqueue = async (it: Interpretation, opts: { fresh?: boolean } = {}) => {
    if (!it.speaker) it = { ...it, speaker: speakerRef.current };
    // 過去に同じ文を訳していれば、その訳を使う（通信も家の PC も要らない）。「訳し直す」のときは使わない
    const text = it.inputText?.trim();
    if (text && !opts.fresh) {
      const src: 'ja' | 'id' = it.mode === 'ja-id' ? 'ja' : it.mode === 'id-ja' ? 'id' : guessLang(text);
      const hit = await findCachedTranslation(db, text, src);
      if (hit) {
        await db.interpretations.put({
          ...it,
          status: 'done',
          sourceLang: hit.sourceLang,
          targetLang: hit.targetLang,
          targetText: hit.targetText,
          reading: hit.reading,
          provider: hit.provider,
          manual: hit.manual,
          cachedFrom: hit.id,
        });
        setCurrentId(it.id);
        autoShowRef.current = it.id;
        return;
      }
    }
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

  /** 音声認識だけで聞き取る（録音しない）。マイクを取り合う端末向け */
  const startLiveOnly = (recMode: Mode): boolean => {
    const liveLang: 'ja' | 'id' = recMode === 'id-ja' ? 'id' : 'ja';
    let pauseTimer: number | null = null;
    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      if (pauseTimer) window.clearTimeout(pauseTimer);
      if (liveTimerRef.current) window.clearInterval(liveTimerRef.current);
      const live = liveRef.current;
      liveRef.current = null;
      if (sideTimer) window.clearTimeout(sideTimer);
      const [heardRaw, audio] = await Promise.all([live ? live.stop() : Promise.resolve(''), side ? side.then((s) => s?.stop() ?? null) : Promise.resolve(null)]);
      const heard = heardRaw.trim();
      setRecording(false);
      setLiveText('');
      const usable = !!audio && audio.peak >= SILENT_PEAK;
      if (side) {
        // 録音を一緒にしたら聞き取れなくなった・無音しか録れなかった、が 2 回続いたら、録音はやめる
        if ((!heard && Date.now() - startRef.current > 1500) || (heard && !usable)) {
          const misses = Number(localStorage.getItem(LIVE_REC_MISS_KEY) ?? '0') + 1;
          localStorage.setItem(LIVE_REC_MISS_KEY, String(misses));
          if (misses >= 2) localStorage.setItem(LIVE_REC_KEY, 'off');
        } else if (heard && usable) {
          localStorage.removeItem(LIVE_REC_MISS_KEY);
        }
      }
      if (!heard) {
        const err = live?.error();
        setLiveStatus(`音声認識だけで動かしています（直前：${err ?? '聞き取れませんでした'}）`);
        return setError('聞き取れませんでした。もう一度どうぞ');
      }
      setLiveStatus(
        usable
          ? '音声認識で動かしています（録音も残します）'
          : localStorage.getItem(LIVE_REC_KEY) === 'off'
            ? '音声認識だけで動かしています（この端末では同時に録音できないため、録音は残りません）'
            : '音声認識だけで動かしています（今回は録音できませんでした）',
      );
      await enqueue({
        id: newId(),
        createdAt: new Date().toISOString(),
        mode: liveLang === 'ja' ? 'ja-id' : 'id-ja',
        inputText: heard,
        sourceText: heard,
        ...(usable && audio ? { audio: audio.blob, mimeType: audio.mimeType, ext: audio.ext, durationMs: Date.now() - startRef.current } : {}),
        status: 'local',
        via: 'pc',
      });
    };
    // 音声認識がマイクを使い始めてから録音を始める（先に録音すると音声認識が聞き取れない端末がある）
    let side: Promise<SideRecording | null> | null = null;
    let sideTimer: number | null = null;
    const wantRec = localStorage.getItem(LIVE_REC_KEY) !== 'off';
    const beginSide = () => {
      if (!wantRec || side || finished) return;
      if (sideTimer) window.clearTimeout(sideTimer);
      side = startSideRecording();
    };
    const live = startLiveRecognition(
      liveLang,
      (text, settled) => {
        setLiveText(text);
        if (pauseTimer) window.clearTimeout(pauseTimer);
        if (settled && text) pauseTimer = window.setTimeout(() => void finish(), RECOGNITION_PAUSE_MS);
      },
      () => void finish(),
      beginSide,
    );
    if (!live) return false;
    // 「マイクを使い始めた」合図が来ない端末では、少し待ってから始める
    if (wantRec) sideTimer = window.setTimeout(beginSide, 600);
    liveRef.current = live;
    stopLiveOnlyRef.current = () => void finish();
    startRef.current = Date.now();
    setElapsed(0);
    setRecording(true);
    liveTimerRef.current = window.setInterval(() => {
      const ms = Date.now() - startRef.current;
      setElapsed(ms);
      if (ms >= MAX_MS) void finish();
    }, 200);
    return true;
  };
  const stopLiveOnlyRef = useRef<(() => void) | null>(null);
  const speakerRef = useRef<'me' | 'them'>('me');

  const startRec = async (recMode: Mode, speaker: 'me' | 'them' = 'me') => {
    speakerRef.current = speaker;
    setRecLang(recMode === 'id-ja' ? 'id' : 'ja');
    setError(null);
    setLiveText('');
    // 日本語は常にスマホの音声認識で文字にする（高速モード。家の PC の文字起こしを待たない）。
    // インドネシア語は録音して家の PC の Whisper で文字にする（スマホの聞き取りが働かない端末があるため）
    if (recMode === 'ja-id' && speechRecognitionAvailable()) {
      stopLiveOnlyRef.current = null;
      if (startLiveOnly(recMode)) return;
    }
    stopLiveOnlyRef.current = null;
    const fmt = pickAudioFormat();
    if (!fmt) return setError('この端末では録音できません。下の欄に文字で入力してください');
    let stream: MediaStream;
    try {
      stream = await openMic();
    } catch (e) {
      return setError(micErrorMessage(e));
    }
    // 録音の方式では、スマホの音声認識は使わない（録音と取り合って聞き取れない端末があるため）。
    // 話し終えたかは音の大きさで判断する
    const liveLang: 'ja' | 'id' = recMode === 'id-ja' ? 'id' : 'ja';
    liveStopRef.current = null;
    liveRef.current = null;
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
    if (stopLiveOnlyRef.current) {
      const f = stopLiveOnlyRef.current;
      stopLiveOnlyRef.current = null;
      return f();
    }
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
    speakerRef.current = 'me';
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

      {favorites.length > 0 && (
        <section className="favorites" aria-label="よく使う">
          <p className="small muted">☆ よく使う（押すとすぐ見せられます）</p>
          <div className="fav-list">
            {favorites.map((f) => (
              <button key={f.id} className="fav-chip" onClick={() => openBig(f, 'side')}>
                <span className="fav-main">{displayText(f)}</span>
                {f.sourceText && displayText(f) !== f.sourceText && <span className="fav-sub">{f.sourceText}</span>}
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="mic-pair">
        {(
          [
            ['ja', '日本語で話す', 'ja-id', 'me'],
            ['id', 'Bahasa Indonesia', 'id-ja', 'them'],
          ] as const
        ).map(([lang, label, recMode, speaker]) => {
          const active = recording && recLang === lang;
          return (
            <button
              key={lang}
              className={'mic-big' + (active ? ' on' : '')}
              onClick={() => (active ? stopRec() : void startRec(recMode, speaker))}
              disabled={!recordingSupported() || (recording && !active)}
              aria-label={active ? '録音を止めて訳す' : label}
            >
              <Flag lang={lang} />
              <span className="mic-icon" aria-hidden>{active ? '■' : '🎤'}</span>
              <span>{active ? `止めて訳す ${formatDuration(elapsed)}` : label}</span>
            </button>
          );
        })}
      </div>
      {recording && liveText && <p className="live-text">{liveText}</p>}
      {liveStatus && (
        <p className="small muted live-status">
          日本語（高速モード）：{liveStatus}
          {localStorage.getItem(LIVE_REC_KEY) === 'off' && (
            <button
              className="link"
              onClick={() => {
                localStorage.removeItem(LIVE_REC_KEY);
                localStorage.removeItem(LIVE_REC_MISS_KEY);
                setLiveStatus('音声認識で動かしています（次から録音も試します）');
              }}
            >
              録音も試す
            </button>
          )}
        </p>
      )}
      {error && <p className="error-box">{error}</p>}

      <div className="add-row">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void sendText()} placeholder="文字で入力して訳す" aria-label="訳す文" />
        <button className="btn primary" onClick={() => void sendText()}>訳す</button>
      </div>

      {current && <ResultCard item={current} onBig={() => openBig(current)} />}

      {(pcDown || stuck) && <Fallback item={current} mode={mode} reason={!canUsePc ? 'login' : stuck ? 'stuck' : 'down'} />}

      <h2>履歴</h2>
      {items.length === 0 ? (
        <Empty>まだ通訳の履歴はありません。</Empty>
      ) : (
        <ul className="list">
          {items.map((it) => (
            <li key={it.id} className="interp-li">
              <button
                className={'star' + (it.favorite ? ' on' : '')}
                aria-label={it.favorite ? 'よく使うから外す' : 'よく使うに入れる'}
                aria-pressed={!!it.favorite}
                onClick={() => toggleFavorite(it)}
              >
                {it.favorite ? '★' : '☆'}
              </button>
              <button className="row-btn interp-row" onClick={() => (it.targetText ? openBig(it) : setCurrentId(it.id))}>
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
          onClose={closeBig}
          initialShow={bigInit}
          onToggleFavorite={() => toggleFavorite(liveBig)}
          // 言い直す：同じ向きでもう一度話す（自動のときは日本語として）
          onRetry={() => void startRec(liveBig.mode === 'auto' ? 'ja-id' : liveBig.mode, 'me')}
          // 直す：直した文で訳し直す
          onFix={(text) => void fixTranslation(db, liveBig.id, text).then(() => toast('訳を直しました（自動翻訳で上書きしません）'))}
          onRetranslate={() =>
            void enqueue(
              {
                speaker: liveBig.speaker ?? 'me',
                id: newId(),
                createdAt: new Date().toISOString(),
                mode: liveBig.mode === 'auto' ? (liveBig.sourceLang === 'id' ? 'id-ja' : 'ja-id') : liveBig.mode,
                inputText: liveBig.sourceText ?? '',
                sourceText: liveBig.sourceText ?? '',
                status: 'local',
                via: 'pc',
              },
              { fresh: true },
            )
          }
          onEdit={(text) =>
            void enqueue({
              speaker: 'me',
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
            start: (sp) => void startRec(sp === 'them' ? 'id-ja' : 'ja-id', sp),
            stop: stopRec,
          }}
        />
      )}
    </div>
  );
}

function statusLabel(it: Interpretation) {
  if (it.via === 'google') return '未翻訳（Google 翻訳で表示）';
  switch (it.status) {
    case 'local':
      return '翻訳待ち（未送信・端末に保存済み）';
    case 'queued':
      return '翻訳待ち（家の PC の順番待ち）';
    case 'processing':
      return '翻訳中';
    case 'done':
      if (it.manual) return '手動修正済み';
      if (it.cachedFrom) return '翻訳済み（過去の訳を再利用）';
      return `翻訳済み${it.provider ? `（${providerName(it.provider)}で翻訳）` : ''}`;
    case 'error':
      return '翻訳失敗';
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
  /** 返事を録る。them＝相手（Jawab）、me＝自分（答える） */
  start: (speaker: 'me' | 'them') => void;
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

/** 全画面に大きく出す文：自分の発言は相手向け（インドネシア語）、相手の発言は自分向け（日本語） */
function displayText(item: Interpretation): string {
  const speaker = item.speaker ?? (item.mode === 'id-ja' ? 'them' : 'me');
  const lang = speaker === 'them' ? 'ja' : 'id';
  return (item.sourceLang === lang ? item.sourceText : item.targetText) ?? item.targetText ?? item.sourceText ?? '';
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 古い仕組みでコピーする
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
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
  initialShow = 'none',
  onToggleFavorite,
  onFix,
  onRetranslate,
}: {
  item: Interpretation;
  onClose: () => void;
  reply: ReplyControls;
  onRetry: () => void;
  onEdit: (text: string) => void;
  initialShow?: 'none' | 'side';
  onToggleFavorite: () => void;
  onFix: (text: string) => void;
  onRetranslate: () => void;
}) {
  const { toast } = useApp();
  // 見せ方：none＝まだ見せていない、face＝向かいの人に（上下反転）、side＝隣の人に（向きはそのまま）
  const [show, setShow] = useState<'none' | 'face' | 'side'>(initialShow);
  const flip = show === 'face';
  const [details, setDetails] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLParagraphElement>(null);
  // 自分が話した文は相手（インドネシア語）向けに、相手が話した文は自分（日本語）向けに出す。
  // 話した言語が読む人の言語と同じなら（相手が日本語で答えた など）、訳さずにそのまま出す
  const speaker = item.speaker ?? (item.mode === 'id-ja' ? 'them' : 'me');
  const lang: 'ja' | 'id' = speaker === 'them' ? 'ja' : 'id';
  const t = (item.sourceLang === lang ? item.sourceText : item.targetText) ?? '';
  const userSpoke = speaker === 'me';
  const phase: 'check' | 'show' | 'read' = show !== 'none' ? 'show' : userSpoke ? 'check' : 'read';

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
  const via = refining ? 'ローカル AI の速い訳（より正確な訳を確認中…）' : item.status === 'done' && item.provider ? `${providerName(item.provider)}で翻訳` : '';
  const via2 = item.manual ? '手動修正済み' : item.cachedFrom ? '過去の訳を再利用' : '';
  // 訳を手で直す（以後、自動翻訳で上書きしない）
  const fix = () => {
    const v = window.prompt('訳を直してください（自動翻訳で上書きしません）', t);
    if (v != null && v.trim() && v.trim() !== t) onFix(v.trim());
  };
  const retranslate = () => {
    if (!item.sourceText) return;
    if (item.manual && !window.confirm('手で直した訳はこのまま履歴に残ります。新しく訳し直しますか？')) return;
    onRetranslate();
  };
  const copy = (text: string | null | undefined, what: string) =>
    void copyText(text ?? '').then((ok) => toast(ok ? `${what}をコピーしました` : 'コピーできませんでした'));

  // ---------- 確かめる ----------
  if (phase === 'check') {
    return (
      <div className="bigcard" role="dialog" aria-modal="true" aria-label="聞き取りの確認">
        <div className="bigcard-check">
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
              t
            ) : (
              <span className="check-wait">訳しています…</span>
            )}
          </div>
          {details && item.reading && <p className="bigcard-reading">{item.reading}</p>}
          <div className="check-meta">
            <span className="check-via">{via2 || via}</span>
            <button className="bigcard-copy" disabled={!t || reply.recording} onClick={fix}>
              ✎ 訳を直す
            </button>
            <button className="bigcard-copy" disabled={!item.sourceText || reply.recording || item.status !== 'done'} onClick={retranslate}>
              ↻ 訳し直す
            </button>
            <button className="bigcard-copy" disabled={!item.sourceText || reply.recording} onClick={() => copy(item.sourceText, '聞き取り')}>
              📋 聞き取り
            </button>
            <button className="bigcard-copy" disabled={!t} onClick={() => copy(t, '訳')}>
              📋 訳
            </button>
          </div>
        </div>
        <div className="check-actions">
          <button className={'btn check-retry' + (reply.recording ? ' on' : '')} onClick={() => (reply.recording ? reply.stop() : onRetry())}>
            {reply.recording ? `■ 終わり ${formatDuration(reply.elapsed)}` : '🎤 言い直す'}
          </button>
          <div className="check-show-pair">
            <button className="btn primary check-show" disabled={!t || reply.recording} onClick={() => setShow('face')}>
              ↻ 向かいに見せる
            </button>
            <button className="btn check-show-side" disabled={!t || reply.recording} onClick={() => setShow('side')}>
              → 隣に見せる
            </button>
          </div>
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
          {(via2 || via) && <span className="bigcard-via">　{via2 || via}</span>}
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
              onClick={() => (reply.recording ? reply.stop() : reply.start(phase === 'read' ? 'me' : 'them'))}
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
        {show !== 'none' && (
          <button className="bigcard-show on" onClick={() => setShow('none')}>
            ↺ 戻す
          </button>
        )}
        <span className="bigcard-spacer" />
        <button className="bigcard-copy" aria-label="聞き取った文をコピー" onClick={() => copy(item.sourceText, '聞き取り')} disabled={!item.sourceText}>
          📋元
        </button>
        <button className="bigcard-copy" aria-label="訳文をコピー" onClick={() => copy(t, '訳')} disabled={!t}>
          📋訳
        </button>
        <button className="bigcard-icon" aria-label="訳を直す" onClick={fix} disabled={!t || reply.recording}>
          ✎
        </button>
        <button className={'bigcard-icon' + (item.favorite ? ' fav-on' : '')} aria-label={item.favorite ? 'よく使うから外す' : 'よく使うに入れる'} onClick={onToggleFavorite}>
          {item.favorite ? '★' : '☆'}
        </button>
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
