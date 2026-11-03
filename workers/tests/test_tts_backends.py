"""TTS worker backends, driven through FastAPI's TestClient with stubbed model packages.

No GPU / torch / real model: a fake `faster_qwen3_tts` (and, for the fallback backend, fake `torch` +
`qwen_tts`) is injected via sys.modules before tts/server.py is imported. The fake mirrors the signatures
of faster-qwen3-tts 0.5.4 (generate_*_streaming yields (audio_chunk, sr, timing)).
"""

from __future__ import annotations

import asyncio
import importlib.util
import sys
import threading
import time
import types
from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest
from conftest import ROOT, make_wav
from fastapi.testclient import TestClient

TWO = "第一句話在這裡。第二句話也在這裡。"
S1, S2 = "第一句話在這裡。", "第二句話也在這裡。"
PRIME = "你好。"  # text of the start-up priming / warm-up synthesis


class FakeTensor:
    """Just enough of torch.Tensor for the worker's conversion path."""

    def __init__(self, arr):
        self.arr = np.asarray(arr, dtype=np.float32)

    def detach(self):
        return self

    def float(self):
        return self

    def cpu(self):
        return self

    def numpy(self):
        return self.arr


def pcm(*arrays) -> bytes:
    return b"".join((np.clip(np.asarray(getattr(a, "arr", a), dtype=np.float32), -1, 1) * 32767.0).astype("<i2").tobytes() for a in arrays)


def make_fake_faster(scripts: dict | None = None, *, rate: int = 24000, with_custom_streaming: bool = True):
    """Build a fake `faster_qwen3_tts` module.

    scripts: sentence text -> list of items; an item is a chunk, a (chunk, sr) tuple or an Exception to raise.
    """
    scripts = scripts or {}
    state = types.SimpleNamespace(instances=[], closed=[])

    class FasterQwen3TTS:
        def __init__(self, name, kw):
            self.name, self.load_kwargs = name, kw
            self.sample_rate = rate
            self.warmup_calls: list[int] = []
            self.calls: list[tuple[str, dict]] = []  # (method, kwargs) in call order
            self._voice_prompt_cache = {"stale": 1}
            state.instances.append(self)

        @classmethod
        def from_pretrained(cls, model_name, **kw):
            return cls(model_name, kw)

        def warmup(self, prefill_len: int = 100):
            self.warmup_calls.append(prefill_len)

        def _items(self, text):
            return scripts.get(text, [np.zeros(240, dtype=np.float32)])

        def _stream(self, method, kw):
            self.calls.append((method, kw))
            try:
                for item in self._items(kw["text"]):
                    if isinstance(item, Exception):
                        raise item
                    chunk, sr = item if isinstance(item, tuple) else (item, rate)
                    yield chunk, sr, {"prefill_ms": 1.0}
            finally:
                state.closed.append(kw["text"])

        def generate_voice_clone_streaming(self, text, language, ref_audio=None, ref_text="", chunk_size=12,
                                           xvec_only=False, **extra):
            return self._stream("clone_stream", dict(text=text, language=language, ref_audio=ref_audio,
                                                     ref_text=ref_text, chunk_size=chunk_size,
                                                     xvec_only=xvec_only, **extra))

        def generate_voice_clone(self, text, language, **kw):
            self.calls.append(("clone", dict(text=text, language=language, **kw)))
            return [np.zeros(240, dtype=np.float32)], rate

        def generate_custom_voice(self, text, speaker, language, instruct=None, **kw):
            self.calls.append(("custom", dict(text=text, speaker=speaker, language=language, instruct=instruct)))
            return [np.array([0.5, -0.5], dtype=np.float32)], rate

        if with_custom_streaming:
            def generate_custom_voice_streaming(self, text, speaker, language, instruct=None, chunk_size=12, **kw):
                return self._stream("custom_stream", dict(text=text, speaker=speaker, language=language,
                                                          instruct=instruct, chunk_size=chunk_size))

    mod = types.ModuleType("faster_qwen3_tts")
    mod.FasterQwen3TTS = FasterQwen3TTS
    mod.state = state
    return mod


@pytest.fixture
def voices_dir(tmp_path):
    d = tmp_path / "voices" / "v1"
    d.mkdir(parents=True)
    (d / "ref.wav").write_bytes(make_wav(0.3, 24_000))
    (d / "ref.txt").write_text("參考音檔的文字", encoding="utf-8")
    return tmp_path / "voices"


@pytest.fixture
def load_server(monkeypatch, voices_dir):
    """-> function(fake_modules: dict, **env) importing a fresh copy of tts/server.py."""

    def _load(modules: dict, **env):
        for k in ("TTS_BACKEND", "TTS_CHUNK_SIZE", "TTS_MODE", "TTS_MODEL", "TTS_GEN_KWARGS", "TTS_DEFAULT_VOICE",
                  "TTS_ATTN", "TTS_WARMUP_PREFILL", "TTS_DEFAULT_LANGUAGE"):
            monkeypatch.delenv(k, raising=False)
        monkeypatch.setenv("VOICES_DIR", str(voices_dir))
        monkeypatch.setenv("TTS_ATTN", "sdpa")
        for k, v in env.items():
            monkeypatch.setenv(k, v)
        for name, mod in modules.items():
            monkeypatch.setitem(sys.modules, name, mod)
        spec = importlib.util.spec_from_file_location("tts_server_under_test", ROOT / "tts" / "server.py")
        server = importlib.util.module_from_spec(spec)
        monkeypatch.setitem(sys.modules, "tts_server_under_test", server)
        spec.loader.exec_module(server)
        return server

    return _load


@pytest.fixture
def run(load_server):
    """-> context-manager-ish function: run(scripts, **env) -> (client, fake_module, server)."""
    stack = []

    def _run(scripts=None, *, fake_kwargs=None, **env):
        fake = make_fake_faster(scripts, **(fake_kwargs or {}))
        server = load_server({"faster_qwen3_tts": fake}, **env)
        cm = TestClient(server.app, raise_server_exceptions=False)
        stack.append(cm)
        client = cm.__enter__()
        return client, fake, server

    yield _run
    for cm in reversed(stack):
        cm.__exit__(None, None, None)


def synth_calls(fake):
    """(method, kwargs) of requests after start-up (the priming call is dropped)."""
    return [c for c in fake.state.instances[0].calls if c[1]["text"] != PRIME]


# ── startup / health ─────────────────────────────────────────────────────────


def test_auto_selects_faster_and_reports_health(run):
    client, fake, _ = run()
    model = fake.state.instances[0]
    assert model.name == "Qwen/Qwen3-TTS-12Hz-1.7B-Base"
    assert model.load_kwargs == {"device": "cuda:0", "attn_implementation": "sdpa"}
    assert model.warmup_calls == [100]
    assert model._voice_prompt_cache == {}  # cleared on (re)load so a re-picked ref.wav is not stale
    # the voice was primed with one short streaming synthesis using the voice's ref files
    method, kw = model.calls[0]
    assert method == "clone_stream" and kw["text"] == PRIME
    assert kw["ref_audio"].endswith("ref.wav") and kw["ref_text"] == "參考音檔的文字" and kw["xvec_only"] is False

    h = client.get("/health").json()
    assert h["status"] == "ok"
    assert (h["backend"], h["streaming"], h["chunk_size"]) == ("faster", True, 4)
    assert h["voices"] == ["v1"] and h["sample_rate"] == 24000 and h["mode"] == "clone"


def test_chunk_size_env_reaches_the_model(run):
    client, fake, _ = run({S1: [np.zeros(4, dtype=np.float32)]}, TTS_CHUNK_SIZE="8")
    assert client.get("/health").json()["chunk_size"] == 8
    assert client.post("/tts", json={"text": S1}).status_code == 200
    assert synth_calls(fake)[0][1]["chunk_size"] == 8


def test_explicit_qwen_tts_backend_and_bad_value(load_server):
    server = load_server({"faster_qwen3_tts": make_fake_faster()}, TTS_BACKEND="qwen-tts")
    server.QwenTtsEngine = lambda: "qwen-engine"  # the real one needs torch + qwen_tts
    assert server.make_engine() == "qwen-engine"

    server = load_server({"faster_qwen3_tts": make_fake_faster()}, TTS_BACKEND="nope")
    with pytest.raises(RuntimeError, match="TTS_BACKEND"):
        server.make_engine()


def test_auto_falls_back_to_qwen_tts_when_faster_missing(load_server):
    server = load_server({"faster_qwen3_tts": None})  # None in sys.modules => ImportError on import
    server.QwenTtsEngine = lambda: "qwen-engine"
    assert server.make_engine() == "qwen-engine"


# ── /tts streaming ───────────────────────────────────────────────────────────


def test_chunks_are_converted_to_int16_and_sent_in_order(run):
    chunks = [
        np.array([0.5, -0.5, 0.0], dtype=np.float32),
        np.array([2.0, -2.0, 1.0], dtype=np.float64),  # out of range -> clipped
        FakeTensor([0.25, -0.25]),  # torch-like
        np.array([[0.1, 0.2, 0.3]], dtype=np.float32),  # 2-D -> flattened
        np.array([100, -100, 32767], dtype=np.int16),  # already PCM
    ]
    client, _, _ = run({S1: chunks})
    r = client.post("/tts", json={"text": S1})
    assert r.status_code == 200
    expected = pcm(chunks[0], chunks[1], chunks[2], chunks[3]) + np.array([100, -100, 32767], dtype="<i2").tobytes()
    assert r.content == expected
    assert np.frombuffer(r.content[6:12], dtype="<i2").tolist() == [32767, -32767, 32767]  # the clipped chunk


def test_sample_rate_header_comes_from_the_first_chunk(run):
    client, _, _ = run({S1: [(np.zeros(8, dtype=np.float32), 22050), (np.zeros(8, dtype=np.float32), 22050)]})
    r = client.post("/tts", json={"text": S1})
    assert r.headers["x-sample-rate"] == "22050"  # not the 24000 the start-up priming reported
    assert r.headers["content-type"] == "audio/L16; rate=22050; channels=1"
    assert r.headers["x-tts-streaming"] == "chunk"
    assert int(r.headers["x-tts-first-audio-ms"]) >= 0
    assert len(r.content) == 16 * 2


def test_sentence_by_sentence_then_chunk_by_chunk(run):
    a1, a2 = np.full(3, 0.1, dtype=np.float32), np.full(3, 0.2, dtype=np.float32)
    b1, b2, b3 = (np.full(3, v, dtype=np.float32) for v in (0.3, 0.4, 0.5))
    client, fake, _ = run({S1: [a1, a2], S2: [b1, b2, b3]})
    r = client.post("/tts", json={"text": TWO, "language": "zh", "voice": "v1"})
    assert r.status_code == 200
    assert r.content == pcm(a1, a2, b1, b2, b3)
    calls = synth_calls(fake)
    assert [c[1]["text"] for c in calls] == [S1, S2]  # one streaming generation per sentence, in order
    assert all(m == "clone_stream" and kw["language"] == "Chinese" and kw["chunk_size"] == 4 for m, kw in calls)


def test_generation_is_closed_after_a_normal_response(run):
    client, fake, _ = run({S1: [np.zeros(2, dtype=np.float32)] * 3})
    client.post("/tts", json={"text": S1})
    assert S1 in fake.state.closed


def test_error_before_first_chunk_is_a_json_5xx(run):
    client, _, _ = run({S1: [RuntimeError("cuda exploded")]})
    r = client.post("/tts", json={"text": TWO})
    assert r.status_code == 500
    assert r.headers["content-type"].startswith("application/json")
    assert "cuda exploded" in r.json()["error"]


def test_no_audio_at_all_is_a_json_5xx(run):
    client, _, _ = run({S1: []})
    r = client.post("/tts", json={"text": S1})
    assert r.status_code == 500 and "no audio" in r.json()["error"]


def test_error_in_a_later_sentence_truncates_instead_of_a_clean_end(run):
    first = np.full(4, 0.5, dtype=np.float32)
    client, _, _ = run({S1: [first], S2: [ValueError("late failure")]})
    try:
        r = client.post("/tts", json={"text": TWO})
    except Exception:  # the aborted chunked response may surface as a client-side error
        return
    assert r.content in (b"", pcm(first))  # never a "complete" response containing sentence 2


def test_request_validation_before_any_gpu_work(run):
    client, fake, _ = run()
    assert client.post("/tts", json={"text": "   "}).status_code == 400
    r = client.post("/tts", json={"text": S1, "voice": "nobody"})
    assert r.status_code == 404 and "unknown voice" in r.json()["error"]
    assert synth_calls(fake) == []


# ── other modes ──────────────────────────────────────────────────────────────


def test_custom_voice_streams_with_speaker_and_instruct(run):
    c1, c2 = np.full(2, 0.1, dtype=np.float32), np.full(2, 0.2, dtype=np.float32)
    client, fake, _ = run({S1: [c1, c2]}, TTS_MODEL="Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", TTS_DEFAULT_VOICE="Vivian")
    assert client.get("/health").json()["mode"] == "custom_voice"
    r = client.post("/tts", json={"text": S1, "voice": "Serena", "instruct": "撒嬌地說"})
    assert r.content == pcm(c1, c2)
    method, kw = synth_calls(fake)[0]
    assert method == "custom_stream"
    assert (kw["speaker"], kw["instruct"], kw["chunk_size"]) == ("Serena", "撒嬌地說", 4)


def test_mode_without_streaming_method_falls_back_to_whole_sentences(run):
    client, fake, _ = run(fake_kwargs={"with_custom_streaming": False},
                          TTS_MODEL="Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice", TTS_DEFAULT_VOICE="Vivian")
    h = client.get("/health").json()
    assert (h["backend"], h["streaming"]) == ("faster", False)
    r = client.post("/tts", json={"text": TWO})
    assert r.headers["x-tts-streaming"] == "sentence"
    assert r.content == pcm([0.5, -0.5]) * 2  # one whole-utterance result per sentence
    assert [m for m, _ in synth_calls(fake)] == ["custom", "custom"]


# ── cancellation (client disconnect) ─────────────────────────────────────────


def test_pump_stops_generating_when_cancelled(load_server):
    server = load_server({"faster_qwen3_tts": make_fake_faster()})
    produced, closed = [], threading.Event()

    class Endless:
        lock = threading.Lock()

        def stream(self, text, language, voice, instruct):
            try:
                while True:
                    produced.append(1)
                    yield np.zeros(4, dtype=np.float32), 24000
                    time.sleep(0.005)
            finally:
                closed.set()

    async def go():
        pool = ThreadPoolExecutor(max_workers=1)
        pump = server.ChunkPump(Endless(), ["a。", "b。"], "Chinese", None, "", pool, asyncio.get_running_loop())
        pump.start()
        kind, _ = await pump.queue.get()
        assert kind == "chunk"
        pump.cancel()
        await asyncio.wait_for(pump.future, timeout=5)  # the worker thread returns promptly
        pool.shutdown()

    asyncio.run(go())
    assert closed.is_set()  # generator.close() ran -> the model's own cleanup executes
    n = len(produced)
    time.sleep(0.05)
    assert len(produced) == n  # nothing more is generated, and sentence 2 never started


def test_an_offload_stops_a_running_utterance_at_the_next_chunk(load_server):
    server = load_server({"faster_qwen3_tts": make_fake_faster()})
    closed = threading.Event()

    class Endless:
        lock = threading.Lock()
        stopping = False

        def stream(self, text, language, voice, instruct):
            try:
                while True:
                    yield np.zeros(4, dtype=np.float32), 24000
                    time.sleep(0.005)
            finally:
                closed.set()

    eng = Endless()

    async def go():
        pool = ThreadPoolExecutor(max_workers=1)
        pump = server.ChunkPump(eng, ["a。", "b。"], "Chinese", None, "", pool, asyncio.get_running_loop())
        pump.start()
        assert (await pump.queue.get())[0] == "chunk"
        eng.stopping = True  # what /offload sets before it waits for the lock
        await asyncio.wait_for(pump.future, timeout=5)
        kinds = []
        while not pump.queue.empty():
            kinds.append(pump.queue.get_nowait())
        pool.shutdown()
        return kinds

    items = asyncio.run(go())
    assert items[-1][0] == "error" and items[-1][1].status == 503
    assert closed.is_set()
    assert eng.lock.acquire(timeout=1)  # the GPU lock is free for the close


# ── qwen-tts (sentence-level) backend through the same endpoint ──────────────


def test_qwen_tts_backend_is_sentence_level(load_server, monkeypatch):
    torch = types.ModuleType("torch")
    torch.bfloat16 = "bf16"
    calls = []

    class Model:
        @classmethod
        def from_pretrained(cls, name, **kw):
            calls.append(("load", kw))
            return cls()

        def create_voice_clone_prompt(self, **kw):
            return {"prompt": kw["ref_text"]}

        def generate_voice_clone(self, text, language, voice_clone_prompt, **kw):
            calls.append(("gen", text, voice_clone_prompt))
            return [np.full(4, 0.5 if text == S1 else -0.5, dtype=np.float32)], 24000

    qwen = types.ModuleType("qwen_tts")
    qwen.Qwen3TTSModel = Model
    server = load_server({"faster_qwen3_tts": None, "torch": torch, "qwen_tts": qwen})
    with TestClient(server.app) as client:
        h = client.get("/health").json()
        assert (h["backend"], h["streaming"], h["chunk_size"]) == ("qwen-tts", False, None)
        r = client.post("/tts", json={"text": TWO})
    assert r.headers["x-tts-streaming"] == "sentence" and r.headers["x-sample-rate"] == "24000"
    assert r.content == pcm(np.full(4, 0.5), np.full(4, -0.5))
    assert [c[1] for c in calls if c[0] == "gen" and c[1] != PRIME] == [S1, S2]


# ── offload / reload (the song worker borrows the GPU) ───────────────────────


def test_offload_drops_the_engine_and_reload_builds_a_new_one(run):
    client, fake, server = run({S1: [np.zeros(4, dtype=np.float32)]})
    first = fake.state.instances[0]
    r = client.post("/offload", json={"reason": "sing", "max_s": 0}).json()
    assert r["state"] == "offloaded" and "offload_ms" in r
    assert server.state.engine is None
    h = client.get("/health").json()
    assert h["status"] == "ok" and h["offloaded"] is True and h["reason"] == "sing" and h["reload_at"] is None
    for call in (lambda: client.post("/tts", json={"text": S1}), lambda: client.get("/voices")):
        res = call()
        assert res.status_code == 503 and res.json() == {"error": "offloaded"}
    assert client.post("/offload").json()["already"] is True

    r = client.post("/reload").json()
    assert r["state"] == "ready" and "reload_ms" in r
    assert len(fake.state.instances) == 2 and fake.state.instances[1] is not first
    assert fake.state.instances[1].warmup_calls == [100]  # CUDA graphs captured again
    assert client.get("/health").json()["offloaded"] is False
    assert client.post("/tts", json={"text": S1}).status_code == 200
    assert client.post("/reload").json()["already"] is True


def test_a_sentence_after_the_offload_is_not_run_on_the_dropped_model(load_server):
    fake = make_fake_faster()
    server = load_server({"faster_qwen3_tts": fake})
    with TestClient(server.app):
        eng = server.state.engine
        eng.close()
        assert eng.model is None and eng.voices == {}
        pump = server.ChunkPump(eng, [S1], "Chinese", None, "", ThreadPoolExecutor(1), asyncio.new_event_loop())
        got = []
        pump._put = got.append
        pump._run()
        assert got[0][0] == "error" and got[0][1].status == 503


def test_an_offload_nobody_ends_reloads_by_itself(run):
    client, fake, _ = run()
    client.post("/offload", json={"max_s": 0.2})
    deadline = time.time() + 5
    while client.get("/health").json()["offloaded"] and time.time() < deadline:
        time.sleep(0.05)
    assert client.get("/health").json()["offloaded"] is False
    assert len(fake.state.instances) == 2
