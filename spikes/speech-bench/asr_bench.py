"""ASR bench: SenseVoice-Small (sherpa-onnx) vs Qwen3-ASR-0.6B / 1.7B (+ optional Whisper turbo).

Each model lives in its own venv (deps conflict), so run one model family per
invocation and merge afterwards:

    # .venv-sensevoice
    python asr_bench.py run --model sensevoice --audio-dir data/utts --sensevoice-dir models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17
    # .venv-qwen-asr
    python asr_bench.py run --model qwen3-asr-0.6b --model qwen3-asr-1.7b --audio-dir data/utts
    # any venv
    python asr_bench.py summarize results/

Per utterance: latency (ms, CUDA-synchronised), RTF, torch peak VRAM, raw + zh-TW text,
CER vs `<stem>.txt` (after OpenCC + punctuation stripping). Whole-GPU VRAM via nvidia-smi.
"""

from __future__ import annotations

import argparse
import gc
import json
import sys
import time
from pathlib import Path
from typing import Any

from bench_common import (
    GpuSampler,
    Timer,
    audio_seconds,
    edit_distance,
    fmt,
    load_audio,
    markdown_table,
    mean,
    normalize_for_cer,
    pct,
    read_csv,
    read_ref,
    strip_tags,
    to_zh_tw,
    torch_cuda,
    utf8_stdout,
    write_csv,
)

MODELS = ("sensevoice", "qwen3-asr-0.6b", "qwen3-asr-1.7b", "whisper-turbo")
LATENCY_TARGET_MS = 300  # DECISIONS.md「ASR 選型」: Qwen3-ASR wins only if ≤ 300 ms per utterance


# ── Backends ─────────────────────────────────────────────────────────────────
# Each backend: __init__ loads the model, transcribe(samples_16k_f32, sr) -> dict.


class SenseVoiceSherpa:
    """SenseVoice-Small through sherpa-onnx — the same runtime the Rust core would use
    (sherpa-onnx C API, CPU, no PyTorch), so the numbers transfer to production."""

    uses_torch = False

    def __init__(self, args: argparse.Namespace) -> None:
        import sherpa_onnx  # type: ignore

        d = Path(args.sensevoice_dir)
        model = d / ("model.onnx" if args.sensevoice_fp32 else "model.int8.onnx")
        for p in (model, d / "tokens.txt"):
            if not p.exists():
                sys.exit(f"[sensevoice] missing {p} — see README for the model download")
        self.rec = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=str(model),
            tokens=str(d / "tokens.txt"),
            num_threads=args.threads,
            language="auto",
            use_itn=True,
            provider=args.sensevoice_provider,
            debug=False,
        )

    def transcribe(self, x, sr: int) -> dict[str, Any]:
        s = self.rec.create_stream()
        s.accept_waveform(sr, x)
        self.rec.decode_stream(s)
        r = s.result
        # lang / emotion / event are SenseVoice extras; getattr in case of older sherpa-onnx.
        return {
            "text": r.text,
            "lang": getattr(r, "lang", ""),
            "emotion": getattr(r, "emotion", ""),
            "event": getattr(r, "event", ""),
        }


class QwenAsr:
    """Qwen3-ASR via the `qwen-asr` package (transformers backend by default)."""

    uses_torch = True

    def __init__(self, args: argparse.Namespace, size: str) -> None:
        import torch  # type: ignore
        from qwen_asr import Qwen3ASRModel  # type: ignore

        model_id = args.qwen_model_dir.get(size) or f"Qwen/Qwen3-ASR-{size}"
        self.language = args.language  # None = auto-detect
        if args.qwen_backend == "vllm":
            # Linux / WSL2 only. vLLM pre-allocates gpu_memory_utilization of the card, so
            # torch peak numbers are meaningless here — read the nvidia-smi columns instead.
            self.uses_torch = False
            self.model = Qwen3ASRModel.LLM(
                model=model_id,
                gpu_memory_utilization=args.vllm_gpu_mem,
                max_inference_batch_size=1,
                max_new_tokens=256,
            )
        else:
            kw: dict[str, Any] = dict(
                dtype=torch.bfloat16,
                device_map=args.device,
                max_inference_batch_size=32,
                max_new_tokens=256,
            )
            if args.attn:
                kw["attn_implementation"] = args.attn
            self.model = Qwen3ASRModel.from_pretrained(model_id, **kw)

    def transcribe(self, x, sr: int) -> dict[str, Any]:
        # (np.ndarray, sr) tuple input is documented; avoids timing file I/O.
        r = self.model.transcribe(audio=(x, sr), language=self.language)[0]
        return {"text": r.text, "lang": r.language}


class WhisperTurbo:
    """Reference only: faster-whisper large-v3-turbo (CTranslate2; torch not involved)."""

    uses_torch = False

    def __init__(self, args: argparse.Namespace) -> None:
        from faster_whisper import WhisperModel  # type: ignore

        self.model = WhisperModel(args.whisper_model, device="cuda", compute_type="float16")
        self.language = {"Chinese": "zh", "Japanese": "ja", "English": "en"}.get(args.language or "", None)

    def transcribe(self, x, sr: int) -> dict[str, Any]:
        segments, info = self.model.transcribe(x, language=self.language, beam_size=5)
        text = "".join(s.text for s in segments)  # generator: decoding happens here, inside the timer
        return {"text": text, "lang": info.language}


def make_backend(name: str, args: argparse.Namespace):
    if name == "sensevoice":
        return SenseVoiceSherpa(args)
    if name.startswith("qwen3-asr-"):
        return QwenAsr(args, name.removeprefix("qwen3-asr-").upper())
    if name == "whisper-turbo":
        return WhisperTurbo(args)
    raise ValueError(name)


# ── Run ──────────────────────────────────────────────────────────────────────


def run_model(name: str, wavs: list[Path], args: argparse.Namespace, out_dir: Path) -> dict[str, Any]:
    torch = torch_cuda()
    gpu = GpuSampler(gpu_index=args.gpu_index).start()
    print(f"\n=== {name} === ({len(wavs)} utterances)")

    t0 = time.perf_counter()
    backend = make_backend(name, args)
    load_ms = (time.perf_counter() - t0) * 1000
    use_torch = torch if getattr(backend, "uses_torch", False) else None
    weights_mb = use_torch.cuda.memory_allocated() / 2**20 if use_torch else None
    print(f"loaded in {load_ms / 1000:.1f}s" + (f", weights {weights_mb:.0f} MiB" if weights_mb else ""))

    # Warm-up (CUDA kernels, graph capture, ORT session init) — excluded from results.
    x, sr = load_audio(wavs[0])
    for _ in range(args.warmup):
        backend.transcribe(x, sr)

    rows: list[dict[str, Any]] = []
    for i, wav in enumerate(wavs, 1):
        x, sr = load_audio(wav)
        dur = audio_seconds(x, sr)
        if use_torch:
            use_torch.cuda.reset_peak_memory_stats()
        with Timer(use_torch) as t:
            out = backend.transcribe(x, sr)
        ref = read_ref(wav, args.refs_dir)
        hyp_n = normalize_for_cer(out["text"], args.opencc)
        row: dict[str, Any] = {
            "model": name,
            "file": wav.name,
            "audio_s": round(dur, 3),
            "latency_ms": round(t.elapsed_ms, 1),
            "rtf": round(t.elapsed_ms / 1000 / dur, 4) if dur else None,
            "torch_peak_mb": round(use_torch.cuda.max_memory_allocated() / 2**20, 1) if use_torch else None,
            "lang": out.get("lang", ""),
            "emotion": out.get("emotion", ""),
            "event": out.get("event", ""),
            "text_raw": out["text"],
            "text_zh_tw": to_zh_tw(strip_tags(out["text"]), "s2twp"),
            "ref": ref or "",
        }
        if ref:
            ref_n = normalize_for_cer(ref, args.opencc)
            e = edit_distance(ref_n, hyp_n)
            row.update(ref_chars=len(ref_n), edits=e, cer=round(e / max(1, len(ref_n)), 4))
        rows.append(row)
        cer_s = f" CER {row['cer'] * 100:.1f}%" if "cer" in row else ""
        print(f"[{i:>3}/{len(wavs)}] {t.elapsed_ms:7.1f} ms  {dur:5.2f}s  {wav.name}  → {row['text_zh_tw']}{cer_s}")

    gpu.stop()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    csv_path = out_dir / f"asr_{name}_{stamp}.csv"
    write_csv(csv_path, rows)
    meta = {
        "model": name,
        "load_ms": round(load_ms),
        "torch_weights_mb": round(weights_mb, 1) if weights_mb else None,
        **gpu.summary(),
        "args": {k: str(v) for k, v in vars(args).items()},
    }
    csv_path.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"wrote {csv_path}")

    # Free VRAM before the next model in the same process.
    del backend
    gc.collect()
    if torch:
        torch.cuda.empty_cache()
    return summarize_rows(rows, meta)


# ── Summary ──────────────────────────────────────────────────────────────────


def _f(v: Any) -> float | None:
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None


def summarize_rows(rows: list[dict[str, Any]], meta: dict[str, Any]) -> dict[str, Any]:
    lat = [x for r in rows if (x := _f(r.get("latency_ms"))) is not None]
    rtf = [x for r in rows if (x := _f(r.get("rtf"))) is not None]
    edits = sum(int(_f(r.get("edits")) or 0) for r in rows if r.get("ref"))
    ref_chars = sum(int(_f(r.get("ref_chars")) or 0) for r in rows if r.get("ref"))
    n_ref = sum(1 for r in rows if r.get("ref"))
    torch_peak = [x for r in rows if (x := _f(r.get("torch_peak_mb"))) is not None]
    p90 = pct(lat, 90)
    return {
        "model": meta.get("model") or (rows[0]["model"] if rows else "?"),
        "n": len(rows),
        "load_s": (_f(meta.get("load_ms")) or 0) / 1000,
        "p50_ms": pct(lat, 50),
        "p90_ms": p90,
        "max_ms": max(lat) if lat else None,
        "mean_rtf": mean(rtf),
        "n_ref": n_ref,
        # micro-averaged CER: total edits / total reference characters
        "cer_pct": (edits / ref_chars * 100) if ref_chars else None,
        "torch_weights_mb": _f(meta.get("torch_weights_mb")),
        "torch_peak_mb": max(torch_peak) if torch_peak else None,
        "gpu_delta_mb": _f(meta.get("gpu_peak_delta_mb")),
        "gpu_peak_mb": _f(meta.get("gpu_peak_mb")),
        "gpu_total_mb": _f(meta.get("gpu_total_mb")),
        f"p90≤{LATENCY_TARGET_MS}ms": ("yes" if p90 <= LATENCY_TARGET_MS else "NO") if lat else None,
    }


SUMMARY_COLS = [
    ("model", "model"),
    ("n", "n"),
    ("load_s", "load s"),
    ("p50_ms", "p50 ms"),
    ("p90_ms", "p90 ms"),
    ("max_ms", "max ms"),
    ("mean_rtf", "RTF"),
    ("cer_pct", "CER %"),
    ("n_ref", "refs"),
    ("torch_weights_mb", "weights MiB"),
    ("torch_peak_mb", "torch peak MiB"),
    ("gpu_delta_mb", "GPU Δ MiB"),
    ("gpu_peak_mb", "GPU peak MiB"),
    (f"p90≤{LATENCY_TARGET_MS}ms", f"p90≤{LATENCY_TARGET_MS}ms"),
]


def print_summary(summaries: list[dict[str, Any]], out_dir: Path | None) -> None:
    table = markdown_table(summaries, SUMMARY_COLS)
    print("\n" + table)
    total = next((s["gpu_total_mb"] for s in summaries if s.get("gpu_total_mb")), None)
    if total:
        print(f"\n(GPU total {fmt(total, 0)} MiB; 'GPU Δ' = peak − baseline at start, i.e. this model's footprint "
              "on top of whatever was already running — run with the game + OBS open.)")
    if out_dir:
        (out_dir / "asr_summary.md").write_text(table + "\n", encoding="utf-8")
        write_csv(out_dir / "asr_summary.csv", summaries)
        print(f"wrote {out_dir / 'asr_summary.md'}")


def cmd_summarize(args: argparse.Namespace) -> None:
    out_dir = Path(args.results)
    latest: dict[str, Path] = {}
    for p in sorted(out_dir.glob("asr_*_*.csv")):  # sorted by timestamp -> keep newest per model
        if p.name.startswith("asr_summary"):
            continue
        rows = read_csv(p)
        if rows:
            latest[rows[0]["model"]] = p
    if not latest:
        sys.exit(f"no asr_*.csv in {out_dir}")
    summaries = []
    for name in sorted(latest, key=lambda m: MODELS.index(m) if m in MODELS else 99):
        p = latest[name]
        meta_p = p.with_suffix(".json")
        meta = json.loads(meta_p.read_text(encoding="utf-8")) if meta_p.exists() else {"model": name}
        summaries.append(summarize_rows(read_csv(p), meta))
    print_summary(summaries, out_dir)


def cmd_run(args: argparse.Namespace) -> None:
    audio_dir = Path(args.audio_dir)
    wavs = sorted(audio_dir.glob("*.wav"))[: args.limit or None]
    if not wavs:
        sys.exit(f"no .wav files in {audio_dir}")
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    args.qwen_model_dir = {"0.6B": args.qwen_06b, "1.7B": args.qwen_17b}
    summaries = [run_model(m, wavs, args, out_dir) for m in args.model]
    print_summary(summaries, None)
    print("\nRun `python asr_bench.py summarize results/` after all venvs to get the combined table.")


def main() -> None:
    utf8_stdout()
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    r = sub.add_parser("run", help="benchmark one or more models on a folder of WAVs")
    r.add_argument("--model", action="append", choices=MODELS, required=True, help="repeatable")
    r.add_argument("--audio-dir", required=True, help="folder of .wav (+ optional <stem>.txt references)")
    r.add_argument("--refs-dir", type=Path, default=None, help="look for <stem>.txt here first")
    r.add_argument("--out", default="results")
    r.add_argument("--limit", type=int, default=0, help="only the first N files (0 = all)")
    r.add_argument("--warmup", type=int, default=2)
    r.add_argument("--opencc", default="s2tw", help="OpenCC config for CER normalisation (s2t / s2tw / s2twp)")
    r.add_argument("--language", default=None, help='force language, e.g. "Chinese" (default: auto-detect)')
    r.add_argument("--gpu-index", type=int, default=0)
    # SenseVoice
    r.add_argument("--sensevoice-dir", default="models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17")
    r.add_argument("--sensevoice-fp32", action="store_true", help="use model.onnx instead of model.int8.onnx")
    r.add_argument("--sensevoice-provider", default="cpu", choices=["cpu", "cuda"])
    r.add_argument("--threads", type=int, default=4, help="sherpa-onnx CPU threads")
    # Qwen3-ASR
    r.add_argument("--qwen-backend", default="transformers", choices=["transformers", "vllm"])
    r.add_argument("--qwen-06b", default=None, help="local dir instead of Qwen/Qwen3-ASR-0.6B")
    r.add_argument("--qwen-17b", default=None, help="local dir instead of Qwen/Qwen3-ASR-1.7B")
    r.add_argument("--attn", default=None, choices=[None, "flash_attention_2", "sdpa", "eager"],
                   help="transformers attn_implementation (default: library default)")
    r.add_argument("--device", default="cuda:0")
    r.add_argument("--vllm-gpu-mem", type=float, default=0.3, help="vLLM gpu_memory_utilization")
    # Whisper
    r.add_argument("--whisper-model", default="large-v3-turbo")
    r.set_defaults(func=cmd_run)

    s = sub.add_parser("summarize", help="merge the newest CSV per model into one table")
    s.add_argument("results", nargs="?", default="results")
    s.set_defaults(func=cmd_summarize)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":  # guard required by the vLLM backend (multiprocessing spawn)
    main()
