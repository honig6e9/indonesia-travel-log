import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useApp } from '../../app/context';
import { navigate } from '../../app/router';
import { Empty, Field } from '../../components/ui';
import { safeHttpUrl } from '../../lib/url';
import { TARGET_LABEL } from './inboxRepo';
import {
  importerUrl,
  RANGE_LABEL,
  rangeToIso,
  setImporterUrl,
  tzOffset,
  WA_ACTION_LABEL,
  WA_CATEGORIES,
  WA_CATEGORY_LABEL,
  WA_STATUS_LABEL,
  waApi,
  type RangeKey,
  type WaCandidate,
  type WaCategory,
  type WaChat,
  type WaConfig,
  type WaContextMessage,
  type WaHistory,
  type WaJob,
} from './whatsappApi';
import { allChecklistItems, DEFAULT_DEST, registerCandidate, similarItems, type WaDest } from './whatsappRegister';

const DESTS: WaDest[] = ['task', 'food', 'place', 'idea', 'inbox', 'append'];
const DEST_LABEL: Record<WaDest, string> = { ...TARGET_LABEL, append: '既存の項目に追記' };

interface Edit {
  title: string;
  dest: WaDest;
  category: string;
  appendTo: string;
}

const fmtSec = (s: number | null) => (s == null ? '計算中' : s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`);

/**
 * PC に保存した WhatsApp の会話ログから、旅行に関係する情報を取り出して登録する画面。
 * 解析は利用者が「解析を開始」を押したときだけ、PC の取り込みプログラムで行う。
 */
export function WhatsAppScreen() {
  const { ctx, db, trip, today, toast } = useApp();
  const [conn, setConn] = useState<'checking' | 'ok' | 'down'>('checking');
  const [cfg, setCfg] = useState<WaConfig | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [folder, setFolder] = useState('');
  const [range, setRange] = useState<RangeKey>('7d');
  const [custom, setCustom] = useState({ from: '', to: '' });
  const [chats, setChats] = useState<WaChat[] | null>(null);
  const [root, setRoot] = useState('');
  const [chatSel, setChatSel] = useState<Set<string>>(new Set());
  const [cats, setCats] = useState<Set<WaCategory>>(new Set(WA_CATEGORIES));
  const [excludeAnalyzed, setExcludeAnalyzed] = useState(true);
  const [force, setForce] = useState(false);
  const [job, setJob] = useState<WaJob | null>(null);
  const [history, setHistory] = useState<WaHistory[]>([]);
  const [cands, setCands] = useState<WaCandidate[]>([]);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [fCat, setFCat] = useState<WaCategory | ''>('');
  const [fChat, setFChat] = useState('');
  const [showHeld, setShowHeld] = useState(false);
  const [withExcerpt, setWithExcerpt] = useState(false);
  const [contexts, setContexts] = useState<Record<string, WaContextMessage[] | string>>({});
  const [busy, setBusy] = useState(false);
  const [urlInput, setUrlInput] = useState(importerUrl());
  const items = useLiveQuery(() => allChecklistItems(db, trip.id), [db, trip.id]) ?? [];
  const offset = useMemo(() => tzOffset(trip.timeZone), [trip.timeZone]);
  const iso = useMemo(() => rangeToIso(range, today, offset, custom), [range, today, offset, custom]);
  const poll = useRef<number | null>(null);

  const loadCandidates = useCallback(async () => {
    const r = await waApi.candidates(showHeld ? 'pending,held' : 'pending');
    setCands(r.candidates);
    setEdits((cur) => {
      const next = { ...cur };
      for (const c of r.candidates)
        if (!next[c.id]) next[c.id] = { title: c.title_ja, dest: DEFAULT_DEST[c.category]?.dest ?? 'inbox', category: DEFAULT_DEST[c.category]?.category ?? '', appendTo: '' };
      return next;
    });
  }, [showHeld]);

  const connect = useCallback(async () => {
    setConn('checking');
    try {
      await waApi.health();
      const c = await waApi.config();
      setCfg(c.config);
      setModels(c.models);
      setFolder(c.config.log_folder);
      setConn('ok');
      setHistory((await waApi.history()).history);
      const j = (await waApi.job()).job;
      setJob(j);
    } catch {
      setConn('down');
    }
  }, []);

  useEffect(() => {
    void connect();
  }, [connect]);

  useEffect(() => {
    if (conn === 'ok') void loadCandidates().catch((e: Error) => toast(e.message, { kind: 'error' }));
  }, [conn, loadCandidates, toast]);

  // 解析中は進捗を 1 秒ごとに取りにいく
  useEffect(() => {
    if (job?.state !== 'running') return;
    poll.current = window.setInterval(async () => {
      try {
        const j = (await waApi.job()).job;
        setJob(j);
        if (j && j.state !== 'running') {
          setHistory((await waApi.history()).history);
          await loadCandidates();
        }
      } catch {
        /* 次の回にまた試す */
      }
    }, 1000);
    return () => {
      if (poll.current) window.clearInterval(poll.current);
    };
  }, [job?.state, loadCandidates]);

  const readLogs = async () => {
    setBusy(true);
    try {
      const r = await waApi.chats(iso.from, iso.to);
      setChats(r.chats);
      setRoot(r.root);
      setChatSel(new Set(r.chats.filter((c) => c.in_range > 0).map((c) => c.chat_id)));
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!chatSel.size) return toast('会話相手を選んでください');
    if (!cats.size) return toast('抽出するカテゴリを選んでください');
    try {
      const r = await waApi.analyze({
        ...iso,
        chat_ids: [...chatSel],
        categories: [...cats],
        exclude_analyzed: excludeAnalyzed,
        force,
        label: range === 'custom' ? `${custom.from}〜${custom.to}` : RANGE_LABEL[range],
      });
      setJob(r.job);
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    }
  };

  const saveSettings = async (patch: Parameters<typeof waApi.saveConfig>[0]) => {
    try {
      const r = await waApi.saveConfig(patch);
      setCfg(r.config);
      setFolder(r.config.log_folder);
      setChats(null);
      toast('設定を保存しました');
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    }
  };

  const shown = cands.filter((c) => (!fCat || c.category === fCat) && (!fChat || c.chat_id === fChat));
  const sel = shown.filter((c) => picked.has(c.id));
  const partners = useMemo(() => [...new Map(cands.map((c) => [c.chat_id, c.chat_title])).entries()], [cands]);

  const setEdit = (id: string, patch: Partial<Edit>) => setEdits((cur) => ({ ...cur, [id]: { ...cur[id], ...patch } }));

  const registerSelected = async () => {
    if (!sel.length) return;
    setBusy(true);
    let ok = 0;
    const done: string[] = [];
    try {
      for (const c of sel) {
        const e = edits[c.id];
        try {
          let excerpt: WaContextMessage[] | null = null;
          if (withExcerpt) {
            const r = await waApi.context(c.id);
            excerpt = r.messages.filter((m) => m.source);
          }
          await registerCandidate(ctx, trip.id, c, { dest: e.dest, title: e.title.trim() || c.title_ja, category: e.category, appendTo: e.appendTo || null, excerpt, localDate: today });
          done.push(c.id);
          ok++;
        } catch (err) {
          toast(`「${e.title}」を登録できませんでした：${(err as Error).message}`, { kind: 'error' });
        }
      }
      if (done.length) await waApi.decide(done, 'registered');
      toast(`${ok} 件を登録しました`);
      setPicked(new Set());
      await loadCandidates();
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const decide = async (ids: string[], d: 'rejected' | 'held' | 'pending') => {
    try {
      await waApi.decide(ids, d);
      toast(`${ids.length} 件を${d === 'rejected' ? '却下' : d === 'held' ? '保留' : '未処理に戻'}しました`);
      setPicked(new Set());
      await loadCandidates();
    } catch (e) {
      toast((e as Error).message, { kind: 'error' });
    }
  };

  const toggleContext = async (id: string) => {
    if (contexts[id]) {
      setContexts((cur) => {
        const next = { ...cur };
        delete next[id];
        return next;
      });
      return;
    }
    try {
      const r = await waApi.context(id);
      setContexts((cur) => ({ ...cur, [id]: r.messages.length ? r.messages : (r.note ?? '元の会話がありません') }));
    } catch (e) {
      setContexts((cur) => ({ ...cur, [id]: (e as Error).message }));
    }
  };

  if (conn !== 'ok')
    return (
      <div className="screen">
        <div className="screen-head">
          <button className="btn small ghost" onClick={() => navigate('inbox')}>← 未整理ボックス</button>
          <h1>WhatsApp から取り込む</h1>
        </div>
        {conn === 'checking' ? (
          <p className="muted">PC の取り込みプログラムを確認しています…</p>
        ) : (
          <section className="card">
            <p>PC の取り込みプログラムにつながりません。</p>
            <ol className="steps">
              <li>家の PC で <code>worker\WhatsApp取り込み.bat</code> をダブルクリックして起動します。</li>
              <li>この画面を、同じ PC のブラウザ（Chrome）で開きます。スマホからは使えません。</li>
              <li>Chrome が「ローカル ネットワーク上のデバイスへのアクセス」を聞いてきたら「許可」を押します。</li>
            </ol>
            <button className="btn primary" onClick={() => void connect()}>もう一度つなぐ</button>
            <details className="filters">
              <summary>接続先を変える</summary>
              <div className="add-row">
                <input value={urlInput} onChange={(e) => setUrlInput(e.target.value)} aria-label="接続先" />
                <button
                  className="btn"
                  onClick={() => {
                    setImporterUrl(urlInput);
                    void connect();
                  }}
                >
                  保存
                </button>
              </div>
            </details>
          </section>
        )}
      </div>
    );

  const last = history.find((h) => h.state === 'done') ?? history[0];

  return (
    <div className="screen wa">
      <div className="screen-head">
        <button className="btn small ghost" onClick={() => navigate('inbox')}>← 未整理ボックス</button>
        <h1>WhatsApp から取り込む</h1>
      </div>
      <p className="muted small">
        前回の取り込み：{last ? `${new Date(last.started_at).toLocaleString('ja-JP')}（${last.params?.label ?? ''} ${stateLabel(last.state)}）` : 'まだありません'}
      </p>

      <section className="card">
        <h2>1. 読み込む範囲</h2>
        <Field label="期間">
          <select value={range} onChange={(e) => setRange(e.target.value as RangeKey)}>
            {(Object.keys(RANGE_LABEL) as RangeKey[]).map((k) => (
              <option key={k} value={k}>
                {RANGE_LABEL[k]}
              </option>
            ))}
          </select>
        </Field>
        {range === 'custom' && (
          <div className="row2">
            <Field label="開始日">
              <input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} />
            </Field>
            <Field label="終了日">
              <input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} />
            </Field>
          </div>
        )}
        <button className="btn" disabled={busy} onClick={() => void readLogs()}>ログを読み込む</button>
        {chats && (
          <>
            <p className="muted small">
              {root}（{chats.length} チャット）
            </p>
            <label className="check-line">
              <input
                type="checkbox"
                checked={chats.filter((c) => c.in_range > 0).every((c) => chatSel.has(c.chat_id))}
                onChange={(e) => setChatSel(e.target.checked ? new Set(chats.filter((c) => c.in_range > 0).map((c) => c.chat_id)) : new Set())}
              />
              会話相手をすべて選ぶ
            </label>
            <ul className="wa-chats">
              {chats.map((c) => (
                <li key={c.chat_id} className={c.in_range ? '' : 'muted'}>
                  <label className="check-line">
                    <input
                      type="checkbox"
                      disabled={!c.in_range}
                      checked={chatSel.has(c.chat_id)}
                      onChange={(e) =>
                        setChatSel((cur) => {
                          const n = new Set(cur);
                          if (e.target.checked) n.add(c.chat_id);
                          else n.delete(c.chat_id);
                          return n;
                        })
                      }
                    />
                    <span>
                      {c.group ? '👥 ' : ''}
                      {c.title}
                      <span className="muted small">
                        {' '}
                        期間内 {c.in_range} 件・未解析 {c.unanalyzed} 件{c.error ? `・${c.error}` : ''}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      <section className="card">
        <h2>2. 取り出す情報</h2>
        <div className="chips">
          {WA_CATEGORIES.map((k) => (
            <button
              key={k}
              className={'chip' + (cats.has(k) ? ' on' : '')}
              onClick={() =>
                setCats((cur) => {
                  const n = new Set(cur);
                  if (n.has(k)) n.delete(k);
                  else n.add(k);
                  return n;
                })
              }
            >
              {WA_CATEGORY_LABEL[k]}
            </button>
          ))}
        </div>
        <label className="check-line">
          <input type="checkbox" checked={excludeAnalyzed} disabled={force} onChange={(e) => setExcludeAnalyzed(e.target.checked)} />
          解析済みのメッセージは除く（新しいメッセージ・内容が変わったメッセージだけを解析）
        </label>
        <label className="check-line">
          <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
          強制再解析（解析済みも含めて解析し直す。却下した候補は、変更・中止・合意のとき以外は出し直しません）
        </label>
        <button className="btn primary big" disabled={!chats || job?.state === 'running'} onClick={() => void start()}>
          解析を開始
        </button>
        {!chats && <p className="muted small">先に「ログを読み込む」で会話相手を選んでください。</p>}
      </section>

      {job && (
        <section className={'card wa-progress ' + job.state}>
          <div className="card-head">
            <h2>解析の進み具合</h2>
            <span className="badge">{stateLabel(job.state)}</span>
          </div>
          <div className="progress" aria-hidden>
            <div style={{ width: `${job.percent}%` }} />
          </div>
          <dl className="wa-stats">
            <dt>読み込んだファイル</dt>
            <dd>{job.files}</dd>
            <dt>対象のメッセージ</dt>
            <dd>{job.target}</dd>
            <dt>解析済み</dt>
            <dd>
              {job.analyzed}（{job.percent}%）
            </dd>
            <dt>経過時間</dt>
            <dd>{fmtSec(job.elapsed_sec)}</dd>
            <dt>残り時間（目安）</dt>
            <dd>{job.state === 'running' ? fmtSec(job.eta_sec) : '—'}</dd>
            <dt>見つけた候補</dt>
            <dd>{job.candidates}</dd>
            <dt>重複で除いた数</dt>
            <dd>{job.duplicates}</dd>
            <dt>エラー</dt>
            <dd>{job.errors}</dd>
          </dl>
          {job.message && <p className={job.state === 'failed' ? 'error-text' : 'muted small'}>{job.message}</p>}
          {job.state === 'running' && (
            <button className="btn danger" disabled={job.cancelling} onClick={() => void waApi.cancel().then((r) => setJob(r.job))}>
              {job.cancelling ? '止めています…' : '途中で止める'}
            </button>
          )}
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2>3. 登録する候補を選ぶ</h2>
          <span className="muted">{cands.length} 件</span>
        </div>
        <div className="filter-row">
          <select value={fCat} onChange={(e) => setFCat(e.target.value as WaCategory | '')} aria-label="カテゴリ">
            <option value="">カテゴリ：すべて</option>
            {WA_CATEGORIES.map((k) => (
              <option key={k} value={k}>
                {WA_CATEGORY_LABEL[k]}
              </option>
            ))}
          </select>
          <select value={fChat} onChange={(e) => setFChat(e.target.value)} aria-label="会話相手">
            <option value="">相手：すべて</option>
            {partners.map(([id, t]) => (
              <option key={id} value={id}>
                {t}
              </option>
            ))}
          </select>
          <label className="check-line small">
            <input type="checkbox" checked={showHeld} onChange={(e) => setShowHeld(e.target.checked)} />
            保留も
          </label>
        </div>
        {shown.length === 0 ? (
          <Empty>候補はありません。</Empty>
        ) : (
          <>
            <div className="actions">
              <button className="btn small ghost" onClick={() => setPicked(new Set(shown.map((c) => c.id)))}>全選択</button>
              <button className="btn small ghost" onClick={() => setPicked(new Set())}>全解除</button>
            </div>
            <ul className="wa-cands">
              {shown.map((c) => {
                const e = edits[c.id];
                if (!e) return null;
                const similar = similarItems(c, items);
                const context = contexts[c.id];
                return (
                  <li key={c.id} className={'wa-cand' + (picked.has(c.id) ? ' on' : '')}>
                    <label className="check-line">
                      <input
                        type="checkbox"
                        checked={picked.has(c.id)}
                        onChange={(ev) =>
                          setPicked((cur) => {
                            const n = new Set(cur);
                            if (ev.target.checked) n.add(c.id);
                            else n.delete(c.id);
                            return n;
                          })
                        }
                      />
                      <span className="muted small">
                        <span className="badge">{WA_CATEGORY_LABEL[c.category]}</span>
                        <span className="badge">{WA_STATUS_LABEL[c.certainty] ?? c.certainty}</span>
                        {c.status === 'held' && <span className="badge">保留中</span>}
                        {c.action !== 'new' && <span className="badge strong">{WA_ACTION_LABEL[c.action]}</span>}
                        {' '}
                        {c.chat_title}
                        {c.message_at && ` ${c.message_at.slice(5, 16).replace('T', ' ')}`}
                      </span>
                    </label>
                    <input className="wa-title" value={e.title} onChange={(ev) => setEdit(c.id, { title: ev.target.value })} aria-label="タイトル" />
                    <p className="small">{c.description}</p>
                    <p className="muted small">
                      {[c.name_id && `名称 ${c.name_id}`, c.shop && `店 ${c.shop}`, c.place && `場所 ${c.place}`, c.price_idr != null && `${c.price_idr.toLocaleString('ja-JP')} IDR`, c.datetime_text && `日時 ${c.datetime_text}`, c.date && `(${c.date})`]
                        .filter(Boolean)
                        .join('・')}
                    </p>
                    {c.translation_ja && <p className="muted small">訳：{c.translation_ja}</p>}
                    {safeHttpUrl(c.url) && (
                      <a className="link small" href={safeHttpUrl(c.url)!} target="_blank" rel="noopener noreferrer">
                        {c.url}
                      </a>
                    )}
                    {similar.length > 0 && <p className="dup-warn small">⚠ 似た項目があります：{similar.slice(0, 3).map((s) => `「${s.title}」`).join('')}</p>}
                    <div className="row2">
                      <select value={e.dest} onChange={(ev) => setEdit(c.id, { dest: ev.target.value as WaDest, appendTo: ev.target.value === 'append' ? (similar[0]?.id ?? '') : e.appendTo })} aria-label="登録先">
                        {DESTS.map((d) => (
                          <option key={d} value={d}>
                            登録先：{DEST_LABEL[d]}
                          </option>
                        ))}
                      </select>
                      {e.dest === 'append' ? (
                        <select value={e.appendTo} onChange={(ev) => setEdit(c.id, { appendTo: ev.target.value })} aria-label="追記する項目">
                          <option value="">追記する項目を選ぶ</option>
                          {[...similar, ...items.filter((i) => !similar.includes(i) && i.status === 'open')].map((i) => (
                            <option key={i.id} value={i.id}>
                              {i.title}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input value={e.category} onChange={(ev) => setEdit(c.id, { category: ev.target.value })} placeholder="分類" aria-label="分類" />
                      )}
                    </div>
                    <div className="actions">
                      <button className="btn small ghost" onClick={() => void toggleContext(c.id)}>{context ? '元の会話を閉じる' : '元の会話を見る'}</button>
                      <button className="btn small ghost" onClick={() => void decide([c.id], 'held')}>保留</button>
                      <button className="btn small ghost danger" onClick={() => void decide([c.id], 'rejected')}>却下</button>
                    </div>
                    {context &&
                      (typeof context === 'string' ? (
                        <p className="muted small">{context}</p>
                      ) : (
                        <ul className="wa-context">
                          {context.map((m) => (
                            <li key={m.id} className={m.source ? 'src' : ''}>
                              <span className="muted small">
                                {m.at} {m.from}
                              </span>
                              <span className="pre">{m.text}</span>
                            </li>
                          ))}
                        </ul>
                      ))}
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      {sel.length > 0 && (
        <div className="bulk-bar">
          <label className="check-line small">
            <input type="checkbox" checked={withExcerpt} onChange={(e) => setWithExcerpt(e.target.checked)} />
            根拠の会話（抜粋）もクラウドに保存する
          </label>
          <button className="btn primary" disabled={busy} onClick={() => void registerSelected()}>
            選んだ {sel.length} 件を登録
          </button>
          <button className="btn small ghost" onClick={() => void decide(sel.map((c) => c.id), 'held')}>保留</button>
          <button className="btn small ghost danger" onClick={() => void decide(sel.map((c) => c.id), 'rejected')}>却下</button>
        </div>
      )}

      <details className="card">
        <summary>設定（ログのフォルダ・AI のモデル）</summary>
        <Field label="ログのフォルダ" hint="保存ツールのフォルダ、アカウントのフォルダ、chat_logs のどれでも指定できます。ログは読むだけで、変更しません">
          <input value={folder} onChange={(e) => setFolder(e.target.value)} />
        </Field>
        <button className="btn small" onClick={() => void saveSettings({ log_folder: folder })}>フォルダを保存</button>
        {cfg && (
          <Field label="AI のモデル（ローカル）" hint={`${cfg.llm.api === 'ollama' ? 'Ollama' : 'OpenAI 互換'}：${cfg.llm.base_url}`}>
            <select value={cfg.llm.model} onChange={(e) => void saveSettings({ llm: { model: e.target.value } })}>
              {[...new Set([cfg.llm.model, ...models])].map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </Field>
        )}
      </details>

      <details className="card">
        <summary>取り込みの履歴（{history.length} 回）</summary>
        <ul className="list">
          {history.map((h) => (
            <li key={h.id} className="small">
              {new Date(h.started_at).toLocaleString('ja-JP')}　{h.params?.label ?? ''}　{stateLabel(h.state)}　対象 {h.target}・解析 {h.analyzed}・候補 {h.candidates}・重複 {h.duplicates}・エラー {h.errors}（{fmtSec(h.elapsed_sec)}、{h.model}）
              {h.message && <div className="muted">{h.message}</div>}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function stateLabel(s: string) {
  return s === 'running' ? '解析中' : s === 'done' ? '完了' : s === 'cancelled' ? '中止' : '失敗あり';
}
