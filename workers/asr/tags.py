"""Pure-Python helpers for the ASR worker (no numpy / torch, so they are unit-testable anywhere).

* SenseVoice (sherpa-onnx) gives language / emotion / event as ``<|...|>`` tags, either in
  separate result fields or inline in the text. ``parse_sensevoice`` turns them into the
  contract fields (``emotion``, ``audio_events``).
* Language names are normalised between ISO-ish codes (the HTTP contract) and the English
  names Qwen3-ASR uses.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

_TAG = re.compile(r"<\|([^|<>]*)\|>")

SV_LANGS = {"zh", "en", "yue", "ja", "ko"}
SV_EMOTIONS = {"neutral", "happy", "sad", "angry", "fearful", "disgusted", "surprised"}
# "Speech" is the default "event" for plain speech; EVENT_UNK carries no information.
SV_NOISE_TAGS = {"speech", "event_unk", "emo_unknown", "nospeech", "withitn", "woitn"}
SV_EVENTS = {"bgm", "applause", "laughter", "cry", "sneeze", "breath", "cough", "sing"}


@dataclass
class SenseVoiceParsed:
    text: str
    language: str | None = None
    emotion: str | None = None
    audio_events: list[str] = field(default_factory=list)


def parse_sensevoice(text: str, lang: str = "", emotion: str = "", event: str = "") -> SenseVoiceParsed:
    """Combine the tag-bearing result fields and the text into contract fields.

    ``lang`` / ``emotion`` / ``event`` are the (possibly empty) fields of sherpa-onnx's
    ``OfflineRecognizerResult``; they look like ``"<|zh|>"``, ``"<|HAPPY|>"``, ``"<|Laughter|>"``.
    Tags that are still inline in ``text`` are honoured too and stripped from it.
    """
    tags = [t.strip().lower() for t in _TAG.findall(f"{lang}{emotion}{event}{text}")]
    clean = _TAG.sub("", text).strip()

    parsed = SenseVoiceParsed(text=clean)
    for t in tags:
        if t in SV_LANGS and parsed.language is None:
            parsed.language = t
        elif t in SV_EMOTIONS and parsed.emotion is None:
            parsed.emotion = t
        elif t in SV_EVENTS and t not in parsed.audio_events:
            parsed.audio_events.append(t)
        # anything else (speech, event_unk, emo_unknown, ...) carries no information
    return parsed


# ── language names ───────────────────────────────────────────────────────────

_CODE_TO_NAME = {
    "zh": "Chinese",
    "en": "English",
    "ja": "Japanese",
    "ko": "Korean",
    "yue": "Cantonese",
    "de": "German",
    "fr": "French",
    "es": "Spanish",
    "it": "Italian",
    "pt": "Portuguese",
    "ru": "Russian",
    "ar": "Arabic",
}
_NAME_TO_CODE = {v.lower(): k for k, v in _CODE_TO_NAME.items()}


def to_language_name(value: str | None) -> str | None:
    """Request ``language`` ("zh", "zh-TW", "Chinese", "auto", ...) -> Qwen name, or None for auto."""
    if not value:
        return None
    v = value.strip()
    if not v or v.lower() in {"auto", "und"}:
        return None
    base = v.lower().replace("_", "-").split("-")[0]
    if base in _CODE_TO_NAME:
        return _CODE_TO_NAME[base]
    if v.lower() in _NAME_TO_CODE:
        return v.title()
    return None  # unknown -> let the model auto-detect rather than fail


def to_language_code(value: str | None) -> str | None:
    """Model-reported language ("Chinese", "zh", "Japanese") -> short code for the response."""
    if not value:
        return None
    v = value.strip().lower()
    if not v:
        return None
    return _NAME_TO_CODE.get(v, v)
