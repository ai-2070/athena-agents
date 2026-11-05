#!/usr/bin/env python3
"""Turn a source into plain text an agent can read a piece at a time, for the learn skill.

  learn_source.py epub BOOK.epub -o learn-work/book      one Markdown file per chapter, in reading order, and index.json
  learn_source.py html PAGE.html -o learn-work/page.md   a saved web page as Markdown-ish text
  learn_source.py subs VIDEO.srt -o learn-work/talk.md   subtitles (.srt or .vtt) as timestamped paragraphs
  learn_source.py clean NOTES.txt -o learn-work/notes.md  any text file, without invisible and direction-control characters

Every command strips characters that are invisible or change the reading direction (zero-width, bidi controls, tag
characters): they can make a text read one way to a person and another to an agent. The JSON on stdout says how many.

Python 3.10 or newer, standard library only. Exit codes: 0 done; 1 done, with something to look at (a chapter with no
text, a DRM-locked book: see "warnings"); 2 couldn't do it (one line on stderr).
"""

from __future__ import annotations

import argparse
import html
import json
import locale
import os
import re
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


class Parser(argparse.ArgumentParser):
    def error(self, message: str) -> None:  # one line, exit 2
        raise Failure(f"{self.prog}: {message}")


def at_least_ten(value: str) -> int:
    n = int(value)
    if n < 10:
        raise argparse.ArgumentTypeError("must be 10 seconds or more")
    return n


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
