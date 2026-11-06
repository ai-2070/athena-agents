"""Tests for film.mjs (skills/athena/one-take-video): timing a voiceover, sheets of stills, and rendering an MP4.

They run the script with Node from a folder that isn't the skill's, on real sound made with FFmpeg and real pages
drawn by the browser on this computer (Chrome, Edge or Chromium). On CI a missing Node 22, FFmpeg or browser fails the
tests instead of skipping them.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest
from PIL import Image

ROOT = Path(__file__).resolve().parents[3]
SKILL = ROOT / "skills" / "athena" / "one-take-video"
FILM = SKILL / "scripts" / "film.mjs"
TEMPLATE = SKILL / "templates" / "world.html"


def _missing(what: str) -> None:
    if os.environ.get("CI"):
        pytest.fail(f"{what} is needed on CI for the one-take-video skill's tests")
    pytest.skip(f"{what} isn't installed")


def _listing(folder: Path) -> list[str]:
    return sorted(str(p.relative_to(folder)) for p in folder.rglob("*"))


class Result:
    def __init__(self, code: int, out: str, err: str):
        self.code, self.out, self.err = code, out, err

    def json(self):
        return json.loads(self.out)

    def one_line_error(self) -> bool:
        lines = self.err.strip().splitlines()
        return self.code == 2 and self.out == "" and len(lines) == 1 and lines[0].startswith("error: ") and "    at " not in self.err


@pytest.fixture(scope="session")
def node() -> str:
    exe = shutil.which("node")
    if not exe:
        _missing("Node.js")
    major = int(subprocess.run([exe, "--version"], capture_output=True, text=True, timeout=30).stdout.strip().lstrip("v").split(".")[0])
    if major < 22:
        _missing("Node.js 22 or newer")
    return exe


@pytest.fixture(scope="session")
def ffmpeg() -> None:
    if not (shutil.which("ffmpeg") and shutil.which("ffprobe")):
        _missing("FFmpeg")


@pytest.fixture
def film(node, tmp_path):
    """film(*args, ok=True) runs film.mjs from tmp_path and returns its Result."""

    def _run(*args: object, ok: bool = True, timeout: int = 300) -> Result:
        before = _listing(SKILL)
        proc = subprocess.run([node, str(FILM), *(str(a) for a in args)], cwd=tmp_path, capture_output=True, timeout=timeout)
        r = Result(proc.returncode, proc.stdout.decode("utf-8"), proc.stderr.decode("utf-8", errors="replace"))
        assert _listing(SKILL) == before, "film.mjs changed files in its own skill folder"
        if ok:
            assert r.code == 0, f"film.mjs {' '.join(map(str, args))} exited {r.code}:\n{r.err}\n{r.out}"
        return r

    return _run


@pytest.fixture(scope="session")
def browser(node, tmp_path_factory) -> None:
    """Skips (or fails on CI) when film.mjs finds no browser to draw with."""
    folder = tmp_path_factory.mktemp("browser")
    (folder / "page.html").write_text(PAGE, encoding="utf-8")
    proc = subprocess.run([node, str(FILM), "sheet", "page.html", "-o", "s.png", "--at", "0"], cwd=folder, capture_output=True, text=True, timeout=120)
    if "found no Chrome" in proc.stderr:
        _missing("Chrome, Edge or Chromium")


# A page in two colours: red before 1 s, blue after.
PAGE = """<!doctype html><canvas id="c" width="320" height="180"></canvas><script>
const c = document.getElementById('c'), x = c.getContext('2d');
window.film = { canvas: c, fps: 20, duration: 1.5, ready: Promise.resolve(),
  beats: [{ t: 0, label: 'red' }, { t: 1, label: 'blue' }],
  render(t) { x.fillStyle = t < 1 ? '#ff0000' : '#0000ff'; x.fillRect(0, 0, c.width, c.height); } };
</script>"""


def page(folder: Path, text: str = PAGE, name: str = "page.html") -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_text(text, encoding="utf-8")
    return folder / name


def tone(path: Path, *parts: tuple[str, float]) -> Path:
    """A sound file of tones and silences, e.g. ("tone", 1.0), ("quiet", 0.6)."""
    inputs, labels = [], []
    for i, (kind, secs) in enumerate(parts):
        src = f"sine=f={330 + 110 * i}:d={secs}" if kind == "tone" else f"anullsrc=r=44100:cl=mono:d={secs}"
        inputs += ["-f", "lavfi", "-i", src]
        labels.append(f"[{i}]")
    subprocess.run(["ffmpeg", "-v", "error", "-y", *inputs, "-filter_complex", f"{''.join(labels)}concat=n={len(parts)}:v=0:a=1", "-ar", "44100", str(path)], check=True, timeout=60)
    return path


def probe(path: Path) -> dict:
    out = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-show_entries", "stream=codec_type,width,height,r_frame_rate,nb_read_frames:format=duration", "-of", "json", str(path)], capture_output=True, text=True, timeout=60, check=True).stdout
    return json.loads(out)


def frame(video: Path, at: float, dest: Path) -> Image.Image:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(at), "-i", str(video), "-frames:v", "1", str(dest)], check=True, timeout=60)
    return Image.open(dest).convert("RGB")


def tile_colour(sheet: Image.Image, i: int, tile: int, tile_h: int) -> tuple[int, int, int]:
    gap = max(6, round(tile * 0.02))
    return sheet.getpixel((gap + i * (tile + gap) + tile // 2, gap + tile_h // 2))


# ---------- help ----------


def test_help_names_every_option_and_the_skill_describes_each(film):
    r = film("--help")
    for cmd in ("voice", "sheet", "render"):
        assert f"node film.mjs {cmd}" in r.out
    options = set(re.findall(r"--[a-z][a-z-]+", r.out)) - {"--help"}
    assert {"--noise", "--min-pause", "--at", "--from", "--to", "--every", "--cols", "--tile", "--browser", "--audio", "--scale", "--crf", "--timeout"} <= options
    skill = (SKILL / "SKILL.md").read_text(encoding="utf-8")
    for opt in options:
        assert opt in skill, f"SKILL.md doesn't mention {opt}"


# ---------- voice ----------


def test_voice_finds_the_pauses_and_the_phrases_between_them(film, ffmpeg, tmp_path):
    wav = tone(tmp_path / "voice.wav", ("tone", 1.0), ("quiet", 0.6), ("tone", 1.2), ("quiet", 0.15), ("tone", 0.5))
    r = film("voice", wav).json()
    assert r["duration"] == pytest.approx(3.45, abs=0.01)
    # the 0.15 s gap is shorter than the shortest pause that counts
    assert len(r["pauses"]) == 1 and r["pauses"][0]["start"] == pytest.approx(1.0, abs=0.03) and r["pauses"][0]["end"] == pytest.approx(1.6, abs=0.03)
    assert [round(p["start"], 1) for p in r["phrases"]] == [0.0, 1.6]
    finer = film("voice", wav, "--min-pause", "0.1", "--noise=-40").json()
    assert len(finer["phrases"]) == 3 and finer["noise"] == -40 and finer["minPause"] == 0.1


def test_voice_refuses_what_it_cant_use_in_one_line(film, ffmpeg, tmp_path):
    (tmp_path / "notes.txt").write_text("not a sound", encoding="utf-8")
    assert film("voice", "notes.txt", ok=False).one_line_error()
    assert film("voice", "nothere.wav", ok=False).one_line_error()
    wav = tone(tmp_path / "v.wav", ("tone", 0.5))
    for bad in (["--min-pause", "0"], ["--min-pause", "-1"], ["--noise=5"], ["--noise=abc"]):
        r = film("voice", wav, *bad, ok=False)
        assert r.one_line_error(), bad
    # a negative value written without "=" says how to write it
    r = film("voice", wav, "--noise", "-40", ok=False)
    assert r.one_line_error() and "--noise=-40" in r.err


# ---------- sheet ----------


def test_sheet_draws_each_time_asked_for(film, browser, tmp_path):
    page(tmp_path)
    r = film("sheet", "page.html", "-o", "sheet.png", "--at", "0.5,1.25", "--cols", "2", "--tile", "200").json()
    assert r["stills"] == ["0.50 s", "1.25 s"] and r["warnings"] == []
    sheet = Image.open(tmp_path / "sheet.png").convert("RGB")
    assert tile_colour(sheet, 0, 200, 113) == (255, 0, 0)
    assert tile_colour(sheet, 1, 200, 113) == (0, 0, 255)


def test_sheet_without_times_takes_the_middle_of_each_beat_and_a_range_every_step(film, browser, tmp_path):
    page(tmp_path)
    assert film("sheet", "page.html", "-o", "beats.png").json()["stills"] == ["0.50 s  red", "1.25 s  blue"]
    assert len(film("sheet", "page.html", "-o", "move.png", "--from", "0", "--to", "1", "--every", "0.25").json()["stills"]) == 5
    # past the end, too many, or both ways at once
    for bad in (["--at", "2"], ["--from", "0", "--to", "1", "--every", "0.001"], ["--at", "1", "--every", "0.5"], ["--from", "1", "--to", "0.5", "--every", "0.1"], ["--tile", "50"], ["--cols", "0"]):
        assert film("sheet", "page.html", "-o", "x.png", *bad, ok=False).one_line_error(), bad


def test_the_template_draws_every_beat_without_a_warning_and_the_same_frame_twice_alike(film, browser, tmp_path):
    shutil.copy(TEMPLATE, tmp_path / "film.html")
    r = film("sheet", "film.html", "-o", "beats.png").json()
    assert r["page"] == {"width": 1920, "height": 1080, "duration": 12}
    assert len(r["stills"]) == 4 and r["warnings"] == []
    # a frame is a function of its time alone: drawn twice, it comes out the same
    film("sheet", "film.html", "-o", "twice.png", "--at", "2.3,2.3", "--cols", "2", "--tile", "320")
    sheet = Image.open(tmp_path / "twice.png").convert("RGB")
    gap, tile_h = 6, 180
    a = sheet.crop((gap, gap, gap + 320, gap + tile_h))
    b = sheet.crop((2 * gap + 320, gap, 2 * gap + 640, gap + tile_h))
    assert a.tobytes() == b.tobytes()


def test_a_photo_that_doesnt_load_is_a_warning(film, browser, tmp_path):
    text = TEMPLATE.read_text(encoding="utf-8")
    text = text.replace("const PHOTOS = {", "const PHOTOS = {\n  farm: 'photos/farm.jpg',").replace("kind: 'print', photo: null", "kind: 'print', photo: 'farm'")
    page(tmp_path, text, "film.html")
    r = film("sheet", "film.html", "-o", "beats.png", ok=False)
    assert r.code == 1 and (tmp_path / "beats.png").exists()
    assert any("farm" in w for w in r.json()["warnings"])


def test_the_page_sees_only_its_own_folder(film, browser, tmp_path):
    (tmp_path / "secret.txt").write_text("private", encoding="utf-8")
    inside = tmp_path / "film"
    inside.mkdir()
    linked = False
    try:
        (inside / "link.txt").symlink_to(tmp_path / "secret.txt")
        linked = True
    except OSError:
        pass  # Windows without the right to make links
    page(inside, PAGE.replace("ready: Promise.resolve()", """ready: (async () => {
      for (const url of ['../secret.txt', '%2e%2e/secret.txt', 'link.txt']) {
        const r = await fetch(url);
        if (r.ok && (await r.text()) === 'private') console.error('read ' + url);
      }
    })()"""))
    r = film("sheet", "film/page.html", "-o", "s.png", "--at", "0", ok=False)
    assert not any(w.startswith("error: read") for w in r.json()["warnings"]), r.out
    if linked:
        assert r.code == 1  # the link's 404 is reported


def test_page_errors_are_one_line_and_point_at_the_page(film, browser, tmp_path):
    page(tmp_path, "<!doctype html><p>no film here</p>", "none.html")
    r = film("sheet", "none.html", "-o", "s.png", ok=False)
    assert r.one_line_error() and "window.film" in r.err
    page(tmp_path, PAGE.replace("x.fillStyle = t < 1", "if (t > 1) missingThing(); x.fillStyle = t < 1"), "broken.html")
    r = film("sheet", "broken.html", "-o", "s.png", "--at", "1.2", ok=False)
    assert r.one_line_error() and "missingThing" in r.err and "broken.html:" in r.err
    page(tmp_path, PAGE.replace("const c =", "nope();\nconst c ="), "throws.html")
    assert film("sheet", "throws.html", "-o", "s.png", ok=False).one_line_error()


def test_bad_paths_are_one_line(film, browser, tmp_path):
    page(tmp_path)
    (tmp_path / "out").mkdir()
    for args in (["sheet", "page.html", "-o", "out"], ["sheet", "page.html", "-o", "nofolder/s.png"], ["sheet", "page.html", "-o", "s.jpg"],
                 ["sheet", "nothere.html", "-o", "s.png"], ["sheet", "page.html"], ["render", "page.html", "-o", "v.mov"], ["wave", "page.html"]):
        assert film(*args, ok=False).one_line_error(), args


# ---------- render ----------


def test_render_is_exactly_as_long_as_the_voiceover_with_it_underneath(film, browser, ffmpeg, tmp_path):
    page(tmp_path)
    wav = tone(tmp_path / "voice.wav", ("tone", 1.5))
    r = film("render", "page.html", "-o", "film.mp4", "--audio", "voice.wav").json()
    assert (r["width"], r["height"], r["fps"], r["frames"], r["duration"]) == (320, 180, 20, 30, 1.5) and r["warnings"] == []
    info = probe(tmp_path / "film.mp4")
    video = next(s for s in info["streams"] if s["codec_type"] == "video")
    assert any(s["codec_type"] == "audio" for s in info["streams"])
    assert (video["width"], video["height"], video["r_frame_rate"], int(video["nb_read_frames"])) == (320, 180, "20/1", 30)
    assert float(info["format"]["duration"]) == pytest.approx(1.5, abs=0.03)
    first, last = frame(tmp_path / "film.mp4", 0, tmp_path / "a.png"), frame(tmp_path / "film.mp4", 1.4, tmp_path / "b.png")
    r0, _, b0 = first.getpixel((160, 90))
    r1, _, b1 = last.getpixel((160, 90))
    assert r0 > 200 and b0 < 60 and b1 > 200 and r1 < 60
    assert wav.exists() and not list(tmp_path.glob(".*.part"))


def test_render_refuses_a_page_that_doesnt_last_as_long_as_the_voiceover(film, browser, ffmpeg, tmp_path):
    page(tmp_path)
    tone(tmp_path / "voice.wav", ("tone", 2.0))
    r = film("render", "page.html", "-o", "film.mp4", "--audio", "voice.wav", ok=False)
    assert r.one_line_error() and "voiceover lasts 2" in r.err
    assert not (tmp_path / "film.mp4").exists() and not list(tmp_path.glob(".*.part"))


def test_a_draft_of_part_of_the_template_at_a_smaller_size(film, browser, ffmpeg, tmp_path):
    shutil.copy(TEMPLATE, tmp_path / "film.html")
    r = film("render", "film.html", "-o", "draft.mp4", "--from", "2", "--to", "2.5", "--scale", "0.25").json()
    assert (r["width"], r["height"], r["frames"], r["from"]) == (480, 270, 15, 2)
    assert int(next(s for s in probe(tmp_path / "draft.mp4")["streams"] if s["codec_type"] == "video")["nb_read_frames"]) == 15


def test_render_refuses_odd_sizes_and_bad_numbers(film, browser, ffmpeg, tmp_path):
    page(tmp_path, PAGE.replace('width="320" height="180"', 'width="321" height="180"'), "odd.html")
    r = film("render", "odd.html", "-o", "v.mp4", ok=False)
    assert r.one_line_error() and "even" in r.err
    page(tmp_path)
    for bad in (["--scale", "0"], ["--scale", "2"], ["--crf", "60"], ["--crf", "1.5"], ["--timeout", "0"], ["--from", "1", "--to", "0.5"], ["--to", "9"]):
        assert film("render", "page.html", "-o", "v.mp4", *bad, ok=False).one_line_error(), bad
    assert not (tmp_path / "v.mp4").exists()

