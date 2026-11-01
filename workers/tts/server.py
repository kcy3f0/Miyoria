"""Miyoria TTS worker (Qwen3-TTS) — implements the "推論 Worker HTTP 介面" (docs/protocols/voice-link.md).

    POST /tts            JSON {text, language?, emotion?, instruct?, voice?}
                         -> 200 streamed raw PCM s16le mono, headers X-Sample-Rate, Content-Type
                            "audio/L16; rate=<sr>; channels=1"
    GET  /health         -> {"status":"ok","model":...,"device":...,...}
    GET  /voices         -> registered voices
    POST /voices/reload  -> rescan VOICES_DIR (add a voice without restarting)

STREAMING MODE: **sentence-level**.
    The `qwen-tts` Python package (checked 2026-11-01) documents no true streaming API — only
    whole-utterance `generate_*` calls. So the text is split on 。！？!?…\\n (text_split.py), each
    sentence is synthesised on its own, and its PCM is sent as soon as it is ready; the next
    sentence is synthesised while the previous one is being written to the socket. Time to first
    audio = latency of the FIRST sentence, not the model's advertised ~97 ms packet latency.
    At startup the model object is probed for stream-like methods and the result is logged and
    reported in /health ("stream_probe"); nothing found is ever called automatically.

VOICES: each voice is a directory ``$VOICES_DIR/<name>/`` with ``ref.wav`` + ``ref.txt`` (the
    transcript of ref.wav). At startup (Base model) every voice becomes a reusable clone prompt
    (`create_voice_clone_prompt`). Directories ending in ``-candidates`` and names starting with
    ``.`` / ``_`` are ignored. A voice without ref.txt falls back to speaker-embedding-only
    cloning (lower quality) and logs a warning.

INSTRUCT / EMOTION: only models with instruction control honour ``instruct``:
    mode ``clone`` (…-Base)        instruct and emotion are IGNORED (emotion = text semantics only)
    mode ``custom_voice``          ``voice`` = built-in speaker name, ``instruct`` is applied
    mode ``voice_design``          ``instruct`` is the voice description (a voice dir's optional
                                   ``instruct.txt`` is prepended as the base description)
    The mode is derived from the model id (Base / CustomVoice / VoiceDesign) or ``TTS_MODE``.
    ``emotion`` is informational: Miyoria sends the already-mapped ``instruct`` (from voice.toml).

Environment
    TTS_MODEL              HF id or local dir            (default Qwen/Qwen3-TTS-12Hz-1.7B-Base)
    TTS_MODE               auto | clone | custom_voice | voice_design   (default auto)
    VOICES_DIR             voices directory              (default ./voices)
    TTS_DEFAULT_VOICE      used when the request has no `voice` (default: the only/first voice)
    TTS_DEVICE             device_map                    (default cuda:0)
    TTS_ATTN               flash_attention_2 | sdpa | eager | default | auto (default auto)
    TTS_DEFAULT_LANGUAGE   when request has none         (default Auto)
    TTS_GEN_KWARGS         JSON merged into every generate_* call, e.g. {"temperature":0.8}
    TTS_MIN_SENTENCE_CHARS (default 4)   TTS_MAX_SENTENCE_CHARS (default 80)
    TTS_MAX_TEXT_CHARS     reject longer requests (default 2000)
    TTS_POOL_SIZE          threads for synthesis calls (default 2; the GPU lock still serialises)
    HOST / PORT            bind address                  (default 127.0.0.1 / 8002)
"""

from __future__ import annotations

import asyncio
import importlib.util
import inspect
import json
import logging
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from text_split import split_sentences

log = logging.getLogger("miyoria.tts")

MAX_TEXT_CHARS = int(os.environ.get("TTS_MAX_TEXT_CHARS", "2000"))
MIN_CHARS = int(os.environ.get("TTS_MIN_SENTENCE_CHARS", "4"))
MAX_CHARS = int(os.environ.get("TTS_MAX_SENTENCE_CHARS", "80"))

_LANG = {
    "zh": "Chinese", "en": "English", "ja": "Japanese", "ko": "Korean", "de": "German",
    "fr": "French", "ru": "Russian", "pt": "Portuguese", "es": "Spanish", "it": "Italian",
}


def to_tts_language(value: str | None) -> str:
    """Request language ("zh-TW", "Chinese", "ja", None) -> a Qwen3-TTS language name."""
    default = os.environ.get("TTS_DEFAULT_LANGUAGE", "Auto")
    if not value or not value.strip():
        return default
    v = value.strip()
    base = v.lower().replace("_", "-").split("-")[0]
    if base in _LANG:
        return _LANG[base]
    return v.title() if v.lower() != "auto" else "Auto"


class ApiError(Exception):
    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status, self.message = status, message


# ── Engine ───────────────────────────────────────────────────────────────────


@dataclass
class Voice:
    name: str
    ref_wav: Path | None = None
    ref_text: str | None = None
    prompt: Any = None  # reusable clone prompt (clone mode)
    base_instruct: str = ""  # voice_design mode: description prepended to the request's instruct
    x_vector_only: bool = False


def _to_numpy(w: Any):
    import numpy as np

    if hasattr(w, "detach"):  # torch tensor
        w = w.detach().float().cpu().numpy()
    return np.asarray(w, dtype=np.float32).reshape(-1)


def _to_pcm16(w: Any) -> bytes:
    import numpy as np

    return (np.clip(_to_numpy(w), -1.0, 1.0) * 32767.0).astype("<i2").tobytes()


class Engine:
    def __init__(self) -> None:
        import torch  # type: ignore
        from qwen_tts import Qwen3TTSModel  # type: ignore

        self.model_id = os.environ.get("TTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
        self.device = os.environ.get("TTS_DEVICE", "cuda:0")
        self.mode = self._detect_mode(self.model_id)
        self.lock = threading.Lock()  # one generate_* call on the GPU at a time
        self.voices: dict[str, Voice] = {}
        self.sample_rate = 0
        self.gen_kwargs: dict[str, Any] = json.loads(os.environ.get("TTS_GEN_KWARGS", "{}") or "{}")

        attn = os.environ.get("TTS_ATTN", "auto")
        if attn == "auto":
            attn = "flash_attention_2" if importlib.util.find_spec("flash_attn") else "sdpa"
        kw: dict[str, Any] = dict(device_map=self.device, dtype=torch.bfloat16)
        if attn != "default":
            kw["attn_implementation"] = attn
        log.info("loading %s (mode=%s attn=%s) …", self.model_id, self.mode, attn)
        self.model = Qwen3TTSModel.from_pretrained(self.model_id, **kw)
        self.stream_probe = self._probe_streaming()
        self.reload_voices()
        self._warmup()

    # -- setup ---------------------------------------------------------------

    @staticmethod
    def _detect_mode(model_id: str) -> str:
        mode = os.environ.get("TTS_MODE", "auto").lower()
        if mode != "auto":
            if mode not in ("clone", "custom_voice", "voice_design"):
                raise RuntimeError(f"bad TTS_MODE={mode!r}")
            return mode
        m = model_id.lower().replace("-", "").replace("_", "")
        if "customvoice" in m:
            return "custom_voice"
        if "voicedesign" in m:
            return "voice_design"
        return "clone"

    def _probe_streaming(self) -> list[str]:
        """List stream-like members of the installed qwen-tts. Informational only — never called."""
        found = [n for n in dir(self.model) if "stream" in n.lower() and not n.startswith("_")]
        for fn in ("generate_voice_clone", "generate_custom_voice", "generate_voice_design"):
            f = getattr(self.model, fn, None)
            if f is None:
                continue
            try:
                found += [f"{fn}({p}=…)" for p in inspect.signature(f).parameters if "stream" in p.lower()]
            except (TypeError, ValueError):
                pass
        if found:
            log.warning("qwen-tts exposes stream-like API %s — NOT used (unverified); staying sentence-level", found)
        else:
            log.info("qwen-tts has no streaming API; using sentence-level streaming")
        return found

    def reload_voices(self) -> None:
        voices_dir = Path(os.environ.get("VOICES_DIR", "voices"))
        found: dict[str, Voice] = {}
        if voices_dir.is_dir():
            for d in sorted(p for p in voices_dir.iterdir() if p.is_dir()):
                if d.name.startswith((".", "_")) or d.name.endswith("-candidates"):
                    continue
                try:
                    v = self._load_voice(d)
                except Exception:
                    log.exception("voice %r skipped", d.name)
                    continue
                if v:
                    found[v.name] = v
        elif self.mode == "clone":
            log.warning("VOICES_DIR %s does not exist — no voices registered", voices_dir)
        with self.lock:
            self.voices = found
        log.info("voices: %s", ", ".join(found) or "(none)")

    def _load_voice(self, d: Path) -> Voice | None:
        ref_wav, ref_txt, inst = d / "ref.wav", d / "ref.txt", d / "instruct.txt"
        base_instruct = inst.read_text(encoding="utf-8").strip() if inst.exists() else ""
        if self.mode != "clone":
            return Voice(d.name, base_instruct=base_instruct)
        if not ref_wav.exists():
            log.warning("voice %r has no ref.wav — skipped", d.name)
            return None
        text = ref_txt.read_text(encoding="utf-8").strip() if ref_txt.exists() else ""
        x_only = not text
        if x_only:
            log.warning("voice %r has no ref.txt — using speaker embedding only (x_vector_only_mode); "
                        "add the transcript for better quality", d.name)
        t0 = time.perf_counter()
        with self.lock:
            prompt = self.model.create_voice_clone_prompt(
                ref_audio=str(ref_wav), ref_text=text or None, x_vector_only_mode=x_only
            )
        log.info("voice %r: clone prompt built in %.0f ms", d.name, (time.perf_counter() - t0) * 1000)
        return Voice(d.name, ref_wav, text or None, prompt, base_instruct, x_only)

    def _warmup(self) -> None:
        """One short synthesis: warms CUDA kernels and tells us the output sample rate."""
        try:
            default = self.resolve_voice(None)
        except ApiError:
            default = None
        if self.mode == "clone" and default is None:
            log.warning("no voice available — skipping warm-up; sample rate unknown until the first request")
            self.sample_rate = int(os.environ.get("TTS_SAMPLE_RATE", "24000"))
            return
        t0 = time.perf_counter()
        fallback_instruct = "" if self.mode != "voice_design" else "清晰自然的年輕女聲"
        try:
            _, self.sample_rate = self.synth("你好。", "Chinese", default.name if default else None, fallback_instruct)
        except Exception:
            log.exception("warm-up failed — assuming TTS_SAMPLE_RATE (default 24000)")
            self.sample_rate = int(os.environ.get("TTS_SAMPLE_RATE", "24000"))
            return
        log.info("warm-up %.0f ms, sample rate %d Hz", (time.perf_counter() - t0) * 1000, self.sample_rate)

    # -- request-time --------------------------------------------------------

    def resolve_voice(self, name: str | None) -> Voice | None:
        if self.mode == "custom_voice":  # `voice` is a built-in speaker name; pass it through
            n = name or os.environ.get("TTS_DEFAULT_VOICE") or next(iter(self.voices), None)
            if not n:
                raise ApiError(400, "custom_voice mode needs `voice` (a built-in speaker name)")
            return self.voices.get(n) or Voice(n)
        if self.mode == "voice_design":
            n = name or os.environ.get("TTS_DEFAULT_VOICE")
            return self.voices.get(n) if n and n in self.voices else (Voice(n) if n else None)
        # clone
        n = name or os.environ.get("TTS_DEFAULT_VOICE") or (next(iter(self.voices)) if len(self.voices) == 1 else None)
        if n is None:
            if not self.voices:
                raise ApiError(503, "no voices registered — put <name>/ref.wav + ref.txt in VOICES_DIR")
            raise ApiError(400, f"`voice` required (available: {', '.join(self.voices)})")
        v = self.voices.get(n)
        if v is None:
            raise ApiError(404, f"unknown voice {n!r} (available: {', '.join(self.voices) or 'none'})")
        return v

    def synth(self, text: str, language: str, voice: str | None, instruct: str) -> tuple[Any, int]:
        """Blocking, GPU-serialised. Returns (float32 mono waveform, sample_rate)."""
        v = self.resolve_voice(voice)
        kw = dict(self.gen_kwargs)
        with self.lock:
            if self.mode == "clone":
                assert v is not None
                wavs, sr = self.model.generate_voice_clone(
                    text=text, language=language, voice_clone_prompt=v.prompt, **kw
                )
            elif self.mode == "custom_voice":
                assert v is not None
                extra = {"instruct": instruct} if instruct else {}
                wavs, sr = self.model.generate_custom_voice(
                    text=text, language=language, speaker=v.name, **extra, **kw
                )
            else:  # voice_design
                desc = "\n".join(s for s in ((v.base_instruct if v else ""), instruct) if s)
                if not desc:
                    raise ApiError(400, "voice_design mode needs `instruct` (voice description) or a voice's instruct.txt")
                wavs, sr = self.model.generate_voice_design(text=text, language=language, instruct=desc, **kw)
        return _to_numpy(wavs[0]), int(sr)


class State:
    engine: Engine
    pool: ThreadPoolExecutor


state = State()


@asynccontextmanager
async def lifespan(app: FastAPI):
    state.pool = ThreadPoolExecutor(max_workers=int(os.environ.get("TTS_POOL_SIZE", "2")), thread_name_prefix="tts")
    loop = asyncio.get_running_loop()
    state.engine = await loop.run_in_executor(state.pool, Engine)
    yield
    state.pool.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="Miyoria TTS worker", lifespan=lifespan)


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"error": message}, status_code=status)


@app.exception_handler(ApiError)
async def _api_exc(_: Request, exc: ApiError) -> JSONResponse:
    return _error(exc.status, exc.message)


@app.exception_handler(StarletteHTTPException)
async def _http_exc(_: Request, exc: StarletteHTTPException) -> JSONResponse:
    return _error(exc.status_code, str(exc.detail))


@app.exception_handler(RequestValidationError)
async def _validation_exc(_: Request, exc: RequestValidationError) -> JSONResponse:
    first = exc.errors()[0] if exc.errors() else {}
    where = ".".join(str(p) for p in first.get("loc", ()) if p != "body")
    return _error(400, f"invalid request: {where or 'body'}: {first.get('msg', 'bad value')}")


class TtsRequest(BaseModel):
    text: str
    language: str | None = None
    emotion: str | None = None
    instruct: str | None = None
    voice: str | None = None


@app.post("/tts")
async def tts(req: TtsRequest) -> StreamingResponse:
    text = req.text.strip()
    if not text:
        raise ApiError(400, "text is empty")
    if len(text) > MAX_TEXT_CHARS:
        raise ApiError(413, f"text too long ({len(text)} > {MAX_TEXT_CHARS} chars)")
    sentences = split_sentences(text, MIN_CHARS, MAX_CHARS)
    if not sentences:
        raise ApiError(400, "text has nothing to speak (punctuation only)")

    eng = state.engine
    language = to_tts_language(req.language)
    instruct = (req.instruct or "").strip()
    eng.resolve_voice(req.voice)  # fail fast with 404 / 400 before any GPU work
    loop = asyncio.get_running_loop()
    rate = eng.sample_rate

    def start(sentence: str) -> asyncio.Future:
        return loop.run_in_executor(state.pool, eng.synth, sentence, language, req.voice, instruct)

    def to_bytes(result: tuple[Any, int]) -> bytes:
        wav, sr = result
        if sr != rate:  # model changed rate mid-flight (should not happen) — keep the header truthful
            from math import gcd

            from scipy.signal import resample_poly

            g = gcd(sr, rate)
            wav = resample_poly(wav, rate // g, sr // g)
        return _to_pcm16(wav)

    # Synthesise the first sentence BEFORE creating the response: failures become a proper
    # 4xx/5xx JSON error instead of a truncated 200.
    t0 = time.perf_counter()
    try:
        first = to_bytes(await start(sentences[0]))
    except ApiError:
        raise
    except Exception as e:
        log.exception("synthesis failed")
        raise ApiError(500, f"synthesis failed: {type(e).__name__}: {e}") from e
    ttfa_ms = (time.perf_counter() - t0) * 1000
    log.info("tts %d sentence(s), first audio after %.0f ms (voice=%s)", len(sentences), ttfa_ms, req.voice)

    async def body() -> AsyncIterator[bytes]:
        nxt = start(sentences[1]) if len(sentences) > 1 else None
        try:
            yield first
            for i in range(1, len(sentences)):
                assert nxt is not None
                pcm = to_bytes(await nxt)  # a failure here aborts the chunked stream (client sees an error)
                nxt = start(sentences[i + 1]) if i + 1 < len(sentences) else None
                yield pcm
        except Exception:  # (CancelledError = client went away; it is a BaseException and passes through)
            log.exception("synthesis failed mid-stream; aborting response")
            raise
        finally:
            if nxt is not None and not nxt.done():
                nxt.cancel()  # a call already running on the GPU finishes, its output is dropped

    return StreamingResponse(
        body(),
        media_type=f"audio/L16; rate={rate}; channels=1",
        headers={
            "X-Sample-Rate": str(rate),
            "X-Tts-Streaming": "sentence",
            "X-Tts-First-Audio-Ms": f"{ttfa_ms:.0f}",
            "Cache-Control": "no-store",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/voices")
async def voices() -> dict[str, Any]:
    e = state.engine
    return {
        "mode": e.mode,
        "default": os.environ.get("TTS_DEFAULT_VOICE") or None,
        "voices": [{"name": v.name, "ref_text": v.ref_text, "x_vector_only": v.x_vector_only} for v in e.voices.values()],
    }


@app.post("/voices/reload")
async def voices_reload() -> dict[str, Any]:
    await asyncio.get_running_loop().run_in_executor(state.pool, state.engine.reload_voices)
    return await voices()


@app.get("/health")
async def health() -> dict[str, Any]:
    e = state.engine
    info: dict[str, Any] = {
        "status": "ok",
        "model": e.model_id,
        "device": e.device,
        "mode": e.mode,
        "sample_rate": e.sample_rate,
        "streaming": "sentence",
        "stream_probe": e.stream_probe,
        "voices": list(e.voices),
        "instruct_supported": e.mode != "clone",
    }
    torch = sys.modules.get("torch")
    if torch is not None and torch.cuda.is_available():
        info["vram_allocated_mb"] = round(torch.cuda.memory_allocated() / 2**20)
    return info


def main() -> None:
    import uvicorn

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    uvicorn.run(app, host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", "8002")), log_level="info")


if __name__ == "__main__":
    main()
