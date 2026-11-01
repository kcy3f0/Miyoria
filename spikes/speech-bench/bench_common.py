"""Shared helpers for the ASR / TTS benches: audio I/O, OpenCC normalisation, CER,
GPU memory sampling (nvidia-smi) and small table/CSV utilities.

Only depends on requirements/common.txt, so every venv can import it.
"""

from __future__ import annotations

import csv
import math
import re
import shutil
import statistics
import subprocess
import sys
import threading
import time
import unicodedata
from dataclasses import dataclass
from math import gcd
from pathlib import Path
from typing import Any, Iterable, Sequence

import numpy as np
import soundfile as sf


def utf8_stdout() -> None:
    """Windows consoles default to cp950/cp1252; force UTF-8 so CJK / kana print."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except AttributeError:
            pass


# ── Audio ────────────────────────────────────────────────────────────────────


def load_audio(path: Path, target_sr: int = 16_000) -> tuple[np.ndarray, int]:
    """Read a WAV as mono float32 in [-1, 1], resampled to target_sr (48k -> 16k is exact 1:3)."""
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if sr != target_sr:
        from scipy.signal import resample_poly

        g = gcd(sr, target_sr)
        mono = resample_poly(mono, target_sr // g, sr // g).astype(np.float32)
        sr = target_sr
    return np.ascontiguousarray(mono, dtype=np.float32), sr


def audio_seconds(samples: np.ndarray | Sequence[float], sr: int) -> float:
    return len(samples) / float(sr) if sr else 0.0


# ── Text normalisation + CER ─────────────────────────────────────────────────

_SENSEVOICE_TAG = re.compile(r"<\|[^|]*\|>")
_converters: dict[str, Any] = {}


def _opencc(config: str):
    """OpenCC converter; prefers the native `opencc` package, falls back to the pure-Python one."""
    if config not in _converters:
        conv = None
        try:  # official bindings (pip install opencc)
            import opencc  # type: ignore

            for name in (config, f"{config}.json"):
                try:
                    conv = opencc.OpenCC(name)
                    break
                except Exception:
                    continue
        except ImportError:
            pass
        if conv is None:  # opencc-python-reimplemented
            from opencc import OpenCC  # type: ignore

            conv = OpenCC(config)
        _converters[config] = conv
    return _converters[config]


def strip_tags(text: str) -> str:
    """Remove SenseVoice-style <|zh|><|HAPPY|>… tags if a backend leaves them in."""
    return _SENSEVOICE_TAG.sub("", text).strip()


def to_zh_tw(text: str, config: str = "s2tw") -> str:
    """Simplified -> Traditional (Taiwan). Kana / Latin pass through untouched."""
    return _opencc(config).convert(text)


def normalize_for_cer(text: str, opencc_config: str = "s2tw") -> str:
    """Strip model tags, OpenCC -> zh-TW, NFKC (full-width -> half-width), lowercase,
    keep only letters and digits (drops punctuation, spaces, emoji)."""
    text = _SENSEVOICE_TAG.sub("", text)
    text = to_zh_tw(text, opencc_config)
    text = unicodedata.normalize("NFKC", text).lower()
    return "".join(ch for ch in text if unicodedata.category(ch)[0] in ("L", "N"))


def edit_distance(ref: str, hyp: str) -> int:
    """Character-level Levenshtein distance (substitutions + deletions + insertions)."""
    if len(ref) < len(hyp):
        ref, hyp = hyp, ref
    prev = list(range(len(hyp) + 1))
    for i, rc in enumerate(ref, 1):
        cur = [i]
        for j, hc in enumerate(hyp, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (rc != hc)))
        prev = cur
    return prev[-1]


def read_ref(wav: Path, refs_dir: Path | None = None) -> str | None:
    """Reference transcript = `<stem>.txt` next to the WAV (or in refs_dir). Empty file = no ref."""
    for d in ([refs_dir] if refs_dir else []) + [wav.parent]:
        p = d / f"{wav.stem}.txt"
        if p.exists():
            t = p.read_text(encoding="utf-8").strip()
            return t or None
    return None


# ── GPU memory ───────────────────────────────────────────────────────────────


class GpuSampler:
    """Samples whole-GPU memory.used / utilization via nvidia-smi in a background thread.

    Whole-GPU numbers include the game / OBS / other processes, which is exactly what
    matters for "does it fit alongside the game" (risk R3). `baseline_mb` is taken at
    start(); report `peak_mb - baseline_mb` as this process's footprint.
    """

    def __init__(self, interval_ms: int = 200, gpu_index: int = 0) -> None:
        self.interval_ms = interval_ms
        self.gpu_index = gpu_index
        self.available = shutil.which("nvidia-smi") is not None
        self.baseline_mb: float | None = None
        self.peak_mb: float | None = None
        self.total_mb: float | None = None
        self.peak_util: float | None = None
        self._proc: subprocess.Popen[str] | None = None
        self._thread: threading.Thread | None = None

    def _query_once(self) -> tuple[float, float, float] | None:
        try:
            out = subprocess.run(
                [
                    "nvidia-smi",
                    f"--id={self.gpu_index}",
                    "--query-gpu=memory.used,memory.total,utilization.gpu",
                    "--format=csv,noheader,nounits",
                ],
                capture_output=True,
                text=True,
                timeout=10,
            ).stdout.strip()
            used, total, util = (float(x) for x in out.split(","))
            return used, total, util
        except Exception:
            return None

    def start(self) -> "GpuSampler":
        if not self.available:
            return self
        first = self._query_once()
        if first:
            self.baseline_mb, self.total_mb, _ = first
            self.peak_mb = first[0]
        self._proc = subprocess.Popen(
            [
                "nvidia-smi",
                f"--id={self.gpu_index}",
                "--query-gpu=memory.used,utilization.gpu",
                "--format=csv,noheader,nounits",
                f"--loop-ms={self.interval_ms}",
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        self._thread = threading.Thread(target=self._reader, daemon=True)
        self._thread.start()
        return self

    def _reader(self) -> None:
        assert self._proc and self._proc.stdout
        for line in self._proc.stdout:
            try:
                used, util = (float(x) for x in line.strip().split(","))
            except ValueError:
                continue
            self.peak_mb = max(self.peak_mb or 0.0, used)
            self.peak_util = max(self.peak_util or 0.0, util)

    def stop(self) -> None:
        if self._proc:
            self._proc.terminate()
            self._proc = None

    def summary(self) -> dict[str, float | None]:
        delta = None
        if self.peak_mb is not None and self.baseline_mb is not None:
            delta = self.peak_mb - self.baseline_mb
        return {
            "gpu_baseline_mb": self.baseline_mb,
            "gpu_peak_mb": self.peak_mb,
            "gpu_peak_delta_mb": delta,
            "gpu_total_mb": self.total_mb,
            "gpu_peak_util_pct": self.peak_util,
        }


def torch_cuda():
    """Return the torch module if CUDA is usable, else None (sherpa-onnx / CTranslate2 venvs)."""
    try:
        import torch  # type: ignore

        return torch if torch.cuda.is_available() else None
    except ImportError:
        return None


@dataclass
class Timer:
    """Wall-clock timer that synchronises CUDA (if present) so GPU work is included."""

    torch_mod: Any = None
    start: float = 0.0
    elapsed_ms: float = 0.0

    def __enter__(self) -> "Timer":
        if self.torch_mod is not None:
            self.torch_mod.cuda.synchronize()
        self.start = time.perf_counter()
        return self

    def __exit__(self, *exc: object) -> None:
        if self.torch_mod is not None:
            self.torch_mod.cuda.synchronize()
        self.elapsed_ms = (time.perf_counter() - self.start) * 1000


# ── Stats / output ───────────────────────────────────────────────────────────


def pct(values: Sequence[float], q: float) -> float:
    """Nearest-rank percentile (q in 0..100)."""
    if not values:
        return math.nan
    s = sorted(values)
    k = max(0, min(len(s) - 1, math.ceil(q / 100 * len(s)) - 1))
    return s[k]


def mean(values: Iterable[float]) -> float:
    v = [x for x in values if x is not None and not math.isnan(x)]
    return statistics.fmean(v) if v else math.nan


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    keys: list[str] = []
    for r in rows:
        keys.extend(k for k in r if k not in keys)
    # utf-8-sig so Excel on Windows shows CJK correctly
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=keys)
        w.writeheader()
        w.writerows(rows)


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as f:
        return list(csv.DictReader(f))


def fmt(v: Any, digits: int = 1) -> str:
    if v is None or v == "":
        return "—"
    if isinstance(v, float):
        return "—" if math.isnan(v) else f"{v:.{digits}f}"
    return str(v)


def markdown_table(rows: list[dict[str, Any]], columns: list[tuple[str, str]]) -> str:
    """columns = [(key, header), ...]"""
    head = "| " + " | ".join(h for _, h in columns) + " |"
    sep = "|" + "|".join("---" for _ in columns) + "|"
    body = ["| " + " | ".join(fmt(r.get(k)) for k, _ in columns) + " |" for r in rows]
    return "\n".join([head, sep, *body])
