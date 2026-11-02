"""Song worker (workers/sing/server.py) contract, in mock mode: no GPU, no network.

To check the real worker against the same contract (slow: it converts a song):
    WORKER_SING_URL=http://127.0.0.1:8005 WORKER_SING_QUERY="..." pytest tests/test_sing.py
"""

from __future__ import annotations

import importlib.util
import os
import sys
import time
from pathlib import Path

import pytest

SING = Path(__file__).resolve().parent.parent / "sing"
sys.path.insert(0, str(SING))


@pytest.fixture(scope="module")
def sing(tmp_path_factory):
    live = os.environ.get("WORKER_SING_URL")
    if live:
        import httpx

        with httpx.Client(base_url=live, timeout=60) as c:
            yield c
        return
    root = tmp_path_factory.mktemp("songs")
    lib = root / "library"
    (lib / "Owner - Split Song").mkdir(parents=True)
    for name in ("vocals.wav", "instrumental.wav"):
        (lib / "Owner - Split Song" / name).write_bytes(b"")
    (lib / "Owner - Split Song" / "video.mkv").write_bytes(b"video")
    (lib / "Someone - Local Tune.mp3").write_bytes(b"")
    os.environ.update({"SING_BACKEND": "mock", "SING_DATA_DIR": str(root), "SING_MOCK_SECONDS": "2"})
    # By path: the TTS and ASR workers have a `server` module too.
    spec = importlib.util.spec_from_file_location("sing_server", SING / "server.py")
    assert spec and spec.loader
    server = importlib.util.module_from_spec(spec)
    sys.modules["sing_server"] = server
    spec.loader.exec_module(server)
    from fastapi.testclient import TestClient

    with TestClient(server.app) as c:
        yield c


def wait(client, job_id: str, timeout: float = 600) -> dict:
    t0 = time.time()
    while time.time() - t0 < timeout:
        job = client.get(f"/jobs/{job_id}").json()["job"]
        if job["state"] in ("done", "failed", "cancelled"):
            return job
        time.sleep(0.05)
    raise AssertionError("job did not finish")


def is_mock() -> bool:
    return "WORKER_SING_URL" not in os.environ


def test_health(sing):
    body = sing.get("/health").json()
    assert body["status"] == "ok"
    assert isinstance(body["model"], str) and body["model"]
    assert isinstance(body["busy"], bool)
    assert isinstance(body["queued"], int)


def test_request_needs_exactly_one_source(sing):
    assert sing.post("/jobs", json={}).status_code == 400
    r = sing.post("/jobs", json={"query": "a", "url": "https://youtu.be/x"})
    assert r.status_code == 400
    assert "exactly one" in r.json()["error"]


def test_links_must_be_on_allowed_hosts(sing):
    r = sing.post("/jobs", json={"url": "http://127.0.0.1:8002/tts"})
    assert r.status_code == 400
    assert "allowed host" in r.json()["error"]
    r = sing.post("/jobs", json={"url": "file:///etc/passwd"})
    assert r.status_code == 400


def test_pitch_is_bounded(sing):
    assert sing.post("/jobs", json={"query": "x", "pitch": 40}).status_code == 400
    assert sing.post("/jobs", json={"query": "x", "key": -13}).status_code == 400


def test_job_runs_to_a_cached_song(sing):
    query = os.environ.get("WORKER_SING_QUERY", "twinkle twinkle little star")
    r = sing.post("/jobs", json={"query": query})
    assert r.status_code == 200
    job = r.json()["job"]
    assert job["state"] in ("queued", "running", "done")
    assert job["id"]
    done = wait(sing, job["id"])
    assert done["state"] == "done", done
    song = done["song"]
    assert song["id"] == done["song_id"]
    assert song["play"]["sample_rate"] == 48_000
    assert song["play"]["samples"] > 0
    assert set(song["timings"]) >= {"convert_s", "mix_s", "total_s"}
    assert isinstance(song["pitch"]["vocal_shift"], int)
    if is_mock():
        assert song["title"] == query
        assert song["lyrics"]["synced"] is True
        assert song["lyrics"]["lines"][0] == {"t": 0.0, "text": "mock line 1"}

    pcm = sing.get(f"/songs/{song['id']}/files/play_mix.pcm")
    assert pcm.status_code == 200
    assert pcm.headers["x-sample-rate"] == "48000"
    assert len(pcm.content) == song["play"]["samples"] * 2
    vocals = sing.get(f"/songs/{song['id']}/files/play_vocals.pcm")
    assert vocals.status_code == 200 and len(vocals.content) > 0

    # Asking again is answered from the cache at once.
    again = sing.post("/jobs", json={"query": query}).json()["job"]
    assert again["state"] == "done" and again["cached"] is True
    assert again["song_id"] == song["id"]
    assert any(s["id"] == song["id"] for s in sing.get("/songs").json()["songs"])
    assert sing.get(f"/songs/{song['id']}").json()["song"]["id"] == song["id"]


def test_key_change_is_a_separate_song(sing):
    if not is_mock():
        pytest.skip("converts a whole song again")
    a = wait(sing, sing.post("/jobs", json={"query": "keyed"}).json()["job"]["id"])
    b = wait(sing, sing.post("/jobs", json={"query": "keyed", "key": 2}).json()["job"]["id"])
    assert a["song_id"] != b["song_id"]
    assert b["song"]["pitch"]["key"] == 2
    assert b["song"]["pitch"]["vocal_shift"] == a["song"]["pitch"]["vocal_shift"] + 2


def test_failures_are_reported(sing):
    if not is_mock():
        pytest.skip("mock search failure")
    job = wait(sing, sing.post("/jobs", json={"query": "fail"}).json()["job"]["id"])
    assert job["state"] == "failed"
    assert "no search result" in job["error"]


def test_library(sing):
    if not is_mock():
        pytest.skip("depends on the local library")
    entries = sing.get("/library").json()["entries"]
    by_path = {e["path"]: e for e in entries}
    assert by_path["Owner - Split Song"]["split"] is True
    assert by_path["Someone - Local Tune.mp3"] == {
        "path": "Someone - Local Tune.mp3", "title": "Local Tune", "artist": "Someone", "split": False,
    }
    assert sing.post("/jobs", json={"path": "../secret.wav"}).status_code == 200  # fails in the job
    bad = wait(sing, sing.get("/jobs").json()["jobs"][0]["id"])
    assert bad["state"] == "failed" and "outside" in bad["error"]
    # A query that matches a library entry uses it instead of searching.
    job = wait(sing, sing.post("/jobs", json={"query": "local tune"}).json()["job"]["id"])
    assert job["state"] == "done" and job["source"]["kind"] == "library"


def test_the_video_comes_with_the_song(sing):
    if not is_mock():
        pytest.skip("mock video")
    done = wait(sing, sing.post("/jobs", json={"query": "with a video"}).json()["job"]["id"])
    assert done["state"] == "done", done
    song = done["song"]
    assert song["has_video"] is True and song["video_error"] is None
    assert song["video"]["file"] == "video.mp4"
    assert song["video"]["height"] == 1080 and song["video"]["source"] == "mock"
    assert "video_s" in song["timings"]
    assert done["video"]["state"] == "done"
    r = sing.get(f"/songs/{song['id']}/files/video.mp4")
    assert r.status_code == 200
    assert r.headers["content-type"] == "video/mp4"
    assert r.content.startswith(b"\x00\x00\x00\x18ftyp")
    # A key change of the same source reuses the downloaded video.
    keyed = wait(sing, sing.post("/jobs", json={"query": "with a video", "key": 1}).json()["job"]["id"])
    assert keyed["song"]["has_video"] is True and keyed["video"] is None


def test_a_song_without_a_video_is_still_ready(sing):
    if not is_mock():
        pytest.skip("mock video")
    done = wait(sing, sing.post("/jobs", json={"query": "novideo tune"}).json()["job"]["id"])
    assert done["state"] == "done", done
    song = done["song"]
    assert song["has_video"] is False and song["video"] is None
    assert "no video" in song["video_error"]
    assert done["video"]["state"] == "failed"
    assert sing.get(f"/songs/{song['id']}/files/video.mp4").status_code == 404


def test_videos_can_be_turned_off(sing, monkeypatch):
    if not is_mock():
        pytest.skip("mock video")
    monkeypatch.setenv("SING_VIDEO", "0")
    done = wait(sing, sing.post("/jobs", json={"query": "videos off"}).json()["job"]["id"])
    assert done["song"]["has_video"] is False and "SING_VIDEO" in done["song"]["video_error"]
    assert done["video"] is None


def test_a_song_cached_before_videos_gets_its_video(sing, tmp_path):
    if not is_mock():
        pytest.skip("edits the cache")
    import json

    first = wait(sing, sing.post("/jobs", json={"query": "old song"}).json()["job"]["id"])
    sid = first["song_id"]
    root = Path(os.environ["SING_DATA_DIR"])
    # As the worker wrote it before videos existed.
    meta_path = root / sid / "meta.json"
    meta = json.loads(meta_path.read_text("utf-8"))
    for k in ("has_video", "video", "video_error"):
        meta.pop(k)
    meta_path.write_text(json.dumps(meta), "utf-8")
    for p in [root / sid / "video.mp4", *(root / "_sources").glob("*/video.*")]:
        p.unlink(missing_ok=True)

    again = sing.post("/jobs", json={"query": "old song"}).json()["job"]
    assert again["state"] in ("queued", "running")  # not answered from the cache at once
    done = wait(sing, again["id"])
    assert done["state"] == "done" and done["cached"] is True
    assert done["song"]["has_video"] is True
    assert (root / sid / "video.mp4").exists()
    # Now it is a plain cache hit.
    assert sing.post("/jobs", json={"query": "old song"}).json()["job"]["state"] == "done"


def test_library_videos(sing):
    if not is_mock():
        pytest.skip("depends on the local library")
    done = wait(sing, sing.post("/jobs", json={"path": "Owner - Split Song"}).json()["job"]["id"])
    assert done["state"] == "done", done
    assert done["song"]["has_video"] is True
    assert done["song"]["video"] == {"source": "library", "bytes": 5, "file": "video.mkv"}
    r = sing.get(f"/songs/{done['song_id']}/files/video.mkv")
    assert r.status_code == 200 and r.content == b"video"
    plain = wait(sing, sing.post("/jobs", json={"path": "Someone - Local Tune.mp3"}).json()["job"]["id"])
    assert plain["song"]["has_video"] is False
    assert plain["song"]["video_error"] == "no video next to the library entry"


def test_library_video_lookup(tmp_path):
    from songs import Store

    store = Store(tmp_path, tmp_path / "lib")
    lib = tmp_path / "lib"
    (lib / "Folder").mkdir(parents=True)
    (lib / "Folder" / "vocals.wav").write_bytes(b"")
    (lib / "Folder" / "instrumental.wav").write_bytes(b"")
    (lib / "Folder" / "video.webm").write_bytes(b"")
    (lib / "A - B.mp3").write_bytes(b"")
    (lib / "A - B.mp4").write_bytes(b"")
    (lib / "C - D.webm").write_bytes(b"")
    assert store.library_video("Folder") == lib / "Folder" / "video.webm"
    assert store.library_video("A - B.mp3") == lib / "A - B.mp4"
    assert store.library_video("C - D.webm") is None  # the audio itself is not its video
    assert store.library_video("../x.mp3") is None


def test_unknown_things_are_404(sing):
    assert sing.get("/jobs/nope").status_code == 404
    assert sing.get("/songs/nope").status_code == 404
    assert sing.get("/songs/nope/files/mix.wav").status_code == 404
    assert sing.get("/songs/x/files/secret.txt").status_code == 404


def test_cancel_a_queued_job(sing):
    if not is_mock():
        pytest.skip("mock timing")
    job = sing.post("/jobs", json={"query": "to cancel"}).json()["job"]
    r = sing.delete(f"/jobs/{job['id']}")
    assert r.status_code == 200
    end = wait(sing, job["id"])
    assert end["state"] in ("cancelled", "done")


# ── lyrics helpers ───────────────────────────────────────────────────────────


def test_parse_lrc():
    from lyrics import parse_lrc

    text = "[ar:x]\n[offset:+500]\n[00:01.50]one\n[00:03.00][00:10.25]two\n[00:05.123]\n"
    assert parse_lrc(text) == [
        {"t": 1.0, "text": "one"},
        {"t": 2.5, "text": "two"},
        {"t": 4.623, "text": ""},
        {"t": 9.75, "text": "two"},
    ]


@pytest.mark.parametrize(
    "raw,uploader,expected",
    [
        ("YOASOBI - 夜に駆ける (Official Music Video)", None, ("YOASOBI", "夜に駆ける")),
        ("【MV】Song Name", "Artist - Topic", ("Artist", "Song Name")),
        ("Some Song | Live at Home", None, (None, "Some Song")),
    ],
)
def test_guess_artist_title(raw, uploader, expected):
    from lyrics import guess_artist_title

    assert guess_artist_title(raw, uploader) == expected
