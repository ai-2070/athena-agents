#!/usr/bin/env python3
"""A YouTube video's captions as text, with timestamps: for the user's own reading, notes and write-ups.

Commands:
  id      the video id, its link and the start time a link carries, from a link in any form (no network)
  list    the transcripts a video has: language, made by a person or auto-generated, translatable
  get     one transcript, in a language you choose or as YouTube's translation, as timed text, text or JSON
  pasted  a transcript the user copied from YouTube's "Show transcript" panel into a file, in the same shapes

Packages: youtube-transcript-api 1.2 or newer, for list and get (it brings requests and defusedxml). It reads
captions through the undocumented endpoint YouTube's own player uses, so this asks YouTube about one video per run,
from this computer, with no proxies and no retries. When YouTube refuses, the script says so and stops.

Results are JSON on stdout. Exit codes: 0 done; 1 the transcript YouTube sent was empty (the JSON says so, and no
file is written); 2 it couldn't do the job, and one line on stderr says why.
"""

from __future__ import annotations

import argparse
import codecs
import importlib
import importlib.metadata
import json
import locale
import logging
import math
import os
import re
import sys
import tempfile
import urllib.parse
from typing import Any, Callable, NoReturn

USER_AGENT = "AthenaAgents/1.0 (youtube_transcript)"
MIN_LIBRARY = (1, 2)


# ---------------------------------------------------------------- helpers (as in the pdf skill's scripts)


def utf8_output() -> None:
    # A Windows pipe is cp1252 unless the script says otherwise; captions and titles often aren't.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


class Fail(Exception):
    """A problem to report in one line and exit 2."""


# What a result also says, gathered while the command runs: how an input file was read, warnings libraries logged.
NOTES: dict[str, Any] = {}


def emit(data: dict[str, Any]) -> None:
    """Print the result on stdout as JSON, with the notes gathered on the way."""
    for key, value in NOTES.items():
        data.setdefault(key, value)
    print(json.dumps(data, ensure_ascii=False, indent=2))


class LibraryWarnings(logging.Handler):
    """Puts what the libraries and Python's warnings log into the result, and keeps it off stderr, which carries only
    the one line saying why a command failed."""

    def __init__(self) -> None:
        super().__init__(logging.WARNING)

    def emit(self, record: logging.LogRecord) -> None:
        message = " ".join(record.getMessage().split())
        found = NOTES.setdefault("library_warnings", [])
        if message not in found:
            found.append(message)


class Parser(argparse.ArgumentParser):
    """argparse, reporting a mistake in the command line in one line with exit code 2, like any other failure."""

    def error(self, message: str) -> NoReturn:
        self.exit(2, f"{self.prog}: {message} (see --help)\n")


def run_job(prog: str, job: Callable[[], int]) -> int:
    """Run a command, and turn whatever stops it into one line on stderr and exit code 2, never a traceback."""
    logging.getLogger().addHandler(LibraryWarnings())
    logging.captureWarnings(True)
    try:
        return job()
    except Fail as e:
        why = str(e)
    except OSError as e:  # a file open in another program on Windows, a full disk, a folder where a file should go
        where = e.filename2 or e.filename
        why = f"{e.strerror or e}" + (f": {where}" if where else "")
    except Exception as e:
        why = f"stopped unexpectedly ({type(e).__name__}: {e})"
    print(f"{prog}: " + " ".join(why.split()), file=sys.stderr)
    return 2


def decode(raw: bytes, path: str) -> tuple[str, str]:
    """The text of a file and how it was read, whichever way it was saved: Windows PowerShell 5.1's > and Out-File
    write UTF-16, Set-Content the ANSI code page, -Encoding utf8 UTF-8 with a byte-order mark."""
    if raw[:2] in (codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE):
        return raw.decode("utf-16", "replace"), "utf-16"
    try:
        return raw.decode("utf-8-sig"), "utf-8"
    except UnicodeDecodeError:
        ansi = locale.getpreferredencoding(False)
        if codecs.lookup(ansi).name == "utf-8":
            ansi = "cp1252"  # not this machine's code page, so most likely Windows' Western European one
        NOTES.setdefault("encoding_notes", []).append(f"{path} isn't UTF-8; read it as {ansi}")
        return raw.decode(ansi, "replace"), ansi


def same_file(a: str, b: str) -> bool:
    if os.path.exists(a) and os.path.exists(b):
        return os.path.samefile(a, b)
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def check_output(out: str, inputs: list[str], overwrite: bool) -> None:
    if os.path.isdir(out):
        raise Fail(f"{out} is a folder: give a file name inside it, such as {os.path.join(out, 'transcript.txt')}")
    for src in inputs:
        if same_file(out, src) and not overwrite:
            raise Fail(f"won't write over the input {src}: give another output path, or add --overwrite to replace it")
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)


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


# ---------------------------------------------------------------- links

VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}")
PATH_KINDS = ("shorts", "embed", "live", "v", "e")  # /shorts/<id>, /embed/<id>, /live/<id>, and the old /v/ and /e/


def on_youtube(host: str | None) -> bool:
    host = (host or "").lower().rstrip(".")
    return any(host == d or host.endswith("." + d) for d in ("youtube.com", "youtube-nocookie.com", "youtu.be"))


def seconds_from(value: str | None) -> int | None:
    """A link's start time, written 95, 95s, 1m35s or 1h2m3s, in seconds."""
    if not value:
        return None
    m = re.fullmatch(r"(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?", value.strip().lower())
    if not m or not any(m.groups()):
        return None
    h, mi, s = (int(g) if g else 0 for g in m.groups())
    return h * 3600 + mi * 60 + s


def parse_video(text: str) -> tuple[str, int | None]:
    """(video id, start seconds or None) from a watch, youtu.be, shorts, embed or live link, or a bare id."""
    s = text.strip().strip("<>\"'")
    if VIDEO_ID.fullmatch(s):
        return s, None
    if not re.match(r"^[a-z][a-z0-9+.-]*://", s, re.I):
        s = "https://" + s
    parts = urllib.parse.urlsplit(s)
    if parts.scheme.lower() not in ("http", "https") or not on_youtube(parts.hostname):
        raise Fail(f"not a YouTube video link or id: {text.strip()}")
    host = (parts.hostname or "").lower()
    query = urllib.parse.parse_qs(parts.query)
    path = [p for p in parts.path.split("/") if p]
    found: str | None = None
    if host == "youtu.be" or host.endswith(".youtu.be"):
        found = path[0] if path else None
    elif path[:1] == ["watch"]:
        found = (query.get("v") or [None])[0]
    elif len(path) >= 2 and path[0].lower() in PATH_KINDS:
        found = path[1]
    elif path[:1] == ["playlist"] or (not path and "list" in query):
        raise Fail("that's a playlist link: give the link of one video in it")
    elif path and (path[0].startswith("@") or path[0] in ("channel", "c", "user")):
        raise Fail("that's a channel link: give the link of one of its videos")
    if not found or not VIDEO_ID.fullmatch(found):
        raise Fail(f"can't find a video id in {text.strip()}: a YouTube video id has 11 letters, digits, - or _")
    fragment = urllib.parse.parse_qs(parts.fragment)
    start = seconds_from((query.get("t") or query.get("start") or fragment.get("t") or [None])[0])
    return found, start


def watch_url(video_id: str) -> str:
    return f"https://www.youtube.com/watch?v={video_id}"


def clock(seconds: float) -> str:
    """Seconds as YouTube shows a time: 4:05, or 1:02:03 past an hour."""
    total = int(seconds)
    h, rest = divmod(total, 3600)
    m, s = divmod(rest, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


# ---------------------------------------------------------------- talking to YouTube

BLOCKED = ("YouTube is refusing requests from this computer for now{why}. Stop here: don't retry, and don't use a "
           "proxy or another way around it. The user can open the video, click Show transcript in its description, "
           "copy the text into a file, and run the pasted command on it")


class LeftYouTube(Exception):
    """YouTube sent a request on to another site, which the script doesn't follow."""

    def __init__(self, url: str) -> None:
        super().__init__(url)
        self.url = url


def library() -> Any:
    try:
        yta = importlib.import_module("youtube_transcript_api")
    except ImportError:
        raise Fail("needs the Python package youtube-transcript-api: python -m pip install youtube-transcript-api") from None
    try:
        version = importlib.metadata.version("youtube-transcript-api")
    except importlib.metadata.PackageNotFoundError:
        return yta
    numbers = tuple(int(n) for n in re.findall(r"\d+", version)[:2])
    if numbers < MIN_LIBRARY:
        raise Fail(f"needs youtube-transcript-api 1.2 or newer (this is {version}), as YouTube changed how captions "
                   "are read: python -m pip install --upgrade youtube-transcript-api")
    return yta


def make_session(timeout: float) -> Any:
    requests = importlib.import_module("requests")

    class YouTubeSession(requests.Session):  # type: ignore[misc, name-defined]
        """Every request gets a timeout and an honest User-Agent, redirects stay on YouTube, and the player's answer
        (which also carries the title, channel and length) is kept."""

        details: dict[str, Any] = {}

        def request(self, method: str, url: str, *args: Any, **kwargs: Any) -> Any:
            kwargs.setdefault("timeout", timeout)
            response = super().request(method, url, *args, **kwargs)
            if "/youtubei/v1/player" in url and response.ok:
                try:
                    found = response.json().get("videoDetails")
                except ValueError:
                    found = None
                if isinstance(found, dict):
                    self.details = found
            return response

        def get_redirect_target(self, resp: Any) -> Any:
            target = super().get_redirect_target(resp)
            if target:
                absolute = urllib.parse.urljoin(resp.url, target)
                if not on_youtube(urllib.parse.urlsplit(absolute).hostname):
                    raise LeftYouTube(absolute)
            return target

    session = YouTubeSession()
    session.headers["User-Agent"] = USER_AGENT
    return session


def explain(e: BaseException, yta: Any, video_id: str, timeout: float) -> str:
    """One line for a failure, in plain words. The library's own messages suggest proxies, so none is passed on."""
    requests = importlib.import_module("requests")
    if isinstance(e, LeftYouTube):
        where = urllib.parse.urlsplit(e.url)
        if where.path.startswith("/sorry"):
            return BLOCKED.format(why=" (it sent the request to a captcha page)")
        return f"YouTube sent the request on to {where.hostname}, which this script doesn't follow"
    if isinstance(e, yta.RequestBlocked):  # IpBlocked too: a captcha page, a 429, or "confirm you're not a bot"
        return BLOCKED.format(why="")
    if isinstance(e, yta.AgeRestricted):
        return ("the video is age-restricted, and YouTube shows those captions only to a signed-in viewer: the user "
                "can open it, click Show transcript in its description and copy the text")
    if isinstance(e, (yta.VideoUnavailable, yta.InvalidVideoId)):
        return f"video {video_id} is unavailable: it was removed or made private, or the id is wrong"
    if isinstance(e, yta.VideoUnplayable):
        why = "; ".join(r.strip() for r in [e.reason or "no reason given", *e.sub_reasons] if r and r.strip())
        return f"YouTube won't play video {video_id} here: {why}"
    if isinstance(e, yta.TranscriptsDisabled):
        return f"video {video_id} has no captions: none were made, or its owner turned them off"
    if isinstance(e, yta.PoTokenRequired):
        return ("YouTube wants a proof-of-origin token for these captions, which this script can't give: the user can "
                "open the video, click Show transcript and copy the text")
    if isinstance(e, yta.YouTubeRequestFailed):
        reason = re.sub(r" for url: \S+", "", str(getattr(e, "reason", "") or "")).strip()
        return f"YouTube answered with an error ({reason or 'no details'})"
    if isinstance(e, (yta.YouTubeDataUnparsable, yta.FailedToCreateConsentCookie)):
        return ("couldn't read YouTube's answer; YouTube may have changed it, and a newer youtube-transcript-api may "
                "read it (python -m pip install --upgrade youtube-transcript-api)")
    if isinstance(e, requests.exceptions.Timeout):
        return f"YouTube didn't answer within {timeout:g} seconds"
    if isinstance(e, requests.exceptions.ConnectionError):
        return "couldn't reach YouTube: check the internet connection"
    if type(e).__name__ == "ParseError":  # an empty caption file, which YouTube sends when it's limiting requests
        return BLOCKED.format(why=" (it sent an empty caption file)")
    if isinstance(e, yta.CouldNotRetrieveTranscript):
        return f"couldn't get the transcript of video {video_id} ({type(e).__name__})"
    raise e


def kind_of(track: Any) -> str:
    return "auto-generated" if track.is_generated else "manual"


def describe(track: Any) -> str:
    return f"{track.language_code} ({kind_of(track)})"


def base(code: str) -> str:
    return code.split("-")[0].lower()


def choose(tracks: list[Any], wanted: list[str], notes: list[str]) -> Any:
    """The transcript to fetch. Asked-for languages in order, a person's transcript before YouTube's automatic one;
    with none asked for, the language YouTube's automatic captions are in, which is the one spoken."""
    if wanted:
        for code in wanted:
            near = [t for t in tracks if base(t.language_code) == base(code)]  # en asked: en, en-GB, en-US
            if near:
                pick = min(near, key=lambda t: (t.is_generated, t.language_code.lower() != code.lower()))
                if code != wanted[0]:
                    notes.append(f"no transcript in {', '.join(wanted[:wanted.index(code)])}; took {describe(pick)}")
                elif pick.language_code.lower() != code.lower():
                    notes.append(f"took {describe(pick)} for {code}")
                return pick
        have = ", ".join(describe(t) for t in tracks)
        hint = ""
        translatable = next((t for t in tracks if t.is_translatable), None)
        if translatable is not None and wanted[0] in {x.language_code for x in translatable.translation_languages}:
            hint = f"; YouTube can translate one into {wanted[0]} (--translate {wanted[0]})"
        raise Fail(f"no transcript in {', '.join(wanted)}: this video has {have}{hint}")
    spoken = next((t.language_code for t in tracks if t.is_generated), None)
    if spoken:
        same = [t for t in tracks if base(t.language_code) == base(spoken)]
        return same[0]
    return tracks[0]


def fetch_list(args: argparse.Namespace) -> tuple[Any, Any, Any, str]:
    yta = library()
    video_id, _ = parse_video(args.video)
    session = make_session(args.timeout)
    api = yta.YouTubeTranscriptApi(http_client=session)
    try:
        listing = api.list(video_id)
    except Exception as e:
        raise Fail(explain(e, yta, video_id, args.timeout)) from None
    return yta, session, listing, video_id


def video_facts(video_id: str, details: dict[str, Any]) -> dict[str, Any]:
    facts: dict[str, Any] = {"video_id": video_id, "url": watch_url(video_id)}
    if details.get("title"):
        facts["title"] = details["title"]
    if details.get("author"):
        facts["channel"] = details["author"]
    if str(details.get("lengthSeconds", "")).isdigit() and int(details["lengthSeconds"]) > 0:
        facts["length"] = clock(int(details["lengthSeconds"]))
    return facts


# ---------------------------------------------------------------- the transcript's shapes


def clean(text: str) -> str:
    return " ".join(text.split())


def render(segments: list[dict[str, Any]], fmt: str, summary: dict[str, Any]) -> str:
    if fmt == "timed":
        return "".join(f"[{clock(s['start'])}] {s['text']}\n" for s in segments)
    if fmt == "text":
        return "".join(f"{s['text']}\n" for s in segments)
    return json.dumps({**summary, "segments": segments}, ensure_ascii=False, indent=1) + "\n"


def deliver(segments: list[dict[str, Any]], summary: dict[str, Any], args: argparse.Namespace) -> int:
    """Write the transcript to --out or print it, with what it is."""
    summary["format"] = args.format
    summary["segment_count"] = len(segments)
    summary["characters"] = sum(len(s["text"]) for s in segments)
    if not segments:
        summary["problems"] = ["the transcript is empty: there is no text to read"]
        emit(summary)
        return 1
    last = segments[-1]
    summary["ends_at"] = clock(last["start"] + (last.get("duration") or 0))
    body = render(segments, args.format, summary)
    if args.out:
        write_atomic(args.out, lambda fh: fh.write(body.encode("utf-8")))
        summary["out"] = os.path.abspath(args.out)
        summary["lines"] = body.count("\n")
        emit(summary)
    elif args.format == "json":
        emit({**summary, "segments": segments})
    else:
        emit({**summary, "text": body})
    return 0


# ---------------------------------------------------------------- commands


def cmd_id(args: argparse.Namespace) -> int:
    video_id, start = parse_video(args.video)
    result: dict[str, Any] = {"video_id": video_id, "url": watch_url(video_id)}
    if start is not None:
        result["starts_at"] = clock(start)
        result["start_seconds"] = start
        result["url_at_start"] = f"{watch_url(video_id)}&t={start}"
    emit(result)
    return 0


def cmd_list(args: argparse.Namespace) -> int:
    _, session, listing, video_id = fetch_list(args)
    tracks = list(listing)
    result = video_facts(video_id, session.details)
    result["transcripts"] = [
        {"language_code": t.language_code, "language": t.language, "kind": kind_of(t), "translatable": t.is_translatable}
        for t in tracks
    ]
    result["spoken_language"] = next((t.language_code for t in tracks if t.is_generated), None)
    source = next((t for t in tracks if t.is_translatable), None)
    result["translation_languages"] = {x.language_code: x.language for x in source.translation_languages} if source else {}
    emit(result)
    return 0


def cmd_get(args: argparse.Namespace) -> int:
    if args.out:
        check_output(args.out, [], False)
    wanted = [c.strip() for c in (args.language or "").split(",") if c.strip()]
    yta, session, listing, video_id = fetch_list(args)
    tracks = list(listing)
    if not tracks:
        raise Fail(f"video {video_id} has no captions: none were made, or its owner turned them off")
    notes: list[str] = []
    track = choose(tracks, wanted, notes)
    translated_from = None
    if args.translate:
        target = args.translate.strip()
        existing = [t for t in tracks if t.language_code.lower() == target.lower()]
        if existing:
            track = existing[0]
            notes.append(f"used the video's own {describe(track)} transcript rather than a machine translation")
        else:
            source = track if track.is_translatable else next((t for t in tracks if t.is_translatable), None)
            if source is None:
                raise Fail("YouTube can't translate this video's transcripts")
            if target not in {x.language_code for x in source.translation_languages}:
                raise Fail(f"YouTube can't translate into {target}: the list command shows the languages it can")
            if source is not track:
                notes.append(f"{describe(track)} can't be translated; translated {describe(source)} instead")
            translated_from = source
            track = source.translate(target)
    try:
        fetched = track.fetch()
    except Exception as e:
        raise Fail(explain(e, yta, video_id, args.timeout)) from None
    segments = [{"start": round(s.start, 3), "duration": round(s.duration, 3), "text": clean(s.text)} for s in fetched]
    segments = [s for s in segments if s["text"]]
    summary = video_facts(video_id, session.details)
    summary["language_code"] = track.language_code
    summary["language"] = track.language
    if translated_from is not None:
        summary["kind"] = "machine-translated"
        summary["translated_from"] = describe(translated_from)
    else:
        summary["kind"] = kind_of(track)
    if summary["kind"] != "manual":
        notes.append("captions made by a machine: no speaker names, often little punctuation, and names and terms misheard")
    summary["other_transcripts"] = [describe(t) for t in tracks if t is not track and t is not translated_from]
    if notes:
        summary["notes"] = notes
    return deliver(segments, summary, args)


STAMP = re.compile(r"^[\[(]?((?:\d{1,2}:)?\d{1,2}:\d{2})[\])]?(?:\s+(.*))?$")
SPOKEN = re.compile(r"^(?:(\d+) hours?,? ?)?(?:(\d+) minutes?,? ?)?(?:(\d+) seconds?)?$")


def stamp_seconds(value: str) -> int:
    parts = [int(p) for p in value.split(":")]
    total = 0
    for p in parts:
        total = total * 60 + p
    return total


def cmd_pasted(args: argparse.Namespace) -> int:
    if args.out:
        check_output(args.out, [args.file], args.overwrite)
    if not os.path.isfile(args.file):
        raise Fail(f"no such file: {args.file}")
    with open(args.file, "rb") as fh:
        text, encoding = decode(fh.read(), args.file)
    segments: list[dict[str, Any]] = []
    skipped: list[str] = []
    just_stamped: int | None = None
    for raw in text.splitlines():
        line = clean(raw)
        if not line:
            continue
        m = STAMP.match(line)
        if m:
            start = stamp_seconds(m.group(1))
            segments.append({"start": start, "text": m.group(2) or ""})
            just_stamped = start
            continue
        spoken = SPOKEN.match(line)
        if just_stamped is not None and spoken and any(spoken.groups()):
            h, mi, s = (int(g) if g else 0 for g in spoken.groups())
            if h * 3600 + mi * 60 + s == just_stamped:  # the panel's spoken form of the time just above
                just_stamped = None
                continue
        just_stamped = None
        if segments:
            segments[-1]["text"] = f"{segments[-1]['text']} {line}".strip()
        else:
            skipped.append(line)
    if not segments:
        raise Fail(f"found no times like 0:00 or 1:02:03 in {args.file}: copy the transcript with its times showing, "
                   "or read the text as it is")
    segments = [s for s in segments if s["text"]]
    summary: dict[str, Any] = {"source": os.path.abspath(args.file), "encoding": encoding}
    if args.video:
        video_id, _ = parse_video(args.video)
        summary = {**summary, "video_id": video_id, "url": watch_url(video_id)}
    if skipped:
        summary["lines_before_first_time"] = skipped
    return deliver(segments, summary, args)


# ---------------------------------------------------------------- command line


def positive_seconds(value: str) -> float:
    try:
        number = float(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a number of seconds: {value}") from None
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError(f"must be more than 0 seconds: {value}")
    return number


def build_parser() -> argparse.ArgumentParser:
    p = Parser(prog="youtube_transcript.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", parser_class=Parser)

    def add(name: str, func: Callable[[argparse.Namespace], int], help_text: str, example: str) -> argparse.ArgumentParser:
        sp = sub.add_parser(name, help=help_text, description=help_text, epilog=f"example:\n  {example}",
                            formatter_class=argparse.RawDescriptionHelpFormatter)
        sp.set_defaults(func=func)
        return sp

    def network(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("video", help="the video's link (watch, youtu.be, shorts, embed or live) or its 11-character id")
        sp.add_argument("--timeout", type=positive_seconds, default=30.0, metavar="SECONDS",
                        help="seconds to wait for each answer from YouTube (default 30)")

    def shape(sp: argparse.ArgumentParser) -> None:
        sp.add_argument("--format", choices=["timed", "text", "json"], default="timed",
                        help="timed: a [m:ss] time before each caption line (default); text: the lines without "
                             "times; json: segments with start and duration in seconds")
        sp.add_argument("-o", "--out", help="write the transcript to this file (UTF-8) and print only what it is")

    sp = add("id", cmd_id, "The video id, its link and any start time the link carries. No network.",
             'python youtube_transcript.py id "https://youtu.be/dQw4w9WgXcQ?t=42"')
    sp.add_argument("video", help="a YouTube link in any form, or an 11-character id")

    sp = add("list", cmd_list, "The transcripts a video has: language, manual or auto-generated, translatable, and the "
             "languages YouTube can translate into.", 'python youtube_transcript.py list "https://youtu.be/dQw4w9WgXcQ"')
    network(sp)

    sp = add("get", cmd_get, "One transcript. Without --language: the language spoken (that of YouTube's automatic "
             "captions), a person's transcript in it first.",
             'python youtube_transcript.py get "https://youtu.be/dQw4w9WgXcQ" --language de,en -o yt-work/transcript.txt')
    network(sp)
    sp.add_argument("--language", metavar="CODES", help="language codes in order of preference, like de,en; a person's transcript "
                                       "comes before an auto-generated one in the same language")
    sp.add_argument("--translate", metavar="CODE", help="YouTube's machine translation of the chosen transcript into "
                                                        "this language (the video's own transcript in it, if it has one)")
    shape(sp)

    sp = add("pasted", cmd_pasted, "A transcript copied from YouTube's Show transcript panel and saved in a file "
             "(times on their own lines or before the text), in the same shapes as get.",
             'python youtube_transcript.py pasted yt-work/copied.txt --video "https://youtu.be/dQw4w9WgXcQ" -o yt-work/transcript.txt')
    sp.add_argument("file", help="the saved text: UTF-8, UTF-16 or the Windows code page")
    sp.add_argument("--video", help="the video's link or id, to put its id and link in the result")
    shape(sp)
    sp.add_argument("--overwrite", action="store_true", help="allow --out to replace the input file")
    return p


def main(argv: list[str] | None = None) -> int:
    utf8_output()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.error("needs a command: id, list, get or pasted")
    return run_job(f"youtube_transcript.py {args.command}", lambda: args.func(args))


if __name__ == "__main__":
    sys.exit(main())
