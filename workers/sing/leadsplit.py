"""Lead / backing vocal split: the stage after Demucs, so Seed-VC hears one voice.

Demucs gives "the vocals", which in most songs is the lead with its harmonies, doubles and ad-libs
all in one stem. Seed-VC's pitch detector (RMVPE) is trained on one voice at a time: where a second
voice is as loud as the lead it reads that one, and the lead's own contour jumps by a third or an
octave for as long as the harmony is the stronger (the "breaks" in a converted song). No decoder over
RMVPE's output can undo that, since the lead's salience is simply not there. So the stem is split
first: a Mel-Band RoFormer trained to take the lead voice out of the vocals (the aufr33 & viperx
karaoke model) gives ``lead``, and ``backing = vocals - lead`` is whatever it took away.

Seed-VC then converts only the lead (pitch statistics and the auto key come from it too); the
backing goes back into the instrumental at its original level, so the song keeps its harmonies
(as they were recorded, not in her voice).

Model: ``SING_LEAD_MODEL`` is the checkpoint (``.ckpt``, a state dict), default
``workers/models/lead-split/mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt``; its config is
the ``.yaml`` of the same name beside it (or ``config.yaml``). Nothing downloads it: with no file the
split is off and the pipeline is the plain one. ``SING_LEAD_SPLIT=0`` turns it off with the file there.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable

CKPT_NAME = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
HERE = Path(__file__).resolve().parent
DEFAULT_DIR = HERE.parent / "models" / "lead-split"


def enabled(env: dict[str, str] | None = None) -> bool:
    return (env if env is not None else os.environ).get("SING_LEAD_SPLIT", "1") != "0"


def model_path(env: dict[str, str] | None = None) -> Path:
    e = env if env is not None else os.environ
    return Path(e.get("SING_LEAD_MODEL") or DEFAULT_DIR / CKPT_NAME)


def config_path(ckpt: Path) -> Path | None:
    for c in (ckpt.with_suffix(".yaml"), ckpt.parent / "config.yaml"):
        if c.exists():
            return c
    return None


def available(env: dict[str, str] | None = None) -> bool:
    """Whether a split would run: switched on, and the checkpoint and its config are there."""
    if not enabled(env):
        return False
    ckpt = model_path(env)
    return ckpt.is_file() and config_path(ckpt) is not None


class LeadSplitter:
    """The model and the chunked inference around it (torch is imported here, not at import)."""

    def __init__(self, ckpt: Path, device: str) -> None:
        import torch
        import yaml

        cfg_file = config_path(ckpt)
        if cfg_file is None:
            raise RuntimeError(f"no config (.yaml) beside {ckpt}")
        cfg = yaml.load(cfg_file.read_text("utf-8"), Loader=yaml.UnsafeLoader)
        from melband import MelBandRoformer

        self.chunk = int(cfg["audio"]["chunk_size"])
        self.sr = int(cfg["audio"]["sample_rate"])
        self.overlap = int(cfg.get("inference", {}).get("num_overlap", 4))
        model = MelBandRoformer(**dict(cfg["model"]))
        state = torch.load(str(ckpt), map_location="cpu", weights_only=True)
        if isinstance(state, dict) and "state_dict" in state:
            state = state["state_dict"]
        model.load_state_dict(state)
        self.model = model.to(device).eval()
        self.device = device
        self.gate: Callable[[], None] | None = None
        self._hooked = False

    def _hook(self) -> None:
        if self._hooked:
            return

        def before(_module: Any, _args: Any) -> None:
            if self.gate is not None:
                self.gate()

        self.model.register_forward_pre_hook(before)
        self._hooked = True

    def lead(self, x, sr: int, progress: Callable[[float], None] | None = None, overlap: int | None = None):
        """The lead voice of ``x`` ((frames, 2) float32 at the model's rate) as the same shape.

        Overlapping chunks cross-faded with a Hann window; the ends are padded by reflection so the
        first and last seconds get the same context as the middle."""
        import numpy as np
        import torch

        if sr != self.sr:
            raise ValueError(f"the model works at {self.sr} Hz, got {sr}")
        if x.shape[1] == 1:
            x = np.repeat(x, 2, axis=1)
        n = x.shape[0]
        chunk = self.chunk
        hop = max(1, chunk // max(1, overlap or self.overlap))
        pad = chunk - hop
        total = n + 2 * pad
        total = chunk if total < chunk else total + (-(total - chunk)) % hop
        right = total - n - pad
        padded = np.pad(x, ((pad, right), (0, 0)), mode="reflect" if n > max(pad, right) else "constant")
        wav = torch.from_numpy(np.ascontiguousarray(padded.T))
        window = torch.hann_window(chunk, periodic=True).clamp(min=1e-3)
        out = torch.zeros_like(wav)
        weight = torch.zeros(total)
        starts = list(range(0, total - chunk + 1, hop))
        self._hook()
        with torch.no_grad():
            for i, s in enumerate(starts):
                part = wav[:, s:s + chunk].to(self.device)[None]
                y = self.model(part)[0].float().cpu()
                out[:, s:s + chunk] += y * window
                weight[s:s + chunk] += window
                if progress is not None:
                    progress((i + 1) / len(starts))
        res = (out / weight.clamp(min=1e-6))[:, pad:pad + n]
        return res.numpy().T.copy()
