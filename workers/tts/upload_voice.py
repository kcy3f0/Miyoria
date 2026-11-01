"""Upload a reference voice to a vLLM-Omni Qwen3-TTS (Base) server.

After picking a clip with design_voice.py (VOICES_DIR/<id>/ref.wav + ref.txt),
register it so Miyoria can use it as `voice = "<id>"`:

    python upload_voice.py --url http://127.0.0.1:8091 --voices-dir voices --name deepseek-chan

Re-uploading the same name overwrites it (server default policy).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import httpx


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="http://127.0.0.1:8091", help="vLLM-Omni server root (without /v1)")
    ap.add_argument("--voices-dir", default="voices", type=Path)
    ap.add_argument("--name", required=True, help="voice name, e.g. the profile id")
    ap.add_argument("--description", default="", help="optional speaker description (metadata only)")
    ap.add_argument(
        "--consent",
        default="owner-designed-voice",
        help="consent record id required by the API; the voice was designed, not cloned from a person",
    )
    args = ap.parse_args()

    voice_dir = args.voices_dir / args.name
    wav = voice_dir / "ref.wav"
    txt = voice_dir / "ref.txt"
    if not wav.is_file():
        print(f"missing {wav} (pick a candidate with design_voice.py first)", file=sys.stderr)
        return 1
    ref_text = txt.read_text(encoding="utf-8").strip() if txt.is_file() else ""

    data = {"name": args.name, "consent": args.consent}
    if ref_text:
        # With a transcript the server does in-context cloning (higher quality).
        data["ref_text"] = ref_text
    if args.description:
        data["speaker_description"] = args.description

    with wav.open("rb") as f:
        resp = httpx.post(
            f"{args.url.rstrip('/')}/v1/audio/voices",
            data=data,
            files={"audio_sample": (wav.name, f, "audio/wav")},
            timeout=120,
        )
    if resp.status_code >= 400:
        print(f"upload failed: {resp.status_code} {resp.text}", file=sys.stderr)
        return 1
    print(resp.json())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
