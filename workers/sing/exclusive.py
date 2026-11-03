"""The GPU to the song worker alone while it separates and converts.

On a 12 GB card the conversion next to the TTS (~4.7 GB) and ASR (~2 GB) workers spills into
shared memory and runs 10x slower or more. With ``SING_OFFLOAD_URLS`` set, the job asks those
workers to drop their models (``POST /offload``) before the first GPU stage and to load them
again (``POST /reload``) right after the conversion, also when it fails or is cancelled. The
reload runs while the song is mixed; the job only counts as done once they are back, so her
opening line has a voice.

A job submitted with ``exclusive_ack`` first waits (``exclusive: "waiting"``) until Core says go
(``POST /jobs/{id}/exclusive``, after she told everyone she is off to prepare the song) or
SING_EXCLUSIVE_WAIT_S passed.

    state:  None → waiting → offloading → active → reloading → done
"""

from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable

log = logging.getLogger("miyoria.sing.exclusive")

Poster = Callable[[str, dict[str, Any], float], dict[str, Any]]


def http_post(url: str, body: dict[str, Any], timeout: float) -> dict[str, Any]:
    import httpx

    r = httpx.post(url, json=body, timeout=timeout)
    r.raise_for_status()
    out = r.json()
    return out if isinstance(out, dict) else {}


def parse_urls(raw: str | None) -> list[str]:
    return [u.strip().rstrip("/") for u in (raw or "").split(",") if u.strip()]


class Exclusive:
    def __init__(self, urls: list[str], post: Poster = http_post, *, ack_wait_s: float = 20.0,
                 offload_timeout_s: float = 60.0, reload_timeout_s: float = 300.0, max_s: float = 900.0) -> None:
        self.urls = urls
        self.post = post
        self.ack_wait_s = ack_wait_s
        self.offload_timeout_s = offload_timeout_s
        self.reload_timeout_s = reload_timeout_s
        self.max_s = max_s
        self.state: str | None = None
        self.offloaded: list[str] = []
        self.asked: list[str] = []  # offload requested, whether or not it answered in time
        self.timings: dict[str, float] = {}
        self.errors: list[str] = []
        self._lock = threading.Lock()
        self._reload: threading.Thread | None = None

    def begin(self, cancelled: Callable[[], bool], ack: threading.Event | None) -> None:
        """Waits for Core's go (when ``ack`` is given), then offloads every worker. Raises
        nothing but what ``cancelled`` makes it: a worker that cannot offload is skipped."""
        from engine import Cancelled

        if self.state is not None:
            return
        if ack is not None:
            self.state = "waiting"
            t0 = time.monotonic()
            while not ack.is_set() and time.monotonic() - t0 < self.ack_wait_s:
                if cancelled():
                    raise Cancelled()
                ack.wait(0.1)
            self.timings["exclusive_wait_s"] = round(time.monotonic() - t0, 2)
        if cancelled():
            raise Cancelled()
        self.state = "offloading"
        t0 = time.monotonic()
        for url in self.urls:
            self.asked.append(url)
            try:
                r = self.post(f"{url}/offload", {"reason": "sing", "max_s": self.max_s}, self.offload_timeout_s)
                self.offloaded.append(url)
                log.info("offloaded %s (%s ms, VRAM %s -> %s MB)", url, r.get("offload_ms"), r.get("vram_before_mb"),
                         r.get("vram_after_mb"))
            except Exception as e:  # noqa: BLE001
                self.errors.append(f"offload {url}: {e}"[:200])
                log.warning("could not offload %s: %s", url, e)
        self.timings["offload_s"] = round(time.monotonic() - t0, 2)
        self.state = "active"

    def end(self) -> None:
        """Starts loading the offloaded workers again (idempotent)."""
        with self._lock:
            if self._reload is not None or self.state in (None, "done"):
                return
            self.state = "reloading"
            self._reload = threading.Thread(target=self._reload_all, name="sing-reload", daemon=True)
            self._reload.start()

    def _reload_all(self) -> None:
        t0 = time.monotonic()
        # Every worker asked, also those whose offload timed out: it may have finished after we
        # stopped waiting (a reload of a loaded worker answers "already" at once).
        for url in self.asked:
            try:
                r = self.post(f"{url}/reload", {}, self.reload_timeout_s)
                log.info("reloaded %s (%s ms)", url, r.get("reload_ms"))
            except Exception as e:  # noqa: BLE001
                # It reloads by itself after max_s; nothing better to do from here.
                self.errors.append(f"reload {url}: {e}"[:200])
                log.warning("could not reload %s: %s", url, e)
        self.timings["reload_s"] = round(time.monotonic() - t0, 2)
        self.state = "done"

    def join(self, timeout: float | None = None) -> None:
        t = self._reload
        if t is not None:
            t.join(self.reload_timeout_s if timeout is None else timeout)

    def public(self) -> dict[str, Any]:
        return {"state": self.state, "offloaded": list(self.offloaded), "errors": list(self.errors),
                **self.timings}
