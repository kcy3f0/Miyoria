"""TTS bench for DeepSeek-chan's voice (Qwen3-TTS, optional GPT-SoVITS).

Modes
  design    VoiceDesign: read [design] instruct / sample_text from the profile's voice.toml
            and generate N candidate reference clips for the owner to pick.
  clone     Base (voice clone): build a clone prompt from the chosen reference once, then
            synthesise the fixed test lines; measure latency / RTF / VRAM.
  emotions  VoiceDesign + per-line emotion instruct from [emotion.instruct] (Base ignores
            instruct — DECISIONS「TTS 選型」— so this shows what instruction control buys).
  sovits    Client for a running GPT-SoVITS api_v2 server (optional comparison; measures
            real time-to-first-audio via its streaming mode).

Streaming / TTFA: the qwen-tts README (checked 2026-11-01) advertises a streaming-capable
model but documents NO streaming call in the Python package (only full `generate_*`; vLLM-Omni
is "offline only" for now). So for Qwen3-TTS we report full-utterance latency, which is an
UPPER BOUND on time-to-first-audio. `probe_streaming()` prints any stream-like methods it finds
in the installed version so you can check by hand.

Examples
  python tts_bench.py design --n 8
  python tts_bench.py clone --ref out/design/cand_03_seed1003.wav
  python tts_bench.py emotions
  python tts_bench.py sovits --url http://127.0.0.1:9880 --ref ref.wav --ref-text "…"
"""

from __future__ import annotations

import argparse
import importlib.util
import inspect
import json
import random
import sys
import time
import urllib.request
from pathlib import Path
from typing import Any

import soundfile as sf
import tomllib

from bench_common import GpuSampler, Timer, markdown_table, mean, pct, torch_cuda, utf8_stdout, write_csv

HERE = Path(__file__).resolve().parent
DEFAULT_PROFILE = HERE.parent.parent / "profiles" / "deepseek-chan" / "voice.toml"

# (emotion key in voice.toml [emotion.instruct] or "", language, text)
# Chinese with Japanese interjections, game jargon, short fillers and a long line for RTF.
TEST_LINES: list[tuple[str, str, str]] = [
    ("embarrassed", "Chinese", "哼,你終於來了喔?我才、才沒有在等你呢。"),
    ("annoyed", "Chinese", "baka!你是笨蛋嗎?這種事情也要問我?"),
    ("angry", "Chinese", "hentai!不要一直盯著我看啦!"),
    ("annoyed", "Chinese", "うるさい!我知道啦,不用你一直提醒。"),
    ("happy", "Chinese", "哇,真的假的?我們真的打贏了?太好了!"),
    ("smug", "Chinese", "哼哼,看吧,我就說我是天才吧。"),
    ("sad", "Chinese", "……今天大家都不理我,有點寂寞而已啦。"),
    ("", "Chinese", "嗯……讓我想一下。"),
    ("", "Chinese", "這個 boss 的第二階段會放 AOE,先往左邊跑,補血的跟緊我!"),
    ("", "Japanese", "ねえ、聞いてる?ちゃんと聞いてよ、もう!"),
    ("happy", "Chinese", "好啦好啦,下次換我保護你,約好了喔。不准反悔,打勾勾!"),
    (
        "",
        "Chinese",
        "其實我一直覺得,跟大家一起熬夜打遊戲、聊些有的沒的,就是最開心的時候了。"
        "雖然你們每次都很吵,但是……嗯,沒事啦,繼續玩吧。",
    ),
]


# ── Helpers ──────────────────────────────────────────────────────────────────


def load_profile(path: Path) -> dict[str, Any]:
    with path.open("rb") as f:
        return tomllib.load(f)


def text_or_file(value: str | None, base: Path) -> str | None:
    """voice.toml's ref_text may be a path to a .txt file or literal text."""
    if not value:
        return None
    p = (base / value) if not Path(value).is_absolute() else Path(value)
    if p.suffix == ".txt" and p.exists():
        return p.read_text(encoding="utf-8").strip()
    return value


def read_lines(path: str | None) -> list[tuple[str, str, str]]:
    """Lines file: either `text` or `emotion<TAB>language<TAB>text` per line."""
    if not path:
        return TEST_LINES
    out = []
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        if not raw.strip() or raw.startswith("#"):
            continue
        parts = raw.split("\t")
        out.append((parts[0], parts[1], parts[2]) if len(parts) >= 3 else ("", "Chinese", raw.strip()))
    return out


def resolve_attn(choice: str) -> str | None:
    if choice == "auto":
        # FlashAttention 2 if it imports (Linux/WSL2 usually), else PyTorch SDPA (works on Windows).
        return "flash_attention_2" if importlib.util.find_spec("flash_attn") else "sdpa"
    return None if choice == "default" else choice


def load_qwen_tts(model_id: str, args: argparse.Namespace):
    import torch  # type: ignore
    from qwen_tts import Qwen3TTSModel  # type: ignore

    kw: dict[str, Any] = dict(device_map=args.device, dtype=torch.bfloat16)
    attn = resolve_attn(args.attn)
    if attn:
        kw["attn_implementation"] = attn
    print(f"loading {model_id} (attn={attn}) …")
    t0 = time.perf_counter()
    model = Qwen3TTSModel.from_pretrained(model_id, **kw)
    load_ms = (time.perf_counter() - t0) * 1000
    weights = torch.cuda.memory_allocated() / 2**20 if torch.cuda.is_available() else None
    print(f"loaded in {load_ms / 1000:.1f}s" + (f", weights {weights:.0f} MiB" if weights else ""))
    probe_streaming(model)
    return model, load_ms, weights


def probe_streaming(model: Any) -> None:
    """Report any public stream-ish API in the installed qwen-tts (not used automatically)."""
    names = [n for n in dir(model) if "stream" in n.lower() and not n.startswith("_")]
    params = []
    for fn in ("generate_voice_clone", "generate_voice_design", "generate_custom_voice"):
        f = getattr(model, fn, None)
        if f is not None:
            try:
                params += [f"{fn}({p})" for p in inspect.signature(f).parameters if "stream" in p.lower()]
            except (TypeError, ValueError):
                pass
    if names or params:
        print(f"[streaming probe] found: {names + params} — unverified; TTFA below is still full-utterance")
    else:
        print("[streaming probe] no streaming API in this qwen-tts build; TTFA = full-utterance latency (upper bound)")


def seed_all(seed: int) -> None:
    random.seed(seed)
    try:
        import numpy as np

        np.random.seed(seed)
    except ImportError:
        pass
    torch = torch_cuda()
    if torch:
        torch.manual_seed(seed)
        torch.cuda.manual_seed_all(seed)


def timed_generate(fn, torch_mod, **kw) -> tuple[Any, int, float, float | None]:
    """Run one generate_* call; returns (wav, sr, latency_ms, torch_peak_mib)."""
    if torch_mod:
        torch_mod.cuda.reset_peak_memory_stats()
    with Timer(torch_mod) as t:
        wavs, sr = fn(**kw)
    peak = torch_mod.cuda.max_memory_allocated() / 2**20 if torch_mod else None
    return wavs[0], sr, t.elapsed_ms, peak


def result_row(mode: str, idx: int, label: str, text: str, wav, sr: int, ms: float, peak: float | None, path: Path):
    dur = len(wav) / sr if sr else 0.0
    return {
        "mode": mode,
        "idx": idx,
        "label": label,
        "text": text,
        "audio_s": round(dur, 3),
        "latency_ms": round(ms, 1),
        "ttfa_ms": round(ms, 1),  # no streaming API -> first audio == whole utterance
        "ttfa_is_upper_bound": True,
        "rtf": round(ms / 1000 / dur, 4) if dur else None,
        "torch_peak_mb": round(peak, 1) if peak else None,
        "file": str(path),
    }


def finish(mode: str, rows: list[dict[str, Any]], gpu: GpuSampler, meta: dict[str, Any], out_root: Path) -> None:
    gpu.stop()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    res = out_root / "results"
    csv_path = res / f"tts_{mode}_{stamp}.csv"
    write_csv(csv_path, rows)
    meta = {**meta, **gpu.summary()}
    csv_path.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    lat = [r["latency_ms"] for r in rows if r.get("latency_ms") is not None]
    ttfa = [r["ttfa_ms"] for r in rows if r.get("ttfa_ms") is not None]
    peaks = [r["torch_peak_mb"] for r in rows if r.get("torch_peak_mb")]
    summary = {
        "mode": mode,
        "model": meta.get("model", ""),
        "n": len(rows),
        "p50_ms": pct(lat, 50),
        "p90_ms": pct(lat, 90),
        "ttfa_p50_ms": pct(ttfa, 50),
        "ttfa_note": "upper bound" if rows and rows[0].get("ttfa_is_upper_bound") else "measured",
        "mean_rtf": mean(r["rtf"] for r in rows if r.get("rtf") is not None),
        "torch_peak_mb": max(peaks) if peaks else None,
        "gpu_delta_mb": meta.get("gpu_peak_delta_mb"),
        "gpu_peak_mb": meta.get("gpu_peak_mb"),
    }
    print("\n" + markdown_table([summary], [(k, k) for k in summary]))
    print(f"\nwrote {csv_path}")


# ── Modes ────────────────────────────────────────────────────────────────────


def cmd_design(args: argparse.Namespace) -> None:
    prof = load_profile(Path(args.profile))
    d = prof.get("design", {})
    instruct = (args.instruct or d.get("instruct", "")).strip()
    text = (args.text or d.get("sample_text", "")).strip()
    language = args.language or d.get("language", "Chinese")
    if not instruct or not text:
        sys.exit("voice.toml needs [design] instruct and sample_text (or pass --instruct / --text)")
    gen_kw = json.loads(args.gen_kwargs) if args.gen_kwargs else {}

    gpu = GpuSampler().start()
    model_id = args.model or "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
    model, load_ms, weights = load_qwen_tts(model_id, args)
    torch = torch_cuda()
    out = Path(args.out) / "design"
    out.mkdir(parents=True, exist_ok=True)
    print(f"instruct: {instruct}\ntext:     {text}\n")

    rows = []
    for i in range(args.n):
        seed = args.seed + i
        seed_all(seed)
        wav, sr, ms, peak = timed_generate(
            model.generate_voice_design, torch, text=text, language=language, instruct=instruct, **gen_kw
        )
        path = out / f"cand_{i:02d}_seed{seed}.wav"
        sf.write(str(path), wav, sr)
        # Transcript next to the clip so the chosen one can be fed straight to `clone`.
        path.with_suffix(".txt").write_text(text, encoding="utf-8")
        rows.append(result_row("design", i, f"seed{seed}", text, wav, sr, ms, peak, path))
        print(f"[{i + 1}/{args.n}] {ms:7.0f} ms  RTF {rows[-1]['rtf']}  → {path.name}")

    print("\nListen to out/design/*.wav. If all candidates sound identical, sampling is probably off:"
          ' retry with --gen-kwargs \'{"do_sample": true, "temperature": 0.9, "top_p": 0.95}\'.')
    finish("design", rows, gpu, {"model": model_id, "load_ms": load_ms, "weights_mb": weights,
                                  "instruct": instruct, "text": text}, Path(args.out))


def cmd_clone(args: argparse.Namespace) -> None:
    profile_path = Path(args.profile)
    prof = load_profile(profile_path)
    c = prof.get("clone", {})
    ref = args.ref or (str(profile_path.parent / c["ref_audio"]) if c.get("ref_audio") else None)
    if not ref or not Path(ref).exists():
        sys.exit(f"reference audio not found: {ref} (pass --ref, e.g. a candidate from `design`)")
    sidecar = Path(ref).with_suffix(".txt")  # written by `design` next to each candidate
    ref_text = (
        text_or_file(args.ref_text, Path.cwd())
        or (sidecar.read_text(encoding="utf-8").strip() if sidecar.exists() else None)
        or text_or_file(c.get("ref_text"), profile_path.parent)
    )
    if not ref_text and not args.x_vector_only:
        sys.exit("need --ref-text (or <ref>.txt next to the clip), or use --x-vector-only")

    gpu = GpuSampler().start()
    model_id = args.model or f"Qwen/Qwen3-TTS-12Hz-{args.size}-Base"
    model, load_ms, weights = load_qwen_tts(model_id, args)
    torch = torch_cuda()

    with Timer(torch) as t:
        prompt = model.create_voice_clone_prompt(
            ref_audio=ref, ref_text=ref_text, x_vector_only_mode=args.x_vector_only
        )
    print(f"clone prompt built in {t.elapsed_ms:.0f} ms from {ref}")

    lines = read_lines(args.lines)
    out = Path(args.out) / f"clone-{args.size}"
    out.mkdir(parents=True, exist_ok=True)
    # Warm-up (excluded) so the first line doesn't carry CUDA init cost.
    model.generate_voice_clone(text="你好。", language="Chinese", voice_clone_prompt=prompt)

    rows = []
    for i, (emotion, lang, text) in enumerate(lines):
        for rep in range(args.repeat):
            wav, sr, ms, peak = timed_generate(
                model.generate_voice_clone, torch, text=text,
                language=args.language or lang, voice_clone_prompt=prompt,
            )
            path = out / f"line_{i:02d}_r{rep}.wav"
            sf.write(str(path), wav, sr)
            rows.append(result_row("clone", i, emotion or "-", text, wav, sr, ms, peak, path))
            print(f"[{i:02d}.{rep}] {ms:7.0f} ms  {rows[-1]['audio_s']:5.2f}s  RTF {rows[-1]['rtf']}  {text[:30]}")

    finish("clone", rows, gpu, {"model": model_id, "load_ms": load_ms, "weights_mb": weights,
                                 "prompt_ms": t.elapsed_ms, "ref": ref, "ref_text": ref_text}, Path(args.out))


def cmd_emotions(args: argparse.Namespace) -> None:
    prof = load_profile(Path(args.profile))
    base_instruct = prof.get("design", {}).get("instruct", "").strip()
    emo = prof.get("emotion", {}).get("instruct", {})
    gpu = GpuSampler().start()
    model_id = args.model or "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign"
    model, load_ms, weights = load_qwen_tts(model_id, args)
    torch = torch_cuda()
    out = Path(args.out) / "emotions"
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    for i, (emotion, lang, text) in enumerate(read_lines(args.lines)):
        instruct = base_instruct + (f"\n這句話的語氣:{emo[emotion]}" if emotion in emo else "")
        seed_all(args.seed)  # same seed for every line keeps the timbre as stable as possible
        wav, sr, ms, peak = timed_generate(
            model.generate_voice_design, torch, text=text, language=args.language or lang, instruct=instruct
        )
        path = out / f"line_{i:02d}_{emotion or 'neutral'}.wav"
        sf.write(str(path), wav, sr)
        rows.append(result_row("emotions", i, emotion or "-", text, wav, sr, ms, peak, path))
        print(f"[{i:02d}] {ms:7.0f} ms  {emotion or '-':<12} {text[:30]}")
    finish("emotions", rows, gpu, {"model": model_id, "load_ms": load_ms, "weights_mb": weights}, Path(args.out))


def cmd_sovits(args: argparse.Namespace) -> None:
    """GPT-SoVITS api_v2 (`python api_v2.py`, default port 9880). Field names follow api_v2.py;
    check them against the GPT-SoVITS version you run."""
    if not args.ref or not args.ref_text:
        sys.exit("sovits needs --ref (path as seen by the GPT-SoVITS server) and --ref-text")
    out = Path(args.out) / "sovits"
    out.mkdir(parents=True, exist_ok=True)
    gpu = GpuSampler().start()  # measures whole-GPU usage while the server works

    def post(payload: dict[str, Any]):
        req = urllib.request.Request(
            f"{args.url.rstrip('/')}/tts",
            data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"},
        )
        return urllib.request.urlopen(req, timeout=300)

    rows = []
    for i, (emotion, lang, text) in enumerate(read_lines(args.lines)):
        payload = {
            "text": text,
            "text_lang": args.sovits_text_lang or {"Japanese": "ja", "English": "en"}.get(lang, "zh"),
            "ref_audio_path": args.ref,
            "prompt_text": args.ref_text,
            "prompt_lang": args.sovits_prompt_lang,
            "text_split_method": "cut5",
            "media_type": "wav",
        }
        # 1) streaming request: time to the first audio bytes (real TTFA)
        t0 = time.perf_counter()
        with post({**payload, "streaming_mode": True}) as r:
            r.read(4096)
            ttfa = (time.perf_counter() - t0) * 1000
            r.read()
        # 2) non-streaming request: full latency + a clean WAV for listening / RTF
        t0 = time.perf_counter()
        with post({**payload, "streaming_mode": False}) as r:
            data = r.read()
        ms = (time.perf_counter() - t0) * 1000
        path = out / f"line_{i:02d}.wav"
        path.write_bytes(data)
        info = sf.info(str(path))
        dur = info.frames / info.samplerate if info.samplerate else 0.0
        rows.append({
            "mode": "sovits", "idx": i, "label": emotion or "-", "text": text, "audio_s": round(dur, 3),
            "latency_ms": round(ms, 1), "ttfa_ms": round(ttfa, 1), "ttfa_is_upper_bound": False,
            "rtf": round(ms / 1000 / dur, 4) if dur else None, "torch_peak_mb": None, "file": str(path),
        })
        print(f"[{i:02d}] TTFA {ttfa:6.0f} ms  total {ms:6.0f} ms  {dur:5.2f}s  {text[:30]}")
    finish("sovits", rows, gpu, {"model": "gpt-sovits", "url": args.url}, Path(args.out))


# ── CLI ──────────────────────────────────────────────────────────────────────


def main() -> None:
    utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--profile", default=str(DEFAULT_PROFILE), help="voice.toml of the persona")
        p.add_argument("--out", default="out")
        p.add_argument("--model", default=None, help="HF id or local dir (overrides the default for this mode)")
        p.add_argument("--language", default=None, help='override language for every line, e.g. "Auto"')
        p.add_argument("--lines", default=None, help="custom test lines (text, or emotion<TAB>language<TAB>text)")
        p.add_argument("--device", default="cuda:0")
        p.add_argument("--attn", default="auto", choices=["auto", "flash_attention_2", "sdpa", "eager", "default"])
        p.add_argument("--seed", type=int, default=1000)

    d = sub.add_parser("design", help="Mode A: VoiceDesign candidates from voice.toml")
    common(d)
    d.add_argument("--n", type=int, default=8)
    d.add_argument("--instruct", default=None)
    d.add_argument("--text", default=None)
    d.add_argument("--gen-kwargs", default=None, help='JSON passed to generate, e.g. {"do_sample": true}')
    d.set_defaults(func=cmd_design)

    c = sub.add_parser("clone", help="Mode B: clone from a reference and synthesise the test lines")
    common(c)
    c.add_argument("--size", default="1.7B", choices=["1.7B", "0.6B"])
    c.add_argument("--ref", default=None, help="reference WAV (default: [clone] ref_audio in voice.toml)")
    c.add_argument("--ref-text", default=None, help="transcript or path to .txt (default: <ref>.txt)")
    c.add_argument("--x-vector-only", action="store_true", help="speaker embedding only (no ref_text)")
    c.add_argument("--repeat", type=int, default=2, help="runs per line, for stable latency numbers")
    c.set_defaults(func=cmd_clone)

    e = sub.add_parser("emotions", help="VoiceDesign + per-line emotion instruct")
    common(e)
    e.set_defaults(func=cmd_emotions)

    s = sub.add_parser("sovits", help="Mode C: GPT-SoVITS api_v2 client")
    common(s)
    s.add_argument("--url", default="http://127.0.0.1:9880")
    s.add_argument("--ref", default=None)
    s.add_argument("--ref-text", default=None)
    s.add_argument("--sovits-text-lang", default=None, help="force text_lang (zh / ja / en / auto …)")
    s.add_argument("--sovits-prompt-lang", default="zh")
    s.set_defaults(func=cmd_sovits)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
