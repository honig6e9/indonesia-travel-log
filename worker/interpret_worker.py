"""家の PC で動かす通訳プログラム。

Supabase の受付（interpret_jobs）を見張り、スマホから届いた音声を
  1. Whisper で文字にして、日本語かインドネシア語かを判別し、
  2. Claude Code → Codex → Gemini CLI → ローカル LLM（Ollama）の順で訳し、
  3. 結果を Supabase に書き戻す。
音声と結果はこの PC にも保存する（AUDIO_DIR）。

設定は worker/.env（.env.example を写して作る。service_role キーはこのファイルにだけ置く）。
"""

from __future__ import annotations

import datetime as dt
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent

# ログを UTF-8 で出す（コンソールやファイルへのリダイレクトで文字化けしないように）
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass


def load_env(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


load_env(HERE / ".env")

SUPABASE_URL = os.environ.get("SUPABASE_URL", "").rstrip("/")
SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "")
WORKER_ID = os.environ.get("WORKER_ID", "home-pc")
AUDIO_DIR = Path(os.environ.get("AUDIO_DIR", str(Path.home() / "IndonesiaTravelLog" / "interpret")))
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "large-v3-turbo")
PROVIDERS = [p.strip() for p in os.environ.get("PROVIDERS", "claude,codex,gemini,ollama").split(",") if p.strip()]
CLAUDE_MODEL = os.environ.get("CLAUDE_MODEL", "haiku")
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "gemma4:26b")
POLL_SECONDS = float(os.environ.get("POLL_SECONDS", "0.8"))
BUCKET = "travel-media"

HEADERS = {"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}"}
LANG_NAME = {"ja": "日本語", "id": "インドネシア語"}


def log(*a: object) -> None:
    print(dt.datetime.now().strftime("%H:%M:%S"), *a, flush=True)


# ---------- Supabase ----------


def rest(method: str, path: str, **kw) -> requests.Response:
    h = dict(HEADERS)
    h.update(kw.pop("headers", {}))
    r = requests.request(method, f"{SUPABASE_URL}/rest/v1/{path}", headers=h, timeout=30, **kw)
    r.raise_for_status()
    return r


def heartbeat(status: str = "ok", extra: dict | None = None) -> None:
    body = {
        "id": WORKER_ID,
        "last_seen": dt.datetime.now(dt.timezone.utc).isoformat(),
        "status": status,
        "info": {"whisper": WHISPER_MODEL, "providers": PROVIDERS, **(extra or {})},
    }
    rest("POST", "interpret_worker", json=body, headers={"Prefer": "resolution=merge-duplicates,return=minimal"})


_owners: set[str] = set()


def sync_audio_once() -> int:
    """スマホが文字で訳したあとに送った録音を、この PC にも保存する（訳には使わない）"""
    got = 0
    for owner in list(_owners):
        r = requests.post(
            f"{SUPABASE_URL}/storage/v1/object/list/{BUCKET}",
            headers=HEADERS,
            json={"prefix": f"{owner}/interpret/", "limit": 1000, "sortBy": {"column": "created_at", "order": "desc"}},
            timeout=30,
        )
        r.raise_for_status()
        for obj in r.json():
            name = obj.get("name") or ""
            if "." not in name:
                continue
            day = (obj.get("created_at") or dt.datetime.now(dt.timezone.utc).isoformat())[:10]
            dest = AUDIO_DIR / day / name
            if dest.exists():
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(download_audio(f"{owner}/interpret/{name}"))
            got += 1
    return got


def audio_sync_loop(stop: threading.Event) -> None:
    while not stop.is_set():
        stop.wait(120)
        try:
            n = sync_audio_once()
            if n:
                log(f"スマホの録音を {n} 件保存しました")
        except Exception as e:
            log("録音の取り寄せに失敗:", str(e)[:200])


def heartbeat_loop(stop: threading.Event) -> None:
    while not stop.is_set():
        try:
            heartbeat()
        except Exception as e:  # 通信断でも止めない
            log("heartbeat failed:", e)
        stop.wait(20)


def claim(job: dict) -> dict | None:
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    r = rest(
        "PATCH",
        f"interpret_jobs?id=eq.{job['id']}&status=eq.{job['status']}",
        json={"status": "processing", "claimed_at": now, "attempts": int(job.get("attempts") or 0) + 1},
        headers={"Prefer": "return=representation"},
    )
    rows = r.json()
    return rows[0] if rows else None


def finish(job_id: str, fields: dict) -> None:
    fields = {**fields, "processed_at": dt.datetime.now(dt.timezone.utc).isoformat()}
    rest("PATCH", f"interpret_jobs?id=eq.{job_id}", json=fields, headers={"Prefer": "return=minimal"})


def update(job_id: str, fields: dict) -> None:
    rest("PATCH", f"interpret_jobs?id=eq.{job_id}", json=fields, headers={"Prefer": "return=minimal"})


def download_audio(path: str) -> bytes:
    r = requests.get(f"{SUPABASE_URL}/storage/v1/object/{BUCKET}/{path}", headers=HEADERS, timeout=120)
    r.raise_for_status()
    return r.content


# ---------- 音声認識 ----------

_whisper = None


def whisper_model():
    global _whisper
    if _whisper is None:
        import whisper  # openai-whisper

        log(f"Whisper {WHISPER_MODEL} を読み込み中…")
        _whisper = whisper.load_model(WHISPER_MODEL)
        log("Whisper の準備ができました")
    return _whisper


def transcribe(audio_file: Path, mode: str, hint_text: str | None = None) -> tuple[str, str]:
    """録音から言語を判定して文字にする。

    使う言語は日本語とインドネシア語だけ。押したボタン（mode）には関係なく、話した言語で決める。
    日本語ははっきり判定できる（0.99 前後）が、日本人の発音のインドネシア語の短い言葉は
    アイスランド語などと判定されることがあるので、「日本語らしさ」だけで決める。
    スマホで聞き取った文（hint_text）があり、言語が合っていれば、それをそのまま使う（速い）。
    """
    import whisper

    model = whisper_model()
    hint_lang = "ja" if mode == "ja-id" else "id" if mode == "id-ja" else None
    audio = whisper.pad_or_trim(whisper.load_audio(str(audio_file)))
    mel = whisper.log_mel_spectrogram(audio, n_mels=model.dims.n_mels).to(model.device)
    _, probs = model.detect_language(mel)
    pj = probs.get("ja", 0)
    top = max(probs, key=probs.get)
    if pj >= 0.6:
        lang = "ja"
    elif pj <= 0.15:
        lang = "id"
    elif hint_text and hint_lang:
        lang = hint_lang  # どちらとも言えないときは、スマホの聞き取りを信じる
    else:
        tries = {}
        for cand in ("ja", "id"):
            r = model.transcribe(str(audio_file), language=cand, fp16=True, condition_on_previous_text=False)
            segs = r.get("segments") or []
            lp = sum(sg["avg_logprob"] for sg in segs) / max(1, len(segs))
            tries[cand] = (lp, (r.get("text") or "").strip())
        lang = "ja" if tries["ja"][0] >= tries["id"][0] else "id"
        log(f"言語判定 ja={pj:.2f}（両方で比較 ja={tries['ja'][0]:.2f} id={tries['id'][0]:.2f}）→ {lang}")
        return lang, tries[lang][1]
    log(f"言語判定 ja={pj:.2f} 最有力={top} → {lang}（ボタン {hint_lang or '自動'}）")
    if hint_text and hint_lang == lang:
        return lang, hint_text.strip()
    if hint_text:
        log(f"スマホの聞き取り（{hint_lang}）と話した言語（{lang}）が違うので、文字にし直します")
    result = model.transcribe(str(audio_file), language=lang, fp16=True, condition_on_previous_text=False)
    text = (result.get("text") or "").strip()
    if lang == "id" and JA_RE.search(text):
        lang = "ja"
    return lang, text


JA_RE = re.compile(r"[぀-ヿ㐀-鿿]")


def text_lang(text: str, mode: str) -> str:
    # 文字に日本語が含まれていれば日本語（「尼→日」で日本語が入力された場合も）
    if JA_RE.search(text):
        return "ja"
    if mode == "ja-id":
        return "ja"
    return "id"


# ---------- 翻訳 ----------

SCHEMA = {
    "type": "object",
    "properties": {"translation": {"type": "string"}, "reading": {"type": "string"}},
    "required": ["translation", "reading"],
    "additionalProperties": False,
}


def build_prompt(src_lang: str, text: str) -> str:
    if src_lang == "ja":
        task = (
            "次の日本語を、ジャカルタで話される自然なインドネシア語（丁寧すぎない、旅行者が店員や運転手に話す口調）に訳してください。"
            "reading には、そのインドネシア語の読み方をカタカナで書いてください。"
        )
    else:
        task = "次のインドネシア語を、自然な日本語に訳してください。reading は空文字にしてください。"
    return (
        "あなたは日本人旅行者のための通訳です。"
        + task
        + "原文にないことは足さず、人名や地名はそのまま残してください。"
        + '出力は JSON だけにしてください：{"translation": "...", "reading": "..."}\n\n原文: '
        + text
    )


def parse_json(out: str) -> dict:
    m = re.search(r"\{.*\}", out, re.S)
    if not m:
        raise ValueError("JSON が見つかりません: " + out[:200])
    d = json.loads(m.group(0))
    if not isinstance(d, dict) or not str(d.get("translation", "")).strip():
        raise ValueError("訳文が空です")
    return {"translation": str(d["translation"]).strip(), "reading": str(d.get("reading") or "").strip()}


WORKDIR = Path(tempfile.gettempdir()) / "itl-interpret-work"
WORKDIR.mkdir(parents=True, exist_ok=True)


def run_cli(cmd: list[str], stdin: str, timeout: int) -> str:
    exe = shutil.which(cmd[0])
    if not exe:
        raise FileNotFoundError(f"{cmd[0]} が見つかりません")
    p = subprocess.run(
        [exe, *cmd[1:]],
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        cwd=WORKDIR,
    )
    if p.returncode != 0:
        raise RuntimeError(f"{cmd[0]} が失敗しました: {(p.stderr or p.stdout).strip()[:300]}")
    return p.stdout


def via_claude(prompt: str) -> dict:
    out = run_cli(
        ["claude", "-p", "--model", CLAUDE_MODEL, "--output-format", "json", "--tools", "", "--no-session-persistence"],
        prompt,
        60,
    )
    data = json.loads(out)
    if data.get("is_error"):
        raise RuntimeError("Claude Code: " + str(data.get("result"))[:300])
    return parse_json(str(data.get("result", "")))


def via_codex(prompt: str) -> dict:
    schema_file = WORKDIR / "schema.json"
    schema_file.write_text(json.dumps(SCHEMA), encoding="utf-8")
    out_file = WORKDIR / f"codex-{os.getpid()}-{time.time_ns()}.txt"
    run_cli(
        [
            "codex", "exec", "--skip-git-repo-check", "--ephemeral", "-s", "read-only",
            "--output-schema", str(schema_file), "-o", str(out_file), "-",
        ],
        prompt,
        90,
    )
    try:
        return parse_json(out_file.read_text(encoding="utf-8"))
    finally:
        out_file.unlink(missing_ok=True)


def via_gemini(prompt: str) -> dict:
    out = run_cli(["gemini", "-p", "標準入力の指示に従い、JSON だけを出力してください。"], prompt, 60)
    return parse_json(out)


def via_ollama(prompt: str) -> dict:
    r = requests.post(
        f"{OLLAMA_URL}/api/chat",
        json={
            "model": OLLAMA_MODEL,
            "stream": False,
            "think": False,
            "format": SCHEMA,
            "keep_alive": "30m",
            "options": {"temperature": 0.2},
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=180,
    )
    r.raise_for_status()
    return parse_json(r.json()["message"]["content"])


TRANSLATORS = {"claude": via_claude, "codex": via_codex, "gemini": via_gemini, "ollama": via_ollama}


# 失敗した翻訳先は 10 分間飛ばす（ログイン切れなどで毎回待たされないように）
_skip_until: dict[str, float] = {}
SKIP_SECONDS = 600


def translate(src_lang: str, text: str, providers: list[str] | None = None) -> tuple[dict, str, list[str]]:
    prompt = build_prompt(src_lang, text)
    errors: list[str] = []
    for name in providers if providers is not None else PROVIDERS:
        fn = TRANSLATORS.get(name)
        if not fn:
            continue
        if _skip_until.get(name, 0) > time.time():
            errors.append(f"{name}: しばらく飛ばしています（直前に失敗）")
            continue
        t0 = time.time()
        try:
            res = fn(prompt)
            _skip_until.pop(name, None)
            log(f"翻訳 {name} {time.time() - t0:.1f}s")
            return res, name, errors
        except Exception as e:
            msg = f"{name}: {e}"
            log("翻訳失敗", msg[:300])
            errors.append(msg[:300])
            _skip_until[name] = time.time() + SKIP_SECONDS
    raise RuntimeError("すべての翻訳に失敗しました / " + " | ".join(errors))


# ---------- 1 件の処理 ----------


def process(job: dict) -> None:
    jid = job["id"]
    if job.get("owner_id"):
        _owners.add(job["owner_id"])
    mode = job.get("mode") or "auto"
    day = (job.get("created_at") or dt.datetime.now(dt.timezone.utc).isoformat())[:10]
    out_dir = AUDIO_DIR / day
    out_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    if job.get("audio_path"):
        ext = job["audio_path"].rsplit(".", 1)[-1]
        audio_file = out_dir / f"{jid}.{ext}"
        if not audio_file.exists():
            audio_file.write_bytes(download_audio(job["audio_path"]))
        src_lang, text = transcribe(audio_file, mode, (job.get("input_text") or "").strip() or None)
        log(f"文字起こし {time.time() - t0:.1f}s [{src_lang}] {text}")
    else:
        text = (job.get("input_text") or "").strip()
        src_lang = text_lang(text, mode)
    if not text:
        finish(jid, {"status": "error", "error": "音声を聞き取れませんでした。もう一度、はっきり話してください"})
        return
    target_lang = "id" if src_lang == "ja" else "ja"
    # 1. 聞き取った文をすぐスマホに見せる
    update(jid, {"source_lang": src_lang, "source_text": text, "target_lang": target_lang})

    def fields_for(res: dict, provider: str, status: str) -> dict:
        return {
            "status": status,
            "source_lang": src_lang,
            "source_text": text,
            "target_lang": target_lang,
            "target_text": res["translation"],
            "reading": res["reading"] if src_lang == "ja" else "",
            "provider": provider,
            "error": None,
        }

    # 2. ローカル LLM（約 1 秒）で先に訳して見せる（処理中のまま）
    upper = [p for p in PROVIDERS if p != "ollama"]
    quick = None
    if "ollama" in PROVIDERS and upper:
        try:
            t1 = time.time()
            quick = via_ollama(build_prompt(src_lang, text))
            update(jid, fields_for(quick, "ollama", "processing"))
            log(f"速い訳 ollama {time.time() - t1:.1f}s: {quick['translation']}")
        except Exception as e:
            log("速い訳に失敗:", str(e)[:200])
    # 3. 優先順位の高い翻訳（Claude → ChatGPT → Gemini）で差し替える。全部だめなら速い訳で確定
    errors: list[str] = []
    try:
        res, provider, errors = translate(src_lang, text, upper if quick else None)
    except Exception as e:
        if not quick:
            raise
        res, provider, errors = quick, "ollama", [str(e)[:300]]
    fields = fields_for(res, provider, "done")
    finish(jid, fields)
    with (AUDIO_DIR / "log.jsonl").open("a", encoding="utf-8") as f:
        f.write(json.dumps({"id": jid, "created_at": job.get("created_at"), "mode": mode, **fields, "skipped": errors}, ensure_ascii=False) + "\n")
    log(f"完了 {time.time() - t0:.1f}s {provider}: {res['translation']}")


def fetch_jobs() -> list[dict]:
    # 受付中のもの＋5 分以上処理中のまま止まったもの（再起動など）
    # URL に「+」を入れると空白として読まれるので、UTC の Z 表記にする
    stale = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(minutes=5)).strftime("%Y-%m-%dT%H:%M:%SZ")
    q = (
        "interpret_jobs?select=*&order=created_at.asc&limit=5"
        f"&or=(status.eq.queued,and(status.eq.processing,claimed_at.lt.{stale},attempts.lt.3))"
    )
    return rest("GET", q).json()


def main() -> int:
    if not SUPABASE_URL or not SERVICE_KEY:
        print("worker/.env に SUPABASE_URL と SUPABASE_SERVICE_ROLE_KEY を書いてください（.env.example 参照）", file=sys.stderr)
        return 2
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    log(f"通訳プログラムを起動しました（翻訳の順: {' → '.join(PROVIDERS)}、保存先: {AUDIO_DIR}）")
    whisper_model()
    stop = threading.Event()
    threading.Thread(target=heartbeat_loop, args=(stop,), daemon=True).start()
    threading.Thread(target=audio_sync_loop, args=(stop,), daemon=True).start()
    # 起動時に、最近の受付から持ち主を知っておく（録音の取り寄せ用）
    try:
        for row in rest("GET", "interpret_jobs?select=owner_id&order=created_at.desc&limit=20").json():
            _owners.add(row["owner_id"])
    except Exception:
        pass
    while True:
        try:
            for job in fetch_jobs():
                claimed = claim(job)
                if not claimed:
                    continue
                try:
                    process(claimed)
                except Exception as e:
                    traceback.print_exc()
                    retry = int(claimed.get("attempts") or 1) < 3 and isinstance(e, requests.RequestException)
                    try:
                        finish(claimed["id"], {"status": "queued" if retry else "error", "error": str(e)[:500]})
                    except Exception:
                        pass
        except KeyboardInterrupt:
            stop.set()
            return 0
        except Exception as e:  # 通信断などは待ってやり直す
            log("受付の確認に失敗:", e)
            time.sleep(10)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    sys.exit(main())
