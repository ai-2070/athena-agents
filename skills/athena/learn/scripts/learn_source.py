#!/usr/bin/env python3
"""Turn a source into plain text an agent can read a piece at a time, for the learn skill.

  learn_source.py epub BOOK.epub -o learn-work/book      one Markdown file per chapter, in reading order, and index.json
  learn_source.py html PAGE.html -o learn-work/page.md   a saved web page as Markdown-ish text
  learn_source.py subs VIDEO.srt -o learn-work/talk.md   subtitles (.srt or .vtt) as timestamped paragraphs
  learn_source.py clean NOTES.txt -o learn-work/notes.md  any text file, without invisible and direction-control characters
  learn_source.py probe REC.mp4 -o learn-work/probe       a video's length, size and sound, and two frames to check it by
  learn_source.py frames REC.mp4 -o learn-work/frames     a screen recording's telling frames: the last before each change

probe and frames need FFmpeg (ffmpeg and ffprobe on PATH, or --ffmpeg <its folder>).

Every command strips characters that are invisible or change the reading direction (zero-width, bidi controls, tag
characters): they can make a text read one way to a person and another to an agent. The JSON on stdout says how many.

Python 3.11 or newer, standard library only. Exit codes: 0 done; 1 done, with something to look at (a chapter with no
text, a DRM-locked book, a video with no length in it: see "warnings"); 2 couldn't do it (one line on stderr).
"""

from __future__ import annotations

import argparse
import bisect
import html
import json
import locale
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import zipfile
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8")  # a Windows pipe is cp1252 otherwise
    except (AttributeError, ValueError):
        pass


class Failure(Exception):
    """Something that stops the job: one line on stderr, exit 2."""


# ---------- shared helpers ----------
def emit(result: dict, code: int = 0) -> int:
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return code


def decode(data: bytes) -> tuple[str, str]:
    """Bytes to text: UTF-16 by its byte-order mark (PowerShell 5.1's >), UTF-8 with or without a mark, then the ANSI
    code page (Set-Content). Returns the text and the encoding used."""
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16"), "utf-16"
    try:
        return data.decode("utf-8-sig"), "utf-8"
    except UnicodeDecodeError:
        enc = locale.getpreferredencoding(False) or "cp1252"
        return data.decode(enc, errors="replace"), enc


def write_text(path: Path, text: str) -> None:
    """Write through a temporary file in the same folder, so a failed run leaves no half-written file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


# zero-width and joiners, bidi embeddings/overrides/isolates and marks, the BOM, and tag characters
HIDDEN = re.compile("[​-‏‪-‮⁠-⁤⁦-⁩﻿\U000e0000-\U000e007f]")


def clean(text: str) -> tuple[str, int]:
    found = len(HIDDEN.findall(text))
    text = HIDDEN.sub("", text).replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"[ \t]+\n", "\n", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip() + "\n", found


def safe_output(out: Path, *inputs: Path) -> Path:
    out = out.expanduser()
    for i in inputs:
        if i.exists() and out.exists() and out.resolve() == i.resolve():
            raise Failure(f"{out} is the input: give another output path")
    return out


# ---------- HTML to text ----------
BLOCK = {"p", "div", "section", "article", "li", "tr", "br", "blockquote", "pre", "figure", "figcaption", "dd", "dt", "table", "ul", "ol", "header", "footer", "aside"}
SKIP = {"script", "style", "noscript", "svg", "head", "nav", "template"}


class TextOf(HTMLParser):
    """Readable text from (X)HTML: headings as #, list items as -, paragraphs apart, code kept as it is."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self.skip = 0
        self.pre = 0
        self.title = ""
        self.in_title = False
        self.first_heading = ""
        self.heading: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag == "title":
            self.in_title = True
        if tag in SKIP:
            self.skip += 1
            return
        if re.fullmatch(r"h[1-6]", tag):
            self.out.append("\n\n" + "#" * int(tag[1]) + " ")
            self.heading = []
        elif tag == "li":
            self.out.append("\n- ")
        elif tag == "pre":
            self.pre += 1
            self.out.append("\n\n```\n")
        elif tag in BLOCK:
            self.out.append("\n\n" if tag != "br" else "\n")

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self.in_title = False
        if tag in SKIP:
            self.skip = max(0, self.skip - 1)
            return
        if re.fullmatch(r"h[1-6]", tag):
            if self.heading is not None and not self.first_heading:
                self.first_heading = " ".join("".join(self.heading).split())
            self.heading = None
            self.out.append("\n\n")
        elif tag == "pre":
            self.pre = max(0, self.pre - 1)
            self.out.append("\n```\n\n")
        elif tag in BLOCK:
            self.out.append("\n\n")

    def handle_data(self, data: str) -> None:
        if self.in_title:
            self.title += data
        if self.skip:
            return
        if self.heading is not None:
            self.heading.append(data)
        self.out.append(data if self.pre else re.sub(r"\s+", " ", data))

    def text(self) -> str:
        lines, code = [], False
        for ln in "".join(self.out).split("\n"):
            if ln.strip().startswith("```"):
                code = not code
                lines.append(ln.strip())
            else:
                # code keeps its indentation; prose loses the spaces the markup left around it
                lines.append(ln.rstrip() if code or ln.startswith(("#", "-")) else ln.strip())
        return "\n".join(lines)


def html_text(source: str) -> tuple[str, str]:
    p = TextOf()
    p.feed(source)
    p.close()
    return p.text(), " ".join((p.title or p.first_heading).split())


# ---------- EPUB ----------
NS = {"c": "urn:oasis:names:tc:opendocument:xmlns:container", "opf": "http://www.idpf.org/2007/opf", "dc": "http://purl.org/dc/elements/1.1/"}
MAX_CHAPTER = 20_000_000  # bytes of one unpacked chapter: more is a broken or hostile file


def read_member(book: zipfile.ZipFile, name: str) -> bytes:
    info = book.getinfo(name)
    if info.file_size > MAX_CHAPTER:
        raise Failure(f"{name} in the book unpacks to {info.file_size} bytes, too big to be a chapter")
    return book.read(info)


def epub(args: argparse.Namespace) -> int:
    src = Path(args.file).expanduser()
    out = safe_output(Path(args.out), src)
    if not src.is_file():
        raise Failure(f"no file {src}")
    try:
        book = zipfile.ZipFile(src)
    except zipfile.BadZipFile:
        raise Failure(f"{src} isn't an EPUB (not a zip file)") from None
    with book:
        names = set(book.namelist())
        if "META-INF/encryption.xml" in names:
            enc = read_member(book, "META-INF/encryption.xml").decode("utf-8", "replace")
            # fonts are often obfuscated in books with no DRM at all; anything else locked means DRM
            locked = [u for u in re.findall(r'URI="([^"]+)"', enc) if not re.search(r"\.(ttf|otf|woff2?)$", u, re.I)]
            if locked:
                return emit({"ok": False, "file": str(src), "warnings": [f"{len(locked)} parts of this book are encrypted (DRM). Use a copy without DRM, or the text the user can export from their reader."]}, 1)
        if "META-INF/container.xml" not in names:
            raise Failure(f"{src} has no META-INF/container.xml: not an EPUB")
        root = ElementTree.fromstring(read_member(book, "META-INF/container.xml"))
        rootfile = root.find(".//c:rootfile", NS)
        if rootfile is None or not rootfile.get("full-path"):
            raise Failure("the EPUB's container names no package file")
        opf_path = rootfile.get("full-path", "")
        opf = ElementTree.fromstring(read_member(book, opf_path))
        base = PurePosixPath(opf_path).parent
        title = (opf.findtext(".//dc:title", default="", namespaces=NS) or "").strip()
        author = (opf.findtext(".//dc:creator", default="", namespaces=NS) or "").strip()
        manifest = {i.get("id"): i for i in opf.findall(".//opf:manifest/opf:item", NS)}
        chapters, warnings, hidden = [], [], 0
        out.mkdir(parents=True, exist_ok=True)
        for n, ref in enumerate(opf.findall(".//opf:spine/opf:itemref", NS), 1):
            item = manifest.get(ref.get("idref"))
            if item is None or "html" not in (item.get("media-type") or ""):
                continue
            member = str(base / item.get("href", "")) if str(base) != "." else item.get("href", "")
            member = re.sub(r"%20", " ", member)
            if member not in names:
                warnings.append(f"the book lists {member}, which isn't in it")
                continue
            text, found = clean(html_text(decode(read_member(book, member))[0])[0])
            hidden += found
            words = len(text.split())
            head = next((ln.lstrip("# ").strip() for ln in text.splitlines() if ln.startswith("#")), "")
            name = f"{len(chapters) + 1:03d}-{re.sub(r'[^a-z0-9]+', '-', (head or PurePosixPath(member).stem).lower()).strip('-')[:50] or 'part'}.md"
            if words == 0:
                warnings.append(f"spine item {n} ({member}) has no text (a cover or an image page?)")
                continue
            write_text(out / name, text)
            chapters.append({"file": name, "heading": head, "words": words, "source": member})
        index = {"title": title, "author": author, "chapters": chapters}
        write_text(out / "index.json", json.dumps(index, ensure_ascii=False, indent=2) + "\n")
    if not chapters:
        warnings.append("no chapter had any text: the book may be images only (a scanned or comic EPUB)")
    return emit({"ok": not warnings or bool(chapters), "file": str(src), "out": str(out), "title": title, "author": author, "chapters": len(chapters), "words": sum(c["words"] for c in chapters), "hidden_characters_removed": hidden, **({"warnings": warnings} if warnings else {})}, 1 if warnings else 0)


# ---------- a saved web page ----------
def html_cmd(args: argparse.Namespace) -> int:
    src = Path(args.file).expanduser()
    out = safe_output(Path(args.out), src)
    if not src.is_file():
        raise Failure(f"no file {src}")
    raw, enc = decode(src.read_bytes())
    text, title = html_text(raw)
    text, hidden = clean(text)
    write_text(out, text)
    return emit({"ok": True, "file": str(src), "out": str(out), "title": title, "words": len(text.split()), "encoding": enc, "hidden_characters_removed": hidden})


# ---------- subtitles ----------
TIME = re.compile(r"(\d{1,2}:)?(\d{1,2}):(\d{2})[.,](\d{3})\s*-->\s*")


def stamp(seconds: int) -> str:
    h, rest = divmod(seconds, 3600)
    return f"{h:02d}:{rest // 60:02d}:{rest % 60:02d}"


def subs(args: argparse.Namespace) -> int:
    src = Path(args.file).expanduser()
    out = safe_output(Path(args.out), src)
    if not src.is_file():
        raise Failure(f"no file {src}")
    raw, enc = decode(src.read_bytes())
    raw, hidden = clean(raw)
    cues: list[tuple[int, str]] = []
    for block in re.split(r"\n\s*\n", raw):
        lines = block.strip().splitlines()
        at = next((i for i, ln in enumerate(lines) if TIME.search(ln)), None)
        if at is None:
            continue
        m = TIME.search(lines[at])
        assert m is not None
        seconds = int((m.group(1) or "0:")[:-1]) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
        words = " ".join(re.sub(r"<[^>]+>", "", html.unescape(ln)).strip() for ln in lines[at + 1 :]).strip()
        if words:
            cues.append((seconds, words))
    if not cues:
        raise Failure(f"{src} has no subtitle cues (expected .srt or .vtt timings like 00:01:02,500 --> …)")
    # automatic captions repeat each line as the next one rolls in: keep only what's new
    said: list[tuple[int, str]] = []
    for t, words in cues:
        if said and (words == said[-1][1] or said[-1][1].endswith(words)):
            continue
        if said and words.startswith(said[-1][1]):
            words = words[len(said[-1][1]) :].strip()
            if not words:
                continue
        said.append((t, words))
    # a paragraph at least every `every` seconds, each with the time it starts
    paras, start, buf = [], said[0][0], []
    for t, words in said:
        if buf and t - start >= args.every:
            paras.append(f"[{stamp(start)}] {' '.join(buf)}")
            start, buf = t, []
        buf.append(words)
    if buf:
        paras.append(f"[{stamp(start)}] {' '.join(buf)}")
    text = "\n\n".join(paras) + "\n"
    write_text(out, text)
    return emit({"ok": True, "file": str(src), "out": str(out), "cues": len(cues), "paragraphs": len(paras), "length": stamp(said[-1][0]), "encoding": enc, "hidden_characters_removed": hidden})


# ---------- any text ----------
def clean_cmd(args: argparse.Namespace) -> int:
    src = Path(args.file).expanduser()
    out = safe_output(Path(args.out), src)
    if not src.is_file():
        raise Failure(f"no file {src}")
    raw, enc = decode(src.read_bytes())
    text, hidden = clean(raw)
    write_text(out, text)
    return emit({"ok": True, "file": str(src), "out": str(out), "words": len(text.split()), "encoding": enc, "hidden_characters_removed": hidden})
# ---------- screen recordings ----------
# A screen recording is learned from its pictures, and pictures are what an agent pays for: each one it looks at takes
# a lot of its context. So these commands pick few frames, and the telling ones: the screen just before it changes (by
# then the page has loaded and the typing is done), and enough others that no long stretch goes without one.
VIEW_MAX = 5 * 1024 * 1024  # the most view_image takes; a bigger frame is saved again as JPEG
SHEET_WIDTH = 1600  # a contact sheet's width: models shrink bigger pictures anyway
SETTLE = 1.0  # changes closer together than this are one change (scrolling, an animation)
NOT_VIDEO = re.compile(r"(^|,)(image2|\w+_pipe)(,|$)")  # still pictures FFmpeg reads as a "video" of one frame
# files with an index FFmpeg seeks by exactly; in others (MPEG-TS above all) a quick seek can land seconds off
INDEXED = re.compile(r"(^|,)(mov|mp4|matroska|webm)(,|$)")
SEEK_COST = 2.0  # what starting FFmpeg once more costs, in seconds of video it could have decoded instead


def find_ffmpeg(given: str | None) -> tuple[str, str]:
    exe = ".exe" if os.name == "nt" else ""
    if given:
        place = Path(given).expanduser()
        folder = place if place.is_dir() else place.parent
        ffmpeg, ffprobe = folder / f"ffmpeg{exe}", folder / f"ffprobe{exe}"
        if not (ffmpeg.is_file() and ffprobe.is_file()):
            raise Failure(f"no ffmpeg{exe} and ffprobe{exe} in {folder}")
        return str(ffmpeg), str(ffprobe)
    found = shutil.which("ffmpeg"), shutil.which("ffprobe")
    if not (found[0] and found[1]):
        raise Failure("FFmpeg isn't installed or isn't on PATH (ffmpeg and ffprobe are both needed): get it from ffmpeg.org, or pass --ffmpeg <the folder it is in>")
    return found[0], found[1]


def kill_tree(proc: subprocess.Popen) -> None:
    """Stop a program and every program it started: FFmpeg from choco or scoop is a small launcher that starts the real
    one, which stopping the launcher alone leaves running."""
    if os.name == "nt":
        try:
            subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, timeout=30)
        except (OSError, subprocess.TimeoutExpired):
            proc.kill()
    else:
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            proc.kill()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        pass


def call(cmd: list[str], cwd: Path | None = None, timeout: float = 3600) -> subprocess.CompletedProcess[bytes]:
    # in a session of its own on macOS and Linux, so the whole tree can be stopped together
    extra = {"start_new_session": True} if os.name != "nt" else {}
    with subprocess.Popen(cmd, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **extra) as proc:
        try:
            out, err = proc.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            kill_tree(proc)
            raise Failure(f"{Path(cmd[0]).stem} didn't finish within {timeout:g} seconds; stopped") from None
        except BaseException:  # Ctrl+C too
            kill_tree(proc)
            raise
    return subprocess.CompletedProcess(cmd, proc.returncode, out, err)


def said(r: subprocess.CompletedProcess[bytes]) -> str:
    lines = r.stderr.decode("utf-8", errors="replace").strip().splitlines()
    return lines[-1].strip() if lines else f"exit {r.returncode}"


def ffmpeg_run(cmd: list[str], what: str, cwd: Path | None = None) -> None:
    """Run ffmpeg; older ones (before 5.1) have no -fps_mode, so try -vsync there."""
    r = call(cmd, cwd)
    if r.returncode != 0 and "-fps_mode" in cmd and b"fps_mode" in r.stderr:
        i = cmd.index("-fps_mode")
        r = call([*cmd[:i], "-vsync", "passthrough", *cmd[i + 2 :]], cwd)
    if r.returncode != 0:
        raise Failure(f"ffmpeg couldn't {what}: {said(r)}")


def tenths(seconds: float) -> int:
    # rounded before it is split into minutes, so 59.96 s reads 01:00.0, not 00:60.0
    return round(max(0.0, seconds) * 10)


def clock(seconds: float) -> str:
    """02:31.4, or 1:02:31.4 past an hour."""
    m, t = divmod(tenths(seconds), 600)
    h, m = divmod(m, 60)
    s = f"{t // 10:02d}.{t % 10}"
    return f"{h}:{m:02d}:{s}" if h else f"{m:02d}:{s}"


def stamp_name(seconds: float) -> str:
    """A time for a file name: 02m31.4s (no colons, for Windows)."""
    m, t = divmod(tenths(seconds), 600)
    return f"{m:02d}m{t // 10:02d}.{t % 10}s"


def a_time(value: str) -> float:
    """Seconds from 12.4, 2:31.4 or 1:02:31."""
    try:
        parts = [float(x) for x in value.strip().split(":")]
    except ValueError:
        raise argparse.ArgumentTypeError(f"{value!r} isn't a time (12.4, 2:31.4 or 1:02:31)") from None
    if not 1 <= len(parts) <= 3 or any(not math.isfinite(x) or x < 0 for x in parts):
        raise argparse.ArgumentTypeError(f"{value!r} isn't a time (12.4, 2:31.4 or 1:02:31)")
    total = 0.0
    for x in parts:
        total = total * 60 + x
    return total


def video_info(src: Path, ffprobe: str) -> dict:
    """What the recording is: its length (from the file, or else from its last frame), picture, sound and subtitles."""
    if not src.is_file():
        raise Failure(f"no file {src}")
    r = call([ffprobe, "-v", "error", "-show_entries", "format=duration,start_time,format_name:stream=codec_type,codec_name,width,height,avg_frame_rate,duration:stream_disposition=attached_pic", "-of", "json", str(src)])
    if r.returncode != 0:
        raise Failure(f"{src} isn't a video FFmpeg can read ({said(r)})")
    try:
        data = json.loads(r.stdout.decode("utf-8", errors="replace") or "{}")
    except json.JSONDecodeError:
        raise Failure(f"ffprobe gave no readable answer for {src}") from None
    fmt, streams = data.get("format") or {}, data.get("streams") or []
    picture = [x for x in streams if x.get("codec_type") == "video" and not (x.get("disposition") or {}).get("attached_pic")]
    if not picture or NOT_VIDEO.search(str(fmt.get("format_name", ""))):
        raise Failure(f"{src} has no moving picture: it's a still image or sound only")
    video = picture[0]
    warnings: list[str] = []

    def number(x: object) -> float | None:
        try:
            v = float(str(x))
        except ValueError:
            return None
        return v if v == v and v > 0 else None  # not NaN, more than 0

    # FFmpeg counts time from the file's start (an MPEG-TS often starts at 1.4 s), and so does everything here
    start = number(fmt.get("start_time")) or 0.0
    seconds, source = number(fmt.get("duration")) or number(video.get("duration")), "file"
    if seconds is None:
        # browsers' recorders write WebM with no length in it: read it off the last frame
        pk = call([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,duration_time", "-of", "csv=p=0", str(src)])
        ends = []
        for line in pk.stdout.decode("utf-8", errors="replace").splitlines():
            bits = [number(b) if b.strip() not in ("", "N/A") else None for b in line.split(",")]
            if bits and bits[0] is not None:
                ends.append(bits[0] + (bits[1] if len(bits) > 1 and bits[1] else 0.0))
        if not ends:
            raise Failure(f"{src} has no length in it and FFmpeg found no frames to measure it by")
        seconds, source = max(ends) - start, "frames"
        warnings.append("the file has no length in it (browsers' recorders leave it out); it was measured from its last frame")
    rate = None
    num, _, den = str(video.get("avg_frame_rate", "0/0")).partition("/")
    if num.isdigit() and den.isdigit() and int(den):
        rate = round(int(num) / int(den), 2) or None
    if seconds < 1.0:
        warnings.append(f"it is only {seconds:.2f} s long: most likely the recording failed")
    return {
        "seconds": round(seconds, 3),
        "length": clock(seconds),
        "length_from": source,
        "start": start,
        "indexed": bool(INDEXED.search(str(fmt.get("format_name", "")))),
        "size_mb": round(src.stat().st_size / 1024 / 1024, 2),
        "width": video.get("width"),
        "height": video.get("height"),
        "frame_rate": rate,
        "video": video.get("codec_name"),
        "sound": any(x.get("codec_type") == "audio" for x in streams),
        "subtitles": sum(1 for x in streams if x.get("codec_type") == "subtitle"),
        "warnings": warnings,
    }


def scale(width: int) -> str:
    return f"scale='min({width},iw)':-2"


def grab(ffmpeg: str, src: Path, at: float, dest: Path, width: int | None, indexed: bool) -> bool:
    """The first frame at or after `at` (seconds from the start), saved as PNG. False when there is none: `at` is past
    the last frame. A file with no index is decoded from its start to get there, which is slower but exact."""
    seek = ["-ss", f"{at:.6f}"]
    cmd = [ffmpeg, "-hide_banner", "-v", "error", "-y", *(seek if indexed else []), "-i", str(src), *([] if indexed else seek), "-map", "0:v:0", "-frames:v", "1"]
    ffmpeg_run([*cmd, *(["-vf", scale(width)] if width else []), str(dest)], f"save the frame at {clock(at)}")
    return dest.is_file()


def fit_for_viewing(ffmpeg: str, png: Path) -> Path:
    """A frame view_image can take: PNG keeps text sharp, but one over 5 MB is saved again as JPEG."""
    if png.stat().st_size <= VIEW_MAX:
        return png
    jpg = png.with_suffix(".jpg")
    ffmpeg_run([ffmpeg, "-hide_banner", "-v", "error", "-y", "-i", str(png), "-q:v", "3", str(jpg)], f"shrink {png.name}")
    png.unlink()
    return jpg


def probe(args: argparse.Namespace) -> int:
    ffmpeg, ffprobe = find_ffmpeg(args.ffmpeg)
    src = Path(args.file).expanduser()
    info = video_info(src, ffprobe)
    out = Path(args.out).expanduser()
    if out.exists() and not out.is_dir():
        raise Failure(f"{out} is a file: give a folder")
    out.mkdir(parents=True, exist_ok=True)
    checks = []
    with tempfile.TemporaryDirectory(dir=out, prefix=".probe-") as tmp:
        for share in (0.2, 0.7):
            at = info["seconds"] * share
            name = f"check-{int(share * 100)}.png"
            if not grab(ffmpeg, src, at, Path(tmp) / name, args.width, info["indexed"]):
                raise Failure(f"ffmpeg saved no frame at {clock(at)}")
            final = fit_for_viewing(ffmpeg, Path(tmp) / name)
            os.replace(final, out / final.name)
            checks.append({"file": final.name, "at": round(at, 2), "time": clock(at)})
    warnings = info.pop("warnings")
    info.pop("start")
    info.pop("indexed")
    result = {"ok": True, "file": str(src), "out": str(out), **info, "check_frames": checks, "warnings": warnings}
    return emit(result, 1 if warnings else 0)


def scan(ffmpeg: str, src: Path, folder: Path) -> list[tuple[int, float, float]]:
    """Every frame's number, time and how much it differs from the one before (FFmpeg's scene score, 0 to 1)."""
    # (the scores are written to a file named without a folder, so no Windows path has to be escaped for the filter)
    ffmpeg_run([ffmpeg, "-hide_banner", "-nostats", "-v", "error", "-i", str(src.resolve()), "-map", "0:v:0", "-vf", f"{scale(480)},select='gte(scene,0)',metadata=print:file=scores.txt", "-f", "null", "-"], "read the recording", cwd=folder)
    frames: list[tuple[int, float, float]] = []
    head = re.compile(r"frame:(\d+)\s+pts:\S+\s+pts_time:(\S+)")
    for line in (folder / "scores.txt").read_text(encoding="utf-8", errors="replace").splitlines():
        m = head.match(line.strip())
        if m:
            try:
                # already counted from the file's start, like -ss (FFmpeg shifts the times unless told -copyts)
                frames.append((int(m.group(1)), float(m.group(2)), 0.0))
            except ValueError:
                continue
        elif line.startswith("lavfi.scene_score=") and frames:
            n, t, _ = frames[-1]
            try:
                frames[-1] = (n, t, float(line.split("=", 1)[1]))
            except ValueError:
                pass
    if not frames:
        raise Failure(f"ffmpeg read no frames from {src}")
    return frames


def choose(frames: list[tuple[int, float, float]], change: float, every: float) -> tuple[dict[int, str], int]:
    """Which frames to keep (index -> why), and how many screen changes there were."""
    bursts: list[list[int]] = []  # [first, last] index of each change (changes close together are one)
    for i in range(1, len(frames)):
        if frames[i][2] < change:
            continue
        if bursts and frames[i][1] - frames[bursts[-1][1]][1] < SETTLE:
            bursts[-1][1] = i
        else:
            bursts.append([i, i])
    times = [t for _, t, _ in frames]
    keep: dict[int, str] = {0: "first", len(frames) - 1: "last"}
    for first, _ in bursts:
        keep.setdefault(first - 1, f"before the screen changed at {clock(times[first])}")
    # no stretch longer than `every` without a frame, still or not (scrolling, an animation, slow typing)
    marks = sorted(keep)
    for a, b in zip(marks, marks[1:]):
        gap = times[b] - times[a]
        add = math.ceil(gap / every) - 1 if gap > every else 0
        for k in range(1, add + 1):
            j = bisect.bisect_left(times, times[a] + gap * k / (add + 1), a + 1, b)
            if a < j < b:
                keep.setdefault(j, f"at least one every {every:g} s")
    return keep, len(bursts)


def thin(keep: dict[int, str], most: int) -> tuple[dict[int, str], int]:
    """At most `most` frames: the first and last always, then the ones before a change, then the regular ones, each
    thinned evenly over the recording."""
    if len(keep) <= most:
        return keep, 0
    ends = {i: w for i, w in keep.items() if w in ("first", "last")}
    changes = sorted(i for i, w in keep.items() if w.startswith("before"))
    regular = sorted(i for i in keep if i not in ends and not keep[i].startswith("before"))

    def evenly(items: list[int], n: int) -> list[int]:
        if n <= 0:
            return []
        if n >= len(items):
            return items
        if n == 1:
            return [items[len(items) // 2]]
        return [items[round(k * (len(items) - 1) / (n - 1))] for k in range(n)]

    room = most - len(ends)
    picked = evenly(changes, room)
    picked += evenly(regular, room - len(picked))
    kept = {**ends, **{i: keep[i] for i in picked}}
    return kept, len(keep) - len(kept)


def keyframes(ffprobe: str, src: Path, start: float) -> list[float]:
    """The times of the recording's keyframes, from its start: where a seek can begin decoding. Reads packets only."""
    r = call([ffprobe, "-v", "error", "-select_streams", "v:0", "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", str(src)])
    keys = []
    for line in r.stdout.decode("utf-8", errors="replace").splitlines():
        t, _, flags = line.partition(",")
        if "K" in flags:
            try:
                keys.append(float(t) - start)
            except ValueError:
                continue
    return sorted(keys)


def seeking_pays(picked: list[float], keys: list[float], seconds: float) -> bool:
    """Whether to save the chosen frames by seeking to each one (in a file with an index), which decodes from the
    keyframe before it, rather than decoding the whole recording again. A long recording with keyframes every few seconds seeks; a short one, or one
    with few keyframes (browsers' recorders may write only the first), is read again."""
    if not keys:
        return False
    work = 0.0
    for t in picked:
        i = bisect.bisect_right(keys, t + 0.001) - 1
        work += (t - keys[i] if i >= 0 else t) + SEEK_COST
    return work < seconds / 2


def save_picked(ffmpeg: str, src: Path, frames: list[tuple[int, float, float]], order: list[int], width: int, folder: Path, seek: bool) -> tuple[list[tuple[int, Path]], bool]:
    """Save the chosen frames in `folder` as 00001.png, 00002.png… in time order. Returns each saved frame's index with
    its file, and whether any is missing."""
    if seek:
        made: list[tuple[int, Path]] = []
        for i in order:
            # from halfway after the frame before: FFmpeg keeps the first frame at or after the time it seeks to, and a
            # time printed to the microsecond can land just past the frame it names
            at = (frames[i - 1][1] + frames[i][1]) / 2 if i > 0 else 0.0
            png = folder / f"{len(made) + 1:05d}.png"
            if grab(ffmpeg, src.resolve(), max(0.0, at), png, width, True):
                made.append((i, png))
        return made, len(made) != len(order)
    picks = "+".join(f"eq(n,{frames[i][0]})" for i in order)
    ffmpeg_run([ffmpeg, "-hide_banner", "-v", "error", "-y", "-i", str(src.resolve()), "-map", "0:v:0", "-vf", f"select='{picks}',{scale(width)}", "-fps_mode", "passthrough", "%05d.png"], "save the frames", cwd=folder)
    files = sorted(folder.glob("[0-9][0-9][0-9][0-9][0-9].png"))
    return list(zip(order, files)), len(files) != len(order)


def make_sheets(ffmpeg: str, folder: Path, count: int, cols: int, rows: int) -> list[Path]:
    cell = max(160, (SHEET_WIDTH - 8 * (cols + 1)) // cols // 2 * 2)
    ffmpeg_run([ffmpeg, "-hide_banner", "-v", "error", "-y", "-framerate", "1", "-i", "%05d.png", "-vf", f"scale={cell}:-2,tile={cols}x{rows}:padding=8:margin=8:color=white", "-fps_mode", "passthrough", "sheet-%02d.png"], "make the contact sheets", cwd=folder)
    return [folder / f"sheet-{k:02d}.png" for k in range(1, (count + cols * rows - 1) // (cols * rows) + 1)]


def earlier_run(out: Path) -> list[str]:
    """The files an earlier run left in `out`, as its frames.json lists them; none for a new or empty folder. A folder
    holding anything else is refused, so nothing of the user's is replaced."""
    if out.exists() and not out.is_dir():
        raise Failure(f"{out} is a file: give a folder")
    if not out.is_dir():
        return []
    listing = out / "frames.json"
    if listing.is_file():
        try:
            earlier = json.loads(listing.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError):
            earlier = None
        if not (isinstance(earlier, dict) and isinstance(earlier.get("frames"), list)):
            raise Failure(f"{listing} isn't one this script wrote: give a new folder for the frames")
        sheets = earlier.get("sheets") if isinstance(earlier.get("sheets"), list) else []
        names = [x.get("file") for x in [*earlier["frames"], *sheets] if isinstance(x, dict)]
        # only plain names in the folder itself
        return [n for n in names if isinstance(n, str) and n not in ("", ".", "..") and n == Path(n).name]
    if any(not x.name.startswith(".") for x in out.iterdir()):
        raise Failure(f"{out} isn't empty: give a new folder for the frames")
    return []


def at_moments(args: argparse.Namespace, ffmpeg: str, src: Path, info: dict, out: Path) -> int:
    """Frames at the times asked for, at full size, for reading small text: added beside what's there."""
    if out.exists() and not out.is_dir():
        raise Failure(f"{out} is a file: give a folder")
    warnings = list(info["warnings"])
    out.mkdir(parents=True, exist_ok=True)
    saved = []
    with tempfile.TemporaryDirectory(dir=out, prefix=".frames-") as tmp:
        ready = []
        for at in args.at:
            if at >= info["seconds"]:
                warnings.append(f"{clock(at)} is at or past the end ({info['length']}); left out")
                continue
            png = Path(tmp) / f"at-{stamp_name(at)}.png"
            if any(f.stem == png.stem for f in ready):  # the same tenth of a second, asked twice
                continue
            if not grab(ffmpeg, src, at, png, None, info["indexed"]):
                # the length can run past the last frame (a longer sound track, the last frame's own time)
                warnings.append(f"{clock(at)} is past the last frame; left out")
                continue
            ready.append(fit_for_viewing(ffmpeg, png))
            saved.append({"file": ready[-1].name, "at": round(at, 3), "time": clock(at), "why": "asked for"})
        for f in ready:  # all saved before any is added, so a failed run adds none
            os.replace(f, out / f.name)
    return emit({"ok": True, "file": str(src), "out": str(out), "length": info["length"], "frames": saved, "warnings": warnings}, 1 if warnings else 0)


def frames_cmd(args: argparse.Namespace) -> int:
    out = Path(args.out).expanduser()
    earlier = [] if args.at else earlier_run(out)
    ffmpeg, ffprobe = find_ffmpeg(args.ffmpeg)
    src = Path(args.file).expanduser()
    info = video_info(src, ffprobe)
    if args.at:
        return at_moments(args, ffmpeg, src, info, out)
    warnings = list(info["warnings"])
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=out, prefix=".frames-") as tmp_name:
        tmp = Path(tmp_name)
        frames = scan(ffmpeg, src, tmp)
        keep, changes = choose(frames, args.change, args.every)
        keep, dropped = thin(keep, args.max)
        order = sorted(keep)
        seek = info["indexed"] and seeking_pays([frames[i][1] for i in order], keyframes(ffprobe, src, info["start"]), info["seconds"])
        made, short = save_picked(ffmpeg, src, frames, order, args.width, tmp, seek)
        if short:
            warnings.append(f"ffmpeg saved {len(made)} frames of the {len(order)} chosen" + ("" if seek else "; their times may be off"))
        names = [f"f{k:03d}-{stamp_name(frames[i][1])}" for k, (i, _) in enumerate(made, 1)]
        ready: list[Path] = []
        sheets: list[dict] = []
        if args.sheet and made:
            cols, rows = args.sheet
            per = cols * rows
            for k, sheet in enumerate(make_sheets(ffmpeg, tmp, len(made), cols, rows)):
                if sheet.is_file():
                    ready.append(fit_for_viewing(ffmpeg, sheet))
                    sheets.append({"file": ready[-1].name, "frames": names[k * per : (k + 1) * per]})
        listed = []
        for (i, png), name in zip(made, names):
            ready.append(fit_for_viewing(ffmpeg, png.rename(tmp / f"{name}.png")))
            listed.append({"file": ready[-1].name, "at": round(frames[i][1], 3), "time": clock(frames[i][1]), "why": keep[i]})
        for sheet in sheets:  # the sheets name their frames by file, as saved
            sheet["frames"] = [next((f["file"] for f in listed if f["file"].startswith(n + ".")), n) for n in sheet["frames"]]
        # only now, with the new frames ready, do the earlier run's go: a run that fails leaves them as they were
        for f in ready:
            os.replace(f, out / f.name)
        new = {f.name for f in ready}
        for name in earlier:
            if name not in new and (out / name).is_file():
                (out / name).unlink()
    if not changes:
        warnings.append(f"no screen change reached {args.change:g}: if the screen did change, try a lower --change")
    if dropped:
        warnings.append(f"kept {len(listed)} of {len(listed) + dropped} frames (--max {args.max}); look closer at a part with --at")
    result = {
        "ok": True,
        "file": str(src),
        "out": str(out),
        "length": info["length"],
        "seconds": info["seconds"],
        "frames_in_video": len(frames),
        "changes": changes,
        "frames": listed,
        "sheets": sheets,
        "dropped": dropped,
        "settings": {"max": args.max, "every": args.every, "change": args.change, "width": args.width, "sheet": "x".join(map(str, args.sheet)) if args.sheet else None},
        "warnings": warnings,
    }
    write_text(out / "frames.json", json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    return emit(result, 1 if warnings else 0)


class Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:  # one line, exit 2
        raise Failure(f"{self.prog}: {message}")


def at_least_ten(value: str) -> int:
    n = int(value)
    if n < 10:
        raise argparse.ArgumentTypeError("must be 10 seconds or more")
    return n


def number_between(low: float, high: float, kind: type = float):
    def check(value: str):
        try:
            n = kind(value)
        except ValueError:
            raise argparse.ArgumentTypeError(f"{value!r} isn't a number") from None
        if not low <= n <= high:
            raise argparse.ArgumentTypeError(f"must be from {low:g} to {high:g}")
        return n

    return check


def grid(value: str) -> tuple[int, int]:
    m = re.fullmatch(r"([1-6])x([1-6])", value.strip().lower())
    if not m:
        raise argparse.ArgumentTypeError("give columns x rows, each 1 to 6, e.g. 2x2")
    return int(m.group(1)), int(m.group(2))


def times(value: str) -> list[float]:
    found = [a_time(x) for x in value.split(",") if x.strip()]
    if not found:  # an empty list would run a whole new scan instead
        raise argparse.ArgumentTypeError("give one or more times, e.g. 12.4,2:31.4")
    return found


def main(argv: list[str] | None = None) -> int:
    p = Parser(prog="learn_source.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True, parser_class=Parser)
    e = sub.add_parser("epub", help="an EPUB book to one Markdown file per chapter, in reading order, plus index.json")
    e.add_argument("file")
    e.add_argument("-o", "--out", required=True, help="the folder to write the chapters into")
    e.set_defaults(run=epub)
    h = sub.add_parser("html", help="a saved web page to text")
    h.add_argument("file")
    h.add_argument("-o", "--out", required=True, help="the text file to write")
    h.set_defaults(run=html_cmd)
    s = sub.add_parser("subs", help="subtitles (.srt or .vtt) to timestamped paragraphs")
    s.add_argument("file")
    s.add_argument("-o", "--out", required=True, help="the text file to write")
    s.add_argument("--every", type=at_least_ten, default=60, help="start a new paragraph at least this often, in seconds (default 60)")
    s.set_defaults(run=subs)
    c = sub.add_parser("clean", help="any text file without invisible and direction-control characters")
    c.add_argument("file")
    c.add_argument("-o", "--out", required=True, help="the text file to write")
    c.set_defaults(run=clean_cmd)
    v = sub.add_parser("probe", help="a video's length, size, frame rate and sound, and the frames at 20% and 70% to check it by")
    v.add_argument("file")
    v.add_argument("-o", "--out", required=True, help="the folder to save check-20.png and check-70.png in")
    v.add_argument("--width", type=number_between(160, 7680, int), default=1280, help="the frames' width at most, in pixels (default 1280)")
    v.add_argument("--ffmpeg", help="the folder FFmpeg is in, if it isn't on PATH")
    v.set_defaults(run=probe)
    f = sub.add_parser("frames", help="a screen recording's telling frames: the last before each screen change, and enough others that no long stretch goes without one")
    f.add_argument("file")
    f.add_argument("-o", "--out", required=True, help="the folder for the frames and frames.json (new or empty, or an earlier run's)")
    f.add_argument("--max", type=number_between(2, 500, int), default=30, help="the most frames to keep (default 30)")
    f.add_argument("--every", type=number_between(2, 600), default=20.0, help="at least one frame this often, in seconds (default 20)")
    f.add_argument("--change", type=number_between(0.001, 1), default=0.02, help="how much of the picture must change to count as a new screen, 0 to 1 (default 0.02)")
    f.add_argument("--width", type=number_between(160, 7680, int), default=1280, help="the frames' width at most, in pixels (default 1280)")
    f.add_argument("--sheet", type=grid, help="also tile the frames into contact sheets, columns x rows (e.g. 2x2)")
    f.add_argument("--at", type=times, help="instead, save full-size frames at these times only (12.4,2:31.4)")
    f.add_argument("--ffmpeg", help="the folder FFmpeg is in, if it isn't on PATH")
    f.set_defaults(run=frames_cmd)
    try:
        args = p.parse_args(argv)
        return args.run(args)
    except Failure as e:
        print(str(e), file=sys.stderr)
        return 2
    except (OSError, ElementTree.ParseError, UnicodeError) as e:
        print(f"{type(e).__name__}: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
