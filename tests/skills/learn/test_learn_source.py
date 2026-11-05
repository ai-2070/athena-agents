"""learn_source.py: books, saved pages and subtitles to text an agent reads a piece at a time, and a screen recording's
telling frames."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import zipfile
from pathlib import Path

import pytest

SKILL, SCRIPT = "learn", "learn_source.py"

CONTAINER = """<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>"""

OPF = """<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Łódź Field Notes</dc:title><dc:creator>Ana Ruiz</dc:creator></metadata>
  <manifest>
    <item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
  </manifest>
  <spine><itemref idref="cover"/><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>"""

PAGE = """<html><head><title>T</title><style>p {{ color: red }}</style></head><body>
<h1>{title}</h1><p>{text}</p><ul><li>first point</li><li>second point</li></ul>
<pre>run --this
  exactly</pre><script>ignored()</script></body></html>"""


def make_epub(path: Path, *, drm: bool = False) -> Path:
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("mimetype", "application/epub+zip")
        z.writestr("META-INF/container.xml", CONTAINER)
        z.writestr("OEBPS/content.opf", OPF)
        z.writestr("OEBPS/cover.xhtml", "<html><body><img src='cover.jpg'/></body></html>")
        z.writestr("OEBPS/text/ch1.xhtml", PAGE.format(title="Replication", text="Leaders and followers keep copies."))
        z.writestr("OEBPS/text/ch2.xhtml", PAGE.format(title="Partitioning", text="Split the data by key​ range."))
        if drm:
            z.writestr("META-INF/encryption.xml", '<encryption><EncryptedData><CipherReference URI="OEBPS/text/ch1.xhtml"/></EncryptedData></encryption>')
    return path


def test_epub_writes_chapters_in_reading_order_with_an_index(run, tmp_path):
    book = make_epub(tmp_path / "book.epub")
    r = run(SKILL, SCRIPT, "epub", book, "-o", tmp_path / "out", ok=False)
    # the cover has no text: done, with a warning to look at
    assert r.code == 1
    body = r.json()
    assert body["chapters"] == 2 and body["title"] == "Łódź Field Notes" and body["author"] == "Ana Ruiz"
    assert body["hidden_characters_removed"] == 1
    assert any("cover" in w for w in body["warnings"])
    index = json.loads((tmp_path / "out" / "index.json").read_text(encoding="utf-8"))
    assert [c["heading"] for c in index["chapters"]] == ["Replication", "Partitioning"]  # the spine's order, not the manifest's
    first = (tmp_path / "out" / index["chapters"][0]["file"]).read_text(encoding="utf-8")
    assert first.startswith("# Replication")
    assert "- first point" in first and "```\nrun --this\n  exactly\n```" in first
    assert "ignored()" not in first and "color: red" not in first
    second = (tmp_path / "out" / index["chapters"][1]["file"]).read_text(encoding="utf-8")
    assert "key range" in second and "​" not in second


def test_epub_with_drm_is_reported_not_read(run, tmp_path):
    r = run(SKILL, SCRIPT, "epub", make_epub(tmp_path / "locked.epub", drm=True), "-o", tmp_path / "out", ok=False)
    assert r.code == 1 and r.json()["ok"] is False and "DRM" in r.json()["warnings"][0]
    assert not (tmp_path / "out").exists()


def test_a_file_that_isnt_an_epub_is_one_line(run, tmp_path):
    (tmp_path / "x.epub").write_text("not a zip")
    r = run(SKILL, SCRIPT, "epub", tmp_path / "x.epub", "-o", tmp_path / "out", ok=False)
    assert r.code == 2 and r.out == "" and len(r.err.strip().splitlines()) == 1 and "Traceback" not in r.err


def test_html_page_to_text_takes_powershell_encodings(run, tmp_path):
    page = tmp_path / "page.html"
    # what PowerShell 5.1's > writes: UTF-16 with a byte-order mark
    page.write_bytes(PAGE.format(title="Kraków ‮guide", text="Café menu").encode("utf-16"))
    r = run(SKILL, SCRIPT, "html", page, "-o", tmp_path / "page.md")
    body = r.json()
    assert body["encoding"] == "utf-16" and body["hidden_characters_removed"] == 1
    text = (tmp_path / "page.md").read_text(encoding="utf-8")
    assert "# Kraków guide" in text and "Café menu" in text


SRT = """1
00:00:01,000 --> 00:00:03,000
Welcome to the talk

2
00:00:03,000 --> 00:00:05,000
Welcome to the talk
about replication

3
00:01:10,500 --> 00:01:12,000
<i>Leaders</i> take the writes &amp; followers copy them
"""


def test_subtitles_become_timestamped_paragraphs_without_rolling_repeats(run, tmp_path):
    (tmp_path / "talk.srt").write_text(SRT, encoding="utf-8")
    r = run(SKILL, SCRIPT, "subs", tmp_path / "talk.srt", "-o", tmp_path / "talk.md")
    assert r.json()["paragraphs"] == 2
    text = (tmp_path / "talk.md").read_text(encoding="utf-8")
    assert text.count("Welcome to the talk") == 1 and "about replication" in text
    assert "[00:01:10] Leaders take the writes & followers copy them" in text


def test_webvtt_and_a_bad_interval(run, tmp_path):
    (tmp_path / "talk.vtt").write_text("WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nHello\n\n01:02:03.000 --> 01:02:05.000\nLater\n", encoding="utf-8")
    r = run(SKILL, SCRIPT, "subs", tmp_path / "talk.vtt", "-o", tmp_path / "t.md")
    assert "[01:02:03] Later" in (tmp_path / "t.md").read_text(encoding="utf-8")
    bad = run(SKILL, SCRIPT, "subs", tmp_path / "talk.vtt", "-o", tmp_path / "t.md", "--every", "0", ok=False)
    assert bad.code == 2 and "10 seconds" in bad.err and "Traceback" not in bad.err


def test_never_writes_over_its_input(run, tmp_path):
    notes = tmp_path / "notes.txt"
    notes.write_text("keep me", encoding="utf-8")
    r = run(SKILL, SCRIPT, "clean", notes, "-o", notes, ok=False)
    assert r.code == 2 and "is the input" in r.err
    assert notes.read_text(encoding="utf-8") == "keep me"


def test_clean_removes_hidden_characters_from_ansi_text(run, tmp_path):
    (tmp_path / "notes.txt").write_bytes("Ignore⁦ this⁩ note — fine".encode("utf-8"))
    r = run(SKILL, SCRIPT, "clean", tmp_path / "notes.txt", "-o", tmp_path / "clean.md")
    assert r.json()["hidden_characters_removed"] == 2
    assert (tmp_path / "clean.md").read_text(encoding="utf-8") == "Ignore this note — fine\n"


# ---------- screen recordings (probe, frames) ----------
FPS, W, H = 15, 640, 400
BAR = (46, 108)  # where the "typing" starts on the form screen; each step adds 20 px, 20 steps in all


def needs_ffmpeg() -> None:
    if shutil.which("ffmpeg") and shutil.which("ffprobe"):
        return
    if os.environ.get("CI"):
        pytest.fail("FFmpeg is needed on CI for the learn skill's probe and frames")
    pytest.skip("FFmpeg isn't installed")


def screen(kind: str, typed: int = 0) -> bytes:
    """A made-up screen: a list page, a form being typed into, a result page."""
    from PIL import Image, ImageDraw

    im = Image.new("RGB", (W, H), {"list": (245, 245, 245), "form": (230, 240, 255), "done": (255, 240, 230)}[kind])
    d = ImageDraw.Draw(im)
    d.rectangle([0, 0, W, 40], fill=(40, 40, 60))
    if kind == "list":
        for i in range(6):
            d.rectangle([40, 70 + i * 40, 400, 90 + i * 40], fill=(180, 180, 190))
    if kind == "form":
        d.rectangle([40, 100, 600, 140], outline=(0, 0, 0), width=2)
        if typed:
            d.rectangle([BAR[0], BAR[1], BAR[0] + typed * 20, 132], fill=(20, 20, 20))
    if kind == "done":
        d.ellipse([220, 120, 420, 320], fill=(60, 160, 90))
    return im.tobytes()


def record(path: Path, *encode: str) -> Path:
    """8 s at 15 frames a second: the list (0-2 s), the form typed into in small steps (2-6 s), the result (6-8 s)."""
    frames = [screen("list")] * (FPS * 2) + [screen("form", min(20, k // 2)) for k in range(FPS * 4)] + [screen("done")] * (FPS * 2)
    cmd = ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-"]
    cmd += list(encode or ("-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "75", str(path)))
    with open(path, "wb") if encode else open(os.devnull, "wb") as sink:
        subprocess.run(cmd, input=b"".join(frames), stdout=sink, check=True)
    return path


@pytest.fixture(scope="module")
def recording(tmp_path_factory) -> Path:
    needs_ffmpeg()
    return record(tmp_path_factory.mktemp("rec") / "demo.mp4")


def test_probe_reports_a_silent_recording_and_saves_two_frames_to_check_it_by(run, tmp_path, recording):
    r = run(SKILL, SCRIPT, "probe", recording, "-o", tmp_path / "probe")
    body = r.json()
    assert body["seconds"] == pytest.approx(8, abs=0.1) and body["length_from"] == "file"
    assert body["sound"] is False and body["subtitles"] == 0 and body["frame_rate"] == 15
    assert (body["width"], body["height"]) == (W, H)
    assert [c["file"] for c in body["check_frames"]] == ["check-20.png", "check-70.png"]
    from PIL import Image

    with Image.open(tmp_path / "probe" / "check-20.png") as im:
        assert im.size == (W, H)  # never wider than the video


def test_frames_keeps_the_last_frame_before_each_change(run, tmp_path, recording):
    r = run(SKILL, SCRIPT, "frames", recording, "-o", tmp_path / "frames")
    body = r.json()
    assert body["changes"] == 2 and body["dropped"] == 0 and body["warnings"] == []
    kept = body["frames"]
    assert [f["why"] for f in kept] == ["first", "before the screen changed at 00:02.0", "before the screen changed at 00:06.0", "last"]
    for f, truth in zip(kept, [0, 2 - 1 / FPS, 6 - 1 / FPS, 8 - 1 / FPS]):
        assert f["at"] == pytest.approx(truth, abs=1 / FPS + 0.001)
    from PIL import Image

    # the form's last frame shows all the typing (20 steps), not part of it
    with Image.open(tmp_path / "frames" / kept[2]["file"]) as im:
        assert max(im.convert("RGB").getpixel((BAR[0] + 20 * 20 - 6, 120))) < 80
    listing = json.loads((tmp_path / "frames" / "frames.json").read_text(encoding="utf-8"))
    assert [f["file"] for f in listing["frames"]] == [f["file"] for f in kept] == sorted(p.name for p in (tmp_path / "frames").glob("f*.png"))


def test_frames_thins_to_its_cap_and_tiles_sheets(run, tmp_path, recording):
    r = run(SKILL, SCRIPT, "frames", recording, "-o", tmp_path / "f", "--max", "3", "--every", "2", "--sheet", "2x1", ok=False)
    assert r.code == 1
    body = r.json()
    whys = [f["why"] for f in body["frames"]]
    assert len(whys) == 3 and whys[0] == "first" and whys[-1] == "last" and whys[1].startswith("before the screen changed")
    assert body["dropped"] >= 2 and any("--max 3" in w for w in body["warnings"])
    names = [f["file"] for f in body["frames"]]
    assert [s["frames"] for s in body["sheets"]] == [names[:2], names[2:]]
    assert all((tmp_path / "f" / s["file"]).is_file() for s in body["sheets"])


def test_frames_at_saves_full_size_moments_and_a_rerun_replaces_its_own_frames(run, tmp_path, recording):
    out = tmp_path / "f"
    filled = run(SKILL, SCRIPT, "frames", recording, "-o", out, "--every", "2").json()["frames"]
    # the form's 4 s get a frame in the middle, so no 2 s go without one
    assert [f["why"] for f in filled].count("at least one every 2 s") == 1
    assert all(b["at"] - a["at"] <= 2 + 1 / FPS for a, b in zip(filled, filled[1:]))
    first = {p.name for p in out.glob("f*.png")}
    at = run(SKILL, SCRIPT, "frames", recording, "-o", out, "--at", "3.5,0:05.9,1:00", ok=False)
    assert at.code == 1 and [f["file"] for f in at.json()["frames"]] == ["at-00m03.5s.png", "at-00m05.9s.png"]
    assert "past the end" in at.json()["warnings"][0]
    again = run(SKILL, SCRIPT, "frames", recording, "-o", out)
    now = {p.name for p in out.glob("f*.png")}
    assert now == {f["file"] for f in again.json()["frames"]} and now != first  # the earlier run's frames went
    assert (out / "at-00m03.5s.png").is_file()  # what it didn't make stays


def test_a_webm_with_no_length_in_it_is_measured_from_its_frames(run, tmp_path):
    needs_ffmpeg()
    # what a browser's recorder leaves: WebM written as a stream, so no length is stored
    webm = record(tmp_path / "rec.webm", "-c:v", "libvpx", "-b:v", "1M", "-f", "webm", "pipe:1")
    r = run(SKILL, SCRIPT, "probe", webm, "-o", tmp_path / "p", ok=False)
    assert r.code == 1 and r.json()["length_from"] == "frames" and r.json()["seconds"] == pytest.approx(8, abs=0.1)
    f = run(SKILL, SCRIPT, "frames", webm, "-o", tmp_path / "f", ok=False)
    assert f.code == 1 and [x["why"] for x in f.json()["frames"]][-1] == "last" and f.json()["changes"] == 2


def test_videos_that_cant_be_read_are_one_line(run, tmp_path, recording):
    (tmp_path / "notes.txt").write_text("not a video", encoding="utf-8")
    for args in (("probe", tmp_path / "notes.txt", "-o", tmp_path / "p"), ("frames", recording, "-o", tmp_path, "--max", "1")):
        r = run(SKILL, SCRIPT, *args, ok=False)
        assert r.code == 2 and r.out == "" and len(r.err.strip().splitlines()) == 1 and "Traceback" not in r.err
    # a folder with other things in it
    busy = tmp_path / "busy"
    busy.mkdir()
    (busy / "keep.txt").write_text("mine", encoding="utf-8")
    r = run(SKILL, SCRIPT, "frames", recording, "-o", busy, ok=False)
    assert r.code == 2 and "isn't empty" in r.err and (busy / "keep.txt").is_file()
    # no FFmpeg on PATH
    empty = tmp_path / "nothing"
    empty.mkdir()
    r = run(SKILL, SCRIPT, "probe", recording, "-o", tmp_path / "p", ok=False, env={"PATH": str(empty)})
    assert r.code == 2 and "FFmpeg" in r.err and "Traceback" not in r.err
