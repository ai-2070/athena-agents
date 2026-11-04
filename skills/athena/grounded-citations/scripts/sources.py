#!/usr/bin/env python3
"""Keep a numbered list of the sources a piece of research reads, and check a draft's citations against it.

The sources list is a text file with one line per source:

  [3] https://example.org/report | Title of the page | 2026-11-04 | pages/report.html

that is: the id in brackets; where the source is (a web address, or a file or book as you would write it); its title;
the date it was read (YYYY-MM-DD); and, if its text was saved, that file (relative to the list's folder; .txt, .md or a
saved .html page). The date comes before the file. A title may contain "|". Blank lines and lines starting with # are
skipped. The list can be written by hand with file tools; add does the same from a shell and locks the file, so
helpers working at the same time can share one list.

In a draft, a citation is the id in brackets after what it supports ("water.[3]", two sources as "[3][5]"), and
[unverified] marks a claim no source was found for. A quotation is three or more words in double quotes ("", “”, „“
or «»), or a blockquote (> lines); it belongs to the ids cited in its sentence (for a blockquote, inside it or on a
line under it that starts with a dash). The Sources block is a heading named Sources or References (or Quellen,
Fuentes, Références, Fonti, Bronnen) and the [id] lines under it.

Commands:
  add       register a source and print its id (a page already in the list keeps its id)
  list      show the sources, and any problems in the list
  render    write the Sources block for the ids a draft cites
  check     check a draft's citations, Sources block and quotations against the list
  coverage  count the draft's sentences with a citation, with [unverified], and with neither

The list's path is --sources, or else the SOURCES_FILE environment variable. Standard library only, Python 3.10 or
newer. Results are JSON on stdout, except that render without --in-place or --out prints the block itself. Exit
codes: 0 done; 1 it ran and found problems, listed in the JSON; 2 it couldn't do the job, and one line on stderr says
why.
"""

from __future__ import annotations

import argparse
import bisect
import codecs
import datetime
import html
import json
import locale
import os
import re
import sys
import tempfile
import time
import unicodedata
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any, Callable, NoReturn
from urllib.parse import urlsplit, urlunsplit


# ---------------------------------------------------------------- shared helpers (as in the pdf skill's scripts)


def utf8_output() -> None:
    # A Windows pipe is cp1252 unless the script says otherwise; titles and quotations often aren't.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


class Fail(Exception):
    """A problem to report in one line and exit 2."""


# What a result also says, gathered while the command runs: an input read in an encoding other than UTF-8.
NOTES: dict[str, Any] = {}


def emit(data: dict[str, Any]) -> None:
    """Print the result on stdout as JSON, with the notes gathered on the way."""
    for key, value in NOTES.items():
        data.setdefault(key, value)
    print(json.dumps(data, ensure_ascii=False, indent=2))


class Parser(argparse.ArgumentParser):
    """argparse, reporting a mistake in the command line in one line with exit code 2, like any other failure."""

    def error(self, message: str) -> NoReturn:
        self.exit(2, f"{self.prog}: {message} (see --help)\n")


def run_job(prog: str, job: Callable[[], int]) -> int:
    """Run a command, and turn whatever stops it into one line on stderr and exit code 2, never a traceback."""
    try:
        return job()
    except Fail as e:
        why = str(e)
    except OSError as e:  # a file open in another program on Windows, a full disk, a folder where a file should go
        where = e.filename2 or e.filename  # for a move into place, the second name is the output
        why = f"{e.strerror or e}" + (f": {where}" if where else "")
    except Exception as e:
        why = f"stopped unexpectedly ({type(e).__name__}: {e})"
    print(f"{prog}: " + " ".join(why.split()), file=sys.stderr)
    return 2


def decode(raw: bytes, path: str) -> str:
    """The text of a file, whichever way Windows PowerShell 5.1 wrote it: > and Out-File write UTF-16, Set-Content
    the ANSI code page, -Encoding utf8 UTF-8 with a byte-order mark."""
    if raw[:2] in (codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE):
        return raw.decode("utf-16", "replace")
    try:
        return raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        ansi = locale.getpreferredencoding(False)
        if codecs.lookup(ansi).name == "utf-8":
            ansi = "cp1252"  # not this machine's code page, so most likely Windows' Western European one
        NOTES.setdefault("encoding_notes", []).append(f"{path} isn't UTF-8; read it as {ansi}")
        return raw.decode(ansi, "replace")


def read_text(path: str, what: str) -> str:
    try:
        with open(path, "rb") as fh:
            return decode(fh.read(), path)
    except OSError as e:
        raise Fail(f"can't read {what} {path}: {e.strerror}") from None


def write_atomic(out: str, write: Callable[[Any], None]) -> None:
    """Write to a temporary file beside the output, then move it into place, so a failure leaves no half file."""
    folder = os.path.dirname(os.path.abspath(out))
    script = os.path.splitext(os.path.basename(__file__))[0]
    fd, tmp = tempfile.mkstemp(prefix=f".{script}-", suffix=".part", dir=folder)
    try:
        with os.fdopen(fd, "wb") as fh:
            write(fh)
        os.replace(tmp, out)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


# ---------------------------------------------------------------- small helpers


def write_text(path: str, text: str, newline: str) -> None:
    """Write UTF-8 text into place. On Windows another program reading the file for a moment makes the move fail,
    so it tries again for a little while."""
    data = text.replace("\n", newline).encode("utf-8")
    for attempt in range(40):
        try:
            write_atomic(path, lambda fh: fh.write(data))
            return
        except PermissionError:
            if attempt == 39 or os.path.isdir(path):
                raise
            time.sleep(0.05)


def problem(kind: str, message: str, **where: Any) -> dict[str, Any]:
    return {"kind": kind, **where, "message": message}


def same_file(a: str, b: str) -> bool:
    if os.path.exists(a) and os.path.exists(b):
        return os.path.samefile(a, b)
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def parse_ids(spec: str) -> list[int]:
    """'1,3-5' -> [1, 3, 4, 5]."""
    out: list[int] = []
    for part in spec.split(","):
        m = re.fullmatch(r"\s*(\d+)\s*(?:-\s*(\d+)\s*)?", part)
        if not m:
            raise Fail(f"--ids takes ids like 1,3-5, not {spec!r}")
        lo, hi = int(m.group(1)), int(m.group(2) or m.group(1))
        if lo < 1 or hi < lo:
            raise Fail(f"--ids takes ids from 1 up, with ranges written low to high, not {spec!r}")
        out.extend(i for i in range(lo, hi + 1) if i not in out)
    return sorted(out)


def check_date(value: str) -> str:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise Fail(f"--accessed takes a date like 2026-11-04, not {value!r}")
    try:
        day = datetime.date.fromisoformat(value)
    except ValueError:
        raise Fail(f"--accessed: {value} isn't a real date") from None
    if day > datetime.date.today() + datetime.timedelta(days=1):
        raise Fail(f"--accessed: {value} is in the future; give the day the source was read")
    return value


# ---------------------------------------------------------------- where a source is


TRACKING = re.compile(r"^(?:utm_\w+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|mc_cid|mc_eid|igshid|yclid|_hsenc|_hsmi)$", re.I)


def web_address(location: str) -> bool:
    return bool(re.match(r"https?://", location, re.I))


def clean_url(url: str) -> str:
    """The address as it goes in the list: scheme and host in lower case, no default port, no tracking parameters,
    no #fragment (except #! and #/ routes, which choose the page)."""
    url = url.strip().replace(" ", "%20").replace("|", "%7C")
    try:
        parts = urlsplit(url)
        port = parts.port
    except ValueError:
        return url
    scheme = parts.scheme.lower()
    host = (parts.hostname or "").rstrip(".")
    if ":" in host:
        host = f"[{host}]"
    if port is not None and (scheme, port) not in (("http", 80), ("https", 443)):
        host += f":{port}"
    query = "&".join(p for p in parts.query.split("&") if p and not TRACKING.match(p.split("=", 1)[0]))
    fragment = parts.fragment if parts.fragment.startswith(("!", "/")) else ""
    return urlunsplit((scheme, host, parts.path or "/", query, fragment))


def location_key(location: str) -> str:
    """Two locations with the same key are the same source: a trailing slash doesn't make another page."""
    if web_address(location):
        url = clean_url(location)
        parts = urlsplit(url)
        path = parts.path.rstrip("/") or "/"
        return urlunsplit((parts.scheme, parts.netloc, path, parts.query, parts.fragment))
    return " ".join(location.split()).casefold()


# ---------------------------------------------------------------- the sources list


LIST_HEADER = "# Sources list: [id] where | title | date read (YYYY-MM-DD) | saved text (optional, relative to this file)"
SOURCE_LINE = re.compile(r"^\s*(?:[-*+]\s+)?\[(\d+)\]\s+(.*?)\s*$")
DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
LOOKS_LIKE_FILE = re.compile(r"\.(?:txt|text|md|markdown|html?|xhtml)$", re.I)


@dataclass
class Source:
    id: int
    location: str
    title: str
    accessed: str
    text: str
    line: int = 0  # its line in the list file, from 1

    def as_line(self) -> str:
        line = f"[{self.id}] {self.location} | {self.title} | {self.accessed}"
        return line + (f" | {self.text}" if self.text else "")


def list_path(args: argparse.Namespace) -> str:
    path = args.sources or os.environ.get("SOURCES_FILE", "").strip()
    if not path:
        raise Fail("give the sources list with --sources (or set the SOURCES_FILE environment variable)")
    return path


def parse_list(text: str) -> tuple[list[Source], list[dict[str, Any]]]:
    sources: list[Source] = []
    problems: list[dict[str, Any]] = []
    for n, raw in enumerate(text.splitlines(), 1):
        if not raw.strip() or raw.strip().startswith("#"):
            continue
        m = SOURCE_LINE.match(raw)
        if not m:
            problems.append(problem("list", "not a source line: write [id] where | title | date read", list_line=n))
            continue
        fields = [f.strip() for f in m.group(2).split("|")]
        location, tail = fields[0], fields[1:]
        title = accessed = text_file = ""
        if len(tail) >= 3 and (DATE.match(tail[-2]) or not tail[-2]):
            title, accessed, text_file = " | ".join(tail[:-2]), tail[-2], tail[-1]
        elif len(tail) >= 2 and (DATE.match(tail[-1]) or not tail[-1]):
            title, accessed = " | ".join(tail[:-1]), tail[-1]
        else:
            title = " | ".join(tail)
            if len(tail) >= 2 and LOOKS_LIKE_FILE.search(tail[-1]):
                problems.append(problem("list", "put the date read before the saved text's file", list_line=n))
        sid = int(m.group(1))
        if sid < 1:
            problems.append(problem("list", "ids start at 1", list_line=n))
        if not location:
            problems.append(problem("list", "the line doesn't say where the source is", list_line=n))
        if accessed:
            try:
                datetime.date.fromisoformat(accessed)
            except ValueError:
                problems.append(problem("list", f"{accessed} isn't a real date", list_line=n))
        sources.append(Source(sid, location, title, accessed, text_file, n))
    return sources, problems


def list_problems(sources: list[Source], folder: str) -> list[dict[str, Any]]:
    problems: list[dict[str, Any]] = []
    by_id: dict[int, Source] = {}
    by_key: dict[str, Source] = {}
    for s in sources:
        if s.id in by_id:
            problems.append(problem("list", f"id [{s.id}] is used twice (lines {by_id[s.id].line} and {s.line})",
                                    list_line=s.line, id=s.id))
        by_id.setdefault(s.id, s)
        key = location_key(s.location)
        if key in by_key and by_key[key].id != s.id:
            first = by_key[key]
            problems.append(problem("list", f"[{first.id}] and [{s.id}] are the same source: keep one id for it",
                                    list_line=s.line, id=s.id))
        by_key.setdefault(key, s)
        if s.text and not os.path.isfile(saved_text_path(s, folder)):
            problems.append(problem("list", f"the saved text of [{s.id}] isn't there: {s.text}", list_line=s.line, id=s.id))
    return problems


def load_list(path: str) -> tuple[list[Source], list[dict[str, Any]], str]:
    text = read_text(path, "the sources list")
    folder = os.path.dirname(os.path.abspath(path))
    sources, problems = parse_list(text)
    return sources, problems + list_problems(sources, folder), folder


def saved_text_path(source: Source, folder: str) -> str:
    return source.text if os.path.isabs(source.text) else os.path.join(folder, source.text)


def recorded_path(path: str, folder: str) -> str:
    """A saved text's path as the list records it: relative to the list's folder when it's inside it."""
    try:
        rel = os.path.relpath(path, folder)
    except ValueError:  # another drive on Windows
        return path
    if rel == os.pardir or rel.startswith(os.pardir + os.sep):
        return path
    return rel.replace(os.sep, "/")


class ListLock:
    """Lets one run at a time change the list: a lock file made with O_EXCL beside it."""

    STALE = 20.0  # a lock this old was left by a run that stopped before removing it (adding takes milliseconds)
    WAIT = 30.0  # seconds to wait for another run; longer than STALE, so a left-over lock is taken over in time

    def __init__(self, path: str) -> None:
        self.path = path + ".lock"
        self.fd: int | None = None

    def __enter__(self) -> ListLock:
        start = time.monotonic()
        while True:
            try:
                self.fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                os.write(self.fd, str(os.getpid()).encode())
                return self
            except FileExistsError:
                pass
            except PermissionError:  # on Windows also while another run's lock is being deleted
                if time.monotonic() - start > self.WAIT and not os.path.exists(self.path):
                    raise  # no lock in the way: the folder can't be written
            try:
                if time.time() - os.stat(self.path).st_mtime > self.STALE:
                    os.remove(self.path)
                    continue
            except OSError:
                pass
            if time.monotonic() - start > self.WAIT:
                raise Fail(f"the sources list is locked by another run ({self.path}); "
                           "if nothing else is adding to it, delete that file")
            time.sleep(0.05)

    def __exit__(self, *_: object) -> None:
        if self.fd is not None:
            os.close(self.fd)
        try:
            os.remove(self.path)
        except OSError:
            pass


# ---------------------------------------------------------------- saved texts and quotations


class PageText(HTMLParser):
    """The readable text of a saved web page: no scripts, styles or head, a line break at each block."""

    SKIP = {"script", "style", "noscript", "template", "svg", "iframe", "object"}
    BLOCK = {"address", "article", "aside", "blockquote", "br", "caption", "dd", "div", "dl", "dt", "figcaption",
             "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav",
             "ol", "p", "pre", "section", "table", "td", "th", "tr", "ul"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip = 0
        self.head = False  # the page's <head>, which ends at </head> or at <body> when </head> is left out

    def handle_starttag(self, tag: str, attrs: Any) -> None:
        if tag in ("head", "body"):
            self.head = tag == "head"
        elif tag in self.SKIP:
            self.skip += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag == "head":
            self.head = False
        elif tag in self.SKIP:
            self.skip = max(0, self.skip - 1)
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.skip and not self.head:
            self.parts.append(data)


def html_to_text(page: str) -> str:
    parser = PageText()
    parser.feed(page)
    parser.close()
    lines = (" ".join(line.split()) for line in "".join(parser.parts).splitlines())
    return "\n".join(line for line in lines if line)


def read_saved_text(path: str) -> str:
    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError as e:
        raise Fail(f"can't read the saved text {path}: {e.strerror}") from None
    if raw.startswith(b"%PDF"):
        raise Fail(f"{path} is a PDF: save its text as a .txt file first")
    if raw.startswith(b"PK\x03\x04"):
        raise Fail(f"{path} is a packed document (Word, Excel, an archive): save its text as a .txt file first")
    utf16 = raw[:2] in (codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE)
    if not utf16 and b"\x00" in raw[:4096]:
        raise Fail(f"{path} isn't a text file")
    is_html = path.lower().endswith((".htm", ".html", ".xhtml")) or re.match(rb"\s*<(?:!doctype html|html)", raw[:2048], re.I)
    if is_html and not utf16:
        try:
            raw.decode("utf-8")
        except UnicodeDecodeError:
            m = re.search(rb"charset\s*=\s*[\"']?([\w.:-]+)", raw[:4096], re.I)
            if m:
                try:
                    return html_to_text(raw.decode(codecs.lookup(m.group(1).decode("ascii")).name, "replace"))
                except LookupError:
                    pass
    text = decode(raw, path)
    return html_to_text(text) if is_html else text


PUNCT = str.maketrans({
    "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'", "\u2032": "'",
    "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u201f": '"', "\u2033": '"', "\u00ab": '"', "\u00bb": '"',
    "\u2010": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2015": "-", "\u2212": "-",
    "\u00ad": None, "\u200b": None, "\u200c": None, "\u200d": None, "\u2060": None, "\ufeff": None,
})
MD_IMAGE = re.compile(r"!\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)")
MD_LINK = re.compile(r"\[([^\]]*)\]\((?:[^()]|\([^()]*\))*\)")
MD_REF_LINK = re.compile(r"\[([^\]]+)\]\[[^\]]*\]")
AUTOLINK = re.compile(r"<((?:https?|mailto):[^>\s]*)>", re.I)
HTML_TAG = re.compile(r"</?[A-Za-z][^>]*>")
BRACKETED = re.compile(r"\[[^\]\n]{0,40}\]")  # footnote marks like [3] or [citation needed], which readers skip
LINE_MARKS = re.compile(r"(?m)^[ \t]*(?:(?:>[ \t]?)+|#{1,6}[ \t]+|[-*+][ \t]+)")
ESCAPED = re.compile(r"\\([!-/:-@\[-`{-~])")
EMPHASIS = re.compile(r"[*_`~]")
HYPHEN_BREAK = re.compile(r"(\w)-[ \t]*\r?\n[ \t]*(\w)")
GAP = re.compile(r"\s*(?:\[\s*(?:\.\.\.|…)\s*\]|\(\s*(?:\.\.\.|…)\s*\)|\.\.\.|…|\[[^\]]*\])\s*")


def plain(text: str) -> str:
    """Text as a reader sees it, with Markdown, HTML and typographic differences taken out."""
    t = unicodedata.normalize("NFKC", text).translate(PUNCT)
    if "&" in t:
        t = html.unescape(t)
    t = MD_IMAGE.sub(r"\1", t)
    t = MD_LINK.sub(r"\1", t)
    t = MD_REF_LINK.sub(r"\1", t)
    t = AUTOLINK.sub(r"\1", t)
    t = HTML_TAG.sub("", t)
    t = BRACKETED.sub("", t)
    t = LINE_MARKS.sub("", t)
    t = ESCAPED.sub(r"\1", t)
    return EMPHASIS.sub("", t)


def squash(text: str) -> str:
    t = " ".join(text.split())
    t = re.sub(r"\s+([,.;:!?)\]])", r"\1", t)
    return re.sub(r"([(\[])\s+", r"\1", t).casefold()


def match_forms(text: str) -> list[str]:
    """A saved text in the forms a quotation is looked for in: a word broken at a line end ("repre-/sentation") is
    tried joined and with its hyphen."""
    t = plain(text)
    return [squash(HYPHEN_BREAK.sub(r"\1\2", t)), squash(HYPHEN_BREAK.sub(r"\1-\2", t))]


def quote_pieces(quote: str) -> list[str]:
    """The parts of a quotation that must appear in order: an ellipsis or [an insertion] leaves a gap."""
    pieces = []
    for part in GAP.split(quote):
        key = squash(plain(part)).strip(" .,;:!?\"'")
        if key:
            pieces.append(key)
    return pieces


def find_word_run(text: str, piece: str, at: int) -> int:
    """Where piece starts in text at or after at, beginning and ending on word edges; -1 if it doesn't."""
    i = text.find(piece, at)
    while i >= 0:
        end = i + len(piece)
        if (i == 0 or not (text[i - 1].isalnum() and piece[0].isalnum())) and \
                (end == len(text) or not (text[end].isalnum() and piece[-1].isalnum())):
            return i
        i = text.find(piece, i + 1)
    return -1


def find_quote(pieces: list[str], forms: list[str]) -> bool:
    for text in forms:
        at = 0
        for piece in pieces:
            i = find_word_run(text, piece, at)
            if i < 0:
                break
            at = i + len(piece)
        else:
            return True
    return False


def longest_run(words: list[str], text: str, from_end: bool) -> int:
    """How many words from the start (or the end) of words the text has, as a run on word edges."""
    lo, hi = 0, len(words)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        run = words[len(words) - mid:] if from_end else words[:mid]
        if find_word_run(text, " ".join(run), 0) >= 0:
            lo = mid
        else:
            hi = mid - 1
    return lo


def mismatch_hint(pieces: list[str], text: str) -> str:
    """Where the quotation and the saved text part ways, so a misquoted word or figure shows."""
    for piece in pieces:
        if find_word_run(text, piece, 0) >= 0:
            continue
        words = piece.split(" ")
        head, tail = longest_run(words, text, False), longest_run(words, text, True)
        if not head and not tail:
            return "nothing in the saved text starts or ends like it"
        if tail > head:  # anchor on the end the text has, and show what comes before it in each
            run = " ".join(words[-tail:])
            at = find_word_run(text, run, 0)
            said = " ".join(text[:at].split()[-4:] + words[-tail:][:3])
            quoted = " ".join(words[max(0, len(words) - tail - 4):len(words) - tail] + words[-tail:][:3])
        else:
            run = " ".join(words[:head])
            at = find_word_run(text, run, 0) + len(run)
            said = " ".join(words[:head][-3:] + text[at:at + 120].split()[:4])
            quoted = " ".join(words[:head][-3:] + words[head:head + 4])
        return f'the saved text has "{said}" where the quotation has "{quoted}"'
    return "its parts are in the saved text, but not in this order"


# ---------------------------------------------------------------- reading a draft


HEADING = re.compile(r"^\s{0,3}(?:#{1,6}\s+)?(?:\*\*|__)?(?:sources|references|quellen|fuentes|références|fonti|bronnen)"
                     r"(?:\*\*|__)?:?(?:\*\*|__)?\s*$", re.I)
ENTRY = re.compile(r"^\s{0,3}(?:[-*+]\s+)?\[(\d{1,5})\]\s+(.*)$")
FENCE = re.compile(r"^\s{0,3}(`{3,}|~{3,})")
MARKER = re.compile(r"(?<![\\!])\[(\d{1,5})\](?!\()")
MALFORMED = re.compile(r"(?<!\\)\[\s*\d{1,5}\s*(?:[,;–—-]\s*\d{1,5}\s*)+\]")
UNVERIFIED = re.compile(r"\[unverified\]", re.I)
REF_DEFINITION = re.compile(r"^\s{0,3}\[[^\]]+\]:\s")
ATX = re.compile(r"^\s{0,3}#{1,6}(?:\s|$)")
SETEXT = re.compile(r"^\s{0,3}(?:=+|-+)\s*$")
RULE = re.compile(r"^\s{0,3}([-*_])(?:\s*\1){2,}\s*$")
TABLE_DELIM = re.compile(r"^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)+\|?\s*$")
ITEM = re.compile(r"^\s{0,3}(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?")
ATTRIBUTION = re.compile(r"^\s*(?:—|―|--)\s*\S")
IMAGE_LINE = re.compile(r"^\s*!\[[^\]]*\]\([^)]*\)\s*$")
BOUNDARY = re.compile(r"[.!?…]+[\"'”’»)\]*_]*(?:\[(?:\d{1,5}|unverified)\])*(?=\s|$)", re.I)
QUOTE = re.compile(r'"([^"]+)"|“([^”]+)”|„([^“”]+)[“”]|«\s*([^»]+?)\s*»')
IMMEDIATE = re.compile(r"[.,;:!?)*_]*\s?((?:\[\d{1,5}\])+)")
NOT_QUOTED = re.compile(r"\]\((?:[^()]|\([^()]*\))*\)|<[A-Za-z/][^>]*>")  # link addresses and titles, HTML tags


@dataclass
class Block:
    kind: str  # para, item, quote or table
    parts: list[tuple[int, str]]  # (line number from 1, text)
    attribution: str = ""

    def text(self) -> str:
        return " ".join(t for _, t in self.parts)

    def line_at(self, offset: int) -> int:
        starts, at = [], 0
        for _, t in self.parts:
            starts.append(at)
            at += len(t) + 1
        return self.parts[max(0, bisect.bisect_right(starts, offset) - 1)][0]


def ids_in(text: str) -> list[int]:
    return [int(m.group(1)) for m in MARKER.finditer(text)]


def sentence_ends(text: str) -> list[int]:
    """Where each sentence ends (after its citations); a full stop before a small letter ("e.g. the") isn't one."""
    ends = []
    for m in BOUNDARY.finditer(text):
        rest = text[m.end():].lstrip()
        if rest and rest[0].islower():
            continue
        ends.append(m.end())
    if not ends or ends[-1] < len(text.rstrip()):
        ends.append(len(text))
    return ends


def sentences(text: str) -> list[tuple[int, str]]:
    out, start = [], 0
    for end in sentence_ends(text):
        piece = text[start:end].strip()
        if piece:
            out.append((start + len(text[start:end]) - len(text[start:end].lstrip()), piece))
        start = end
    return out


class Draft:
    def __init__(self, text: str) -> None:
        self.text = text
        self.lines = text.splitlines()
        n = len(self.lines)
        skip = [False] * n
        if n and self.lines[0].strip() == "---":  # front matter
            for i in range(1, n):
                if self.lines[i].strip() in ("---", "..."):
                    skip[: i + 1] = [True] * (i + 1)
                    break
        fence = ""
        for i, line in enumerate(self.lines):
            m = FENCE.match(line)
            if fence:
                skip[i] = True
                if m and m.group(1)[0] == fence[0] and len(m.group(1)) >= len(fence) and not line.strip()[len(m.group(1)):].strip():
                    fence = ""
            elif m and not skip[i]:
                skip[i], fence = True, m.group(1)
        kept = "\n".join("" if skip[i] else line for i, line in enumerate(self.lines))
        kept = re.sub(r"<!--.*?-->", lambda m: re.sub(r"[^\n]", " ", m.group(0)), kept, flags=re.S)
        kept = re.sub(r"(`+)(.+?)\1", lambda m: " " * len(m.group(0)), kept)
        clean = kept.split("\n") if n else []
        clean += [""] * (n - len(clean))
        self.block: tuple[int, int] | None = None
        for i in range(n - 1, -1, -1):
            if not skip[i] and HEADING.match(clean[i]):
                end = i + 1
                for j in range(i + 1, n):
                    if ENTRY.match(clean[j]):
                        end = j + 1
                    elif clean[j].strip():
                        break
                self.block = (i, end)
                break
        if self.block:
            for i in range(*self.block):
                clean[i] = ""
        self.clean = clean

    def prose(self) -> list[tuple[int, str]]:
        """(line number from 1, text) of the lines that can carry citations."""
        return [(i + 1, t) for i, t in enumerate(self.clean) if t.strip() and not REF_DEFINITION.match(t)]

    def entries(self) -> list[tuple[int, int, str]]:
        """(line number, id, rest of the line) of the Sources block's entries."""
        if not self.block:
            return []
        found = []
        for i in range(*self.block):
            m = ENTRY.match(self.lines[i])
            if m:
                found.append((i + 1, int(m.group(1)), m.group(2)))
        return found

    def blocks(self) -> list[Block]:
        table = [False] * len(self.clean)
        for i, line in enumerate(self.clean):
            if i and TABLE_DELIM.match(line) and "|" in self.clean[i - 1]:
                table[i - 1] = table[i] = True
                j = i + 1
                while j < len(self.clean) and "|" in self.clean[j] and self.clean[j].strip():
                    table[j] = True
                    j += 1
        out: list[Block] = []
        cur: Block | None = None
        for i, line in enumerate(self.clean):
            n, s = i + 1, line.strip()
            if not s or REF_DEFINITION.match(line):
                cur = None
                continue
            if table[i]:
                cur = None
                if not TABLE_DELIM.match(line):
                    out.append(Block("table", [(n, s)]))
                continue
            if SETEXT.match(line) and cur is not None and cur.kind == "para":
                out.remove(cur)  # the paragraph above was a heading
                cur = None
                continue
            if ATX.match(line) or RULE.match(line) or SETEXT.match(line) or IMAGE_LINE.match(line):
                cur = None
                continue
            if s.startswith(">"):
                body = re.sub(r"^(?:>\s?)+", "", s)
                if cur is None or cur.kind != "quote":
                    cur = Block("quote", [])
                    out.append(cur)
                if body:
                    cur.parts.append((n, body))
                continue
            if cur is not None and cur.kind == "quote" and ATTRIBUTION.match(line):
                cur.attribution = s
                cur = None
                continue
            m = ITEM.match(line)
            if m:
                cur = Block("item", [(n, line[m.end():].strip())])
                out.append(cur)
            elif cur is not None and cur.kind in ("para", "item"):
                cur.parts.append((n, s))
            else:
                cur = Block("para", [(n, s)])
                out.append(cur)
        return [b for b in out if b.parts]


# ---------------------------------------------------------------- commands


def cmd_add(args: argparse.Namespace) -> int:
    path = list_path(args)
    location = " ".join(args.location.split())
    if not location:
        raise Fail("give the source's web address, or where it is")
    if web_address(location):
        location = clean_url(location)
    elif "|" in location:
        raise Fail("a location can't contain |")
    title = " ".join((args.title or "").split())
    accessed = check_date(args.accessed) if args.accessed else datetime.date.today().isoformat()
    folder = os.path.dirname(os.path.abspath(path))
    text_file = ""
    if args.text_file:
        if not os.path.isfile(args.text_file):
            raise Fail(f"no such file: {args.text_file}")
        read_saved_text(args.text_file)  # a PDF or other file the checks can't read is refused now, not later
        text_file = recorded_path(os.path.abspath(args.text_file), folder)
        if "|" in text_file:
            raise Fail(f"the saved text's path can't contain |: {text_file}")
    os.makedirs(folder, exist_ok=True)
    with ListLock(path):
        existing = read_text(path, "the sources list") if os.path.exists(path) else LIST_HEADER + "\n"
        newline = "\r\n" if "\r\n" in existing else "\n"
        lines = existing.splitlines()
        sources, _ = parse_list(existing)
        key = location_key(location)
        found = next((s for s in sources if location_key(s.location) == key), None)
        result: dict[str, Any]
        if found:
            updated = []
            if title and not found.title:
                found.title = title
                updated.append("title")
            if text_file and not found.text:
                found.text = text_file
                updated.append("text")
            if not found.accessed:
                found.accessed = accessed
                updated.append("accessed")
            if updated:
                lines[found.line - 1] = found.as_line()
                write_text(path, "\n".join(lines) + "\n", newline)
            result = {"id": found.id, "new": False, "updated": updated, "line": found.as_line()}
            if text_file and found.text != text_file:
                result["note"] = f"kept the text saved earlier for [{found.id}]: {found.text}"
        else:
            source = Source(max((s.id for s in sources), default=0) + 1, location, title, accessed, text_file)
            lines.append(source.as_line())
            write_text(path, "\n".join(lines) + "\n", newline)
            result = {"id": source.id, "new": True, "line": source.as_line()}
    emit({**result, "sources_list": os.path.abspath(path)})
    return 0


def source_json(s: Source, folder: str) -> dict[str, Any]:
    out: dict[str, Any] = {"id": s.id, "location": s.location, "title": s.title, "accessed": s.accessed}
    if s.text:
        out["text"] = s.text
        out["text_found"] = os.path.isfile(saved_text_path(s, folder))
    return out


def cmd_list(args: argparse.Namespace) -> int:
    path = list_path(args)
    sources, problems, folder = load_list(path)
    emit({"sources_list": os.path.abspath(path), "count": len(sources),
          "sources": [source_json(s, folder) for s in sorted(sources, key=lambda s: s.id)], "problems": problems})
    return 1 if problems else 0


def md_escape(text: str) -> str:
    return re.sub(r"([\\`*_\[\]<>])", r"\\\1", text)


def entry_line(s: Source, style: str) -> str:
    if style == "list":
        where = f"<{s.location}>" if web_address(s.location) else md_escape(s.location)
        title = md_escape(s.title)
    else:
        where, title = s.location, s.title
    line = f"[{s.id}] " + (f"{title} — {where}" if title else where) + (f" (accessed {s.accessed})" if s.accessed else "")
    return f"- {line}" if style == "list" else line


def render_block(picked: list[Source], style: str, heading: str) -> str:
    return "\n".join([heading, ""] + [entry_line(s, style) for s in picked])


def cmd_render(args: argparse.Namespace) -> int:
    if bool(args.draft) == bool(args.ids):
        raise Fail("give a draft, or --ids, but not both")
    if (args.in_place or args.out) and not args.draft:
        raise Fail("--in-place and --out need a draft")
    if args.in_place and args.out:
        raise Fail("give --in-place or --out, not both")
    if args.out and same_file(args.out, args.draft):
        raise Fail("--out is the draft itself: use --in-place to rewrite it")
    asked = parse_ids(args.ids) if args.ids else []
    path = list_path(args)
    sources, list_issues, _ = load_list(path)
    by_id: dict[int, list[Source]] = {}
    for s in sources:
        by_id.setdefault(s.id, []).append(s)
    draft: Draft | None = None
    raw = ""
    if args.draft:
        raw = read_text(args.draft, "the draft")
        draft = Draft(raw)
        wanted = sorted({i for _, line in draft.prose() for i in ids_in(line)})
    else:
        wanted = asked
    problems = []
    if not wanted:
        problems.append(problem("no_citations", "the draft cites no sources: there is nothing to list"))
    for i in wanted:
        if i not in by_id:
            problems.append(problem("unknown_id", f"[{i}] isn't in the sources list", id=i))
        elif len(by_id[i]) > 1:
            problems.append(problem("list", f"[{i}] is used twice in the sources list", id=i))
    if problems:
        emit({"written": None, "problems": problems})
        return 1
    picked = [by_id[i][0] for i in wanted]
    default_heading = "## Sources" if args.style == "list" else "Sources"
    if draft is None or not (args.in_place or args.out):
        heading = draft.lines[draft.block[0]].strip() if draft is not None and draft.block else default_heading
        print(render_block(picked, args.style, heading))
        return 0
    lines = list(draft.lines)
    if draft.block:
        start, end = draft.block
        block = render_block(picked, args.style, lines[start].strip()).split("\n")
        lines[start:end] = block
    else:
        while lines and not lines[-1].strip():
            lines.pop()
        block = render_block(picked, args.style, default_heading).split("\n")
        lines += ([""] if lines else []) + block
    new_text = "\n".join(lines) + "\n"
    out = args.draft if args.in_place else args.out
    newline = "\r\n" if "\r\n" in raw else "\n"
    changed = new_text.replace("\n", newline) != raw or bool(args.out)
    if changed:
        write_text(out, new_text, newline)
    result: dict[str, Any] = {"written": os.path.abspath(out), "changed": changed, "ids": wanted,
                              "heading": block[0], "style": args.style}
    if list_issues:
        result["list_problems"] = list_issues
    emit(result)
    return 0


def check_block(draft: Draft, cited: set[int], by_id: dict[int, Source]) -> list[dict[str, Any]]:
    problems = []
    if cited and not draft.block:
        return [problem("no_sources_block", "the draft cites sources but has no Sources block: run render")]
    listed: dict[int, int] = {}
    for line_no, sid, rest in draft.entries():
        if sid in listed:
            problems.append(problem("block", f"the Sources block lists [{sid}] twice", line=line_no, id=sid))
            continue
        listed[sid] = line_no
        source = by_id.get(sid)
        if source is None:
            problems.append(problem("block", f"the Sources block lists [{sid}], which isn't in the sources list",
                                    line=line_no, id=sid))
            continue
        if sid not in cited:
            problems.append(problem("block", f"the Sources block lists [{sid}], which the text doesn't cite: run render",
                                    line=line_no, id=sid))
        if web_address(source.location):
            urls = re.findall(r"<(https?://[^>\s]+)>|(https?://[^\s<>]+)", rest, re.I)
            found = [(a or b).rstrip(".,;)") for a, b in urls]
            ok = any(location_key(u) == location_key(source.location) for u in found)
        else:
            ok = source.location in rest or md_escape(source.location) in rest
        if not ok:
            problems.append(problem("block", f"[{sid}] in the Sources block doesn't point where the sources list says "
                                    f"({source.location}): run render", line=line_no, id=sid))
    for sid in sorted(cited - set(listed)):
        if sid in by_id:
            problems.append(problem("block", f"[{sid}] is cited but missing from the Sources block: run render", id=sid))
    return problems


def cmd_check(args: argparse.Namespace) -> int:
    path = list_path(args)
    sources, problems, folder = load_list(path)
    by_id = {}
    for s in sources:
        by_id.setdefault(s.id, s)
    draft = Draft(read_text(args.draft, "the draft"))
    notes: list[dict[str, Any]] = []
    cited: set[int] = set()
    for n, line in draft.prose():
        for m in MALFORMED.finditer(line):
            problems.append(problem("marker", f"{m.group(0)}: write each id in its own brackets, like [1][2]", line=n))
        for i in ids_in(line):
            if i not in by_id:
                problems.append(problem("unknown_id", f"[{i}] isn't in the sources list", line=n, id=i))
            cited.add(i)
    problems += check_block(draft, cited, by_id)

    texts: dict[int, list[str] | None] = {}

    def forms(sid: int) -> list[str] | None:
        if sid not in texts:
            texts[sid] = None
            s = by_id.get(sid)
            if s and s.text and os.path.isfile(saved_text_path(s, folder)):
                try:
                    texts[sid] = match_forms(read_saved_text(saved_text_path(s, folder)))
                except Fail as e:
                    problems.append(problem("saved_text", str(e), id=sid))
        return texts[sid]

    tally = {"found": 0, "not_found": 0, "unchecked": 0, "uncited": 0}
    quoted: set[int] = set()
    unverified_claims = 0
    for block in draft.blocks():
        text = block.text()
        if block.kind != "table":
            for start, sentence in sentences(text):
                if UNVERIFIED.search(sentence):
                    unverified_claims += 1
                ids = set(ids_in(sentence))
                if len(ids) > 3:
                    notes.append(problem("crowded", f"one sentence cites {len(ids)} sources: split it so each claim "
                                         "shows its own source", line=block.line_at(start)))
        found_quotes: list[tuple[int, str, list[int], bool]] = []  # (offset, quotation, ids, marked unverified)
        if block.kind == "quote" and text.startswith("[!"):
            pass  # a note box (> [!NOTE]), not a quotation
        elif block.kind == "quote":
            body = MARKER.sub("", UNVERIFIED.sub("", text))
            tail = text + " " + block.attribution
            found_quotes.append((0, body, ids_in(tail), bool(UNVERIFIED.search(tail))))
        else:
            ends = sentence_ends(text)
            searched = NOT_QUOTED.sub(lambda m: "]" + " " * (len(m.group(0)) - 1), text)  # same offsets
            for m in QUOTE.finditer(searched):
                quotation = next(g for g in m.groups() if g is not None)
                if len(re.findall(r"\w+", quotation)) < 3:
                    continue  # a term in quotes, not a quotation
                im = IMMEDIATE.match(text, m.end())
                if im:
                    found_quotes.append((m.start(), quotation, ids_in(im.group(1)), False))
                    continue
                s_end = next((e for e in ends if e >= m.end()), len(text))
                s_start = max([e for e in ends if e <= m.start()], default=0)
                ids = ids_in(text[m.end():s_end]) or ids_in(text[s_start:m.start()])
                marked = not ids and bool(UNVERIFIED.search(text[s_start:s_end]))
                found_quotes.append((m.start(), quotation, ids, marked))
        for offset, quotation, ids, marked in found_quotes:
            line = block.line_at(offset)
            short = " ".join(quotation.split())
            short = short if len(short) <= 120 else short[:117] + "..."
            if not ids:
                tally["uncited"] += 1
                why = ": [unverified] can't stand in for one" if marked else ""
                item = problem("uncited_quote", f'no source is cited for the quotation "{short}"{why}', line=line)
                (problems if args.evidence else notes).append(item)
                continue
            pieces = quote_pieces(quotation)
            known = [(i, forms(i)) for i in ids if i in by_id]
            with_text = [(i, f) for i, f in known if f]
            if not with_text:
                tally["unchecked"] += 1
                item = problem("unchecked_quote", f'the quotation "{short}" can\'t be checked: '
                               f"no saved text for {''.join(f'[{i}]' for i in ids)}", line=line)
                (problems if args.evidence else notes).append(item)
                continue
            hit = [i for i, f in with_text if find_quote(pieces, f)]
            if hit:
                tally["found"] += 1
                quoted.update(hit)
            else:
                tally["not_found"] += 1
                i, f = with_text[0]
                problems.append(problem("quote_not_found", f'the quotation "{short}" isn\'t in the saved text of '
                                        f"{''.join(f'[{j}]' for j, _ in with_text)}: {mismatch_hint(pieces, f[0])}",
                                        line=line, id=i))
    if args.evidence:
        for sid in sorted(cited):
            s = by_id.get(sid)
            if s is None:
                continue
            if not s.text:
                problems.append(problem("no_saved_text", f"[{sid}] has no saved text, so nothing taken from it can be "
                                        "checked", id=sid))
            elif forms(sid) and sid not in quoted:
                problems.append(problem("no_quote", f"[{sid}] is cited, but no quotation from it was checked: quote "
                                        "the words the claim rests on", id=sid))
    emit({"draft": os.path.abspath(args.draft), "sources_list": os.path.abspath(path), "evidence": args.evidence,
          "ok": not problems, "cited": sorted(cited), "not_cited": sorted(set(by_id) - cited),
          "quotations": tally, "unverified_claims": unverified_claims, "problems": problems, "notes": notes})
    return 1 if problems else 0


def cmd_coverage(args: argparse.Namespace) -> int:
    draft = Draft(read_text(args.draft, "the draft"))
    counts = {"cited": 0, "unverified": 0, "neither": 0}
    uncovered, crowded = [], []
    for block in draft.blocks():
        if block.kind == "table":
            continue
        credited = ids_in(block.attribution)  # a blockquote's source is often on the line under it
        for start, sentence in sentences(block.text()):
            words = re.findall(r"\w+", MARKER.sub("", UNVERIFIED.sub("", sentence)))
            if len(words) < 4:
                continue
            ids = ids_in(sentence) or credited
            if ids:
                counts["cited"] += 1
                if len(set(ids)) > 3:
                    crowded.append({"line": block.line_at(start), "ids": sorted(set(ids))})
            elif UNVERIFIED.search(sentence):
                counts["unverified"] += 1
            else:
                counts["neither"] += 1
                short = sentence if len(sentence) <= 160 else sentence[:157] + "..."
                uncovered.append({"line": block.line_at(start), "text": short})
    per_source: dict[int, int] = {}
    for _, line in draft.prose():
        for i in ids_in(line):
            per_source[i] = per_source.get(i, 0) + 1
    total = sum(counts.values())
    result: dict[str, Any] = {
        "draft": os.path.abspath(args.draft), "sentences": total, **counts,
        "cited_share": round(counts["cited"] / total, 2) if total else None,
        "declared_share": round((counts["cited"] + counts["unverified"]) / total, 2) if total else None,
        "citations_per_source": {str(k): per_source[k] for k in sorted(per_source)},
        "uncovered": uncovered, "crowded": crowded,
        "counted": "sentences of four or more words in paragraphs, list items and blockquotes; headings, tables, "
                   "code and the Sources block aren't counted",
    }
    if args.sources or os.environ.get("SOURCES_FILE", "").strip():
        sources, _, _ = load_list(list_path(args))
        result["never_cited"] = sorted({s.id for s in sources} - set(per_source))
    emit(result)
    return 0


# ---------------------------------------------------------------- command line


def build_parser() -> argparse.ArgumentParser:
    p = Parser(prog="sources.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", metavar="COMMAND")
    lst = argparse.ArgumentParser(add_help=False)
    lst.add_argument("--sources", help="the sources list (default: the SOURCES_FILE environment variable)")

    def add(name: str, func: Callable[[argparse.Namespace], int], help_text: str, example: str) -> argparse.ArgumentParser:
        sp = sub.add_parser(name, parents=[lst], help=help_text, description=help_text,
                            epilog=f"example:\n  {example}", formatter_class=argparse.RawDescriptionHelpFormatter)
        sp.set_defaults(func=func)
        return sp

    sp = add("add", cmd_add, "Register a source and print its id as JSON. A source already in the list (the same "
             "address, ignoring #fragments, tracking parameters and a trailing slash) keeps its id, and gets a title, "
             "date or saved text it didn't have. Creates the list if it isn't there.",
             "python sources.py add --sources research-work/sources.txt 'https://example.org/report' "
             "--title \"Annual report 2025\" --text-file research-work/pages/report.html")
    sp.add_argument("location", help="the web address (or where the source is, as you'd write it for a reader)")
    sp.add_argument("--title", help="the source's title, as it gives it")
    sp.add_argument("--accessed", help="the date it was read, YYYY-MM-DD (default: today)")
    sp.add_argument("--text-file", help="a file holding the source's text (.txt, .md, or a saved .html page), "
                    "for checking quotations")

    add("list", cmd_list, "Show the sources as JSON, and any problems in the list (a line that doesn't read as a "
        "source, an id used twice, one source under two ids, a date that isn't real, a saved text that isn't there).",
        "python sources.py list --sources research-work/sources.txt")

    sp = add("render", cmd_render, "Write the Sources block: one entry per id the draft cites, in id order, built "
             "from the list. With --in-place it replaces the draft's Sources block (or adds one at the end), and "
             "running it again changes nothing; with --out it writes the draft with its block to another file; with "
             "neither it prints the block. It keeps the draft's own heading, or uses '## Sources'. Writes nothing "
             "while the draft cites an id the list doesn't have.",
             "python sources.py render research-work/report.md --sources research-work/sources.txt --in-place")
    sp.add_argument("draft", nargs="?", help="the draft (Markdown or plain text)")
    sp.add_argument("--ids", help="instead of a draft: print the block for these ids, like 1,3-5")
    sp.add_argument("--style", choices=["list", "lines"], default="list",
                    help="'list': Markdown bullets with linked addresses (default); "
                    "'lines': plain lines, for slides, sheets and plain text")
    sp.add_argument("--in-place", action="store_true", help="rewrite the draft's Sources block")
    sp.add_argument("-o", "--out", help="write the draft with its Sources block to this file")

    sp = add("check", cmd_check, "Check a draft against the list: every id it cites is in the list; ids are written "
             "one to a bracket; the Sources block lists exactly the cited ids, pointing where the list says; each "
             "quotation is in the saved text of a source its sentence cites, word for word once Markdown, HTML, "
             "curly quotes, case and line breaks are set aside ('...' or [brackets] in a quotation leave a gap). "
             "Exits 1 when there are problems; notes are for reading, not failures.",
             "python sources.py check research-work/report.md --sources research-work/sources.txt --evidence")
    sp.add_argument("draft", help="the draft (Markdown or plain text)")
    sp.add_argument("--evidence", action="store_true",
                    help="fact-checking: every cited source needs a saved text and a checked quotation, and a "
                    "quotation with no citation, or none that can be checked, is a problem")

    sp = add("coverage", cmd_coverage, "Count the draft's sentences that cite a source, that are marked "
             "[unverified], and that have neither (listed with their lines), how often each source is cited, and "
             "sentences citing more than three. A figure to read, not a pass mark: it never exits 1.",
             "python sources.py coverage research-work/report.md --sources research-work/sources.txt")
    sp.add_argument("draft", help="the draft (Markdown or plain text)")
    return p


def main(argv: list[str] | None = None) -> int:
    utf8_output()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.error("needs a command, such as add")
    return run_job(f"sources.py {args.command}", lambda: args.func(args))


if __name__ == "__main__":
    sys.exit(main())
