#!/usr/bin/env python3
"""Read web feeds (RSS, Atom, JSON Feed), find the feed behind a page, and read Reddit through its public feeds.

  read URL [URL ...]   the newest entries of one or more feeds; a page's address works too (its feed is found)
  discover URL         the feeds a page offers, each one fetched to check it really is a feed
  reddit sub NAME | search QUERY | thread URL | user NAME
                       Reddit through its anonymous .rss feeds: no account, about one request a minute

The standard library only; Python 3.10 or newer. Addresses must be http or https (https:// is added when there's
none). A redirect is followed only on the same site (www. or not, and never from https down to http). A 429 "too
many requests" is waited out once when the site says how long to wait (up to 90 seconds); then the command stops.
Results are printed on stdout as JSON. Exit codes: 0 done; 1 it ran but something is missing (a feed that couldn't be
read, no feed found), and the JSON says what; 2 it couldn't do the job, and one line on stderr says why.
"""

from __future__ import annotations

import argparse
import codecs
import html
import html.entities
import html.parser
import http.client
import ipaddress
import json
import locale
import os
import re
import socket
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
import zlib
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from typing import Any, Callable, NoReturn

USER_AGENT = "AthenaAgents/1.0 (feeds.py)"
ACCEPT = ("application/rss+xml, application/atom+xml, application/feed+json, application/json;q=0.9, "
          "application/xml;q=0.8, text/xml;q=0.8, text/html;q=0.5, */*;q=0.1")
MAX_BYTES = 25 * 1024 * 1024  # bigger than any real feed; stops a runaway download
LONGEST_WAIT = 90  # seconds: a 429 asking for longer than this isn't waited out (the shell's own limit is 300)
REDDIT = os.environ.get("FEEDS_PY_REDDIT", "https://www.reddit.com").rstrip("/")  # tests point this at a stand-in
UTC = timezone.utc

# ---------------------------------------------------------------- helpers copied from the pdf skill's scripts


def utf8_output() -> None:
    # A Windows pipe is cp1252 unless the script says otherwise; feed titles and Reddit comments often aren't.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


class Fail(Exception):
    """A problem to report in one line and exit 2."""


# What a result also says, gathered while the command runs: a list or state file read in an encoding other than
# UTF-8, how long a 429 was waited out, and when Reddit's limit is used up.
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


# ---------------------------------------------------------------- fetching


class FetchError(Exception):
    """One address that couldn't be read. `read` reports it beside that feed and goes on with the others."""


def bare_host(host: str | None) -> str:
    host = (host or "").lower().rstrip(".")
    return host[4:] if host.startswith("www.") else host


def same_site(old: str, new: str) -> bool:
    a, b = urllib.parse.urlsplit(old), urllib.parse.urlsplit(new)
    if b.scheme not in ("http", "https") or (a.scheme == "https" and b.scheme == "http"):
        return False
    return bare_host(a.hostname) == bare_host(b.hostname)


class SameSite(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only on the same site: http to https, www. or not, another path. Anything else comes back
    as the redirect's own answer, which the caller reports with the address it pointed to."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        if not same_site(req.full_url, newurl):
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def direct(host: str) -> bool:
    """Whether to go round the system proxy: a server on this machine or the local network is reached directly."""
    host = host.lower().rstrip(".")
    if host == "localhost" or host.endswith(".local") or ("." not in host and ":" not in host):
        return True
    try:
        return not ipaddress.ip_address(host).is_global
    except ValueError:
        return False


def normalise_url(url: str) -> str:
    """An http(s) address, with https:// added when the scheme is missing ("example.com/feed")."""
    url = url.strip()
    if url.startswith("//"):
        url = "https:" + url
    elif "://" not in url:
        if re.match(r"[A-Za-z][\w+.-]*:(?!\d)", url):  # mailto:, javascript:, but not host:port
            raise FetchError(f"{url}: only http and https addresses can be read")
        url = "https://" + url
    parts = urllib.parse.urlsplit(url)
    if parts.scheme.lower() not in ("http", "https"):
        raise FetchError(f"{url}: only http and https addresses can be read")
    if not parts.hostname:
        raise FetchError(f"{url}: not a web address")
    return url


class Answer:
    def __init__(self, url: str, ctype: str, body: bytes, headers: Any):
        self.url = url  # where the content came from, after redirects on the same site
        self.ctype = ctype.lower()
        self.body = body
        self.headers = headers


def read_body(res: Any) -> bytes:
    body = res.read(MAX_BYTES + 1)
    if len(body) > MAX_BYTES:
        raise FetchError(f"{res.geturl()}: bigger than {MAX_BYTES // (1024 * 1024)} MB, which no feed is")
    if (res.headers.get("Content-Encoding") or "").lower() == "gzip":
        unzip = zlib.decompressobj(16 + zlib.MAX_WBITS)
        try:
            body = unzip.decompress(body, MAX_BYTES + 1)
        except zlib.error as e:
            raise FetchError(f"{res.geturl()}: the compressed answer is damaged ({e})") from None
        if len(body) > MAX_BYTES:
            raise FetchError(f"{res.geturl()}: bigger than {MAX_BYTES // (1024 * 1024)} MB unpacked, which no feed is")
    return body


def page_title(body: bytes) -> str:
    m = re.search(rb"<title[^>]*>(.*?)</title>", body[:20000], re.I | re.S)
    if not m:
        return ""
    return " ".join(html.unescape(m.group(1).decode("utf-8", "replace")).split())[:120]


def wait_asked(headers: Any) -> float | None:
    """Seconds a 429 asks to wait: Reddit's x-ratelimit-reset, or the standard Retry-After (seconds or a date)."""
    for name in ("x-ratelimit-reset", "Retry-After"):
        value = (headers.get(name) or "").strip() if headers else ""
        if not value:
            continue
        try:
            return max(0.0, float(value))
        except ValueError:
            when = parse_date(value)
            if when:
                return max(0.0, (when - datetime.now(UTC)).total_seconds())
    return None


def fetch(url: str, timeout: float) -> Answer:
    url = normalise_url(url)
    host = urllib.parse.urlsplit(url).hostname or ""
    handlers: list[Any] = [SameSite()] + ([urllib.request.ProxyHandler({})] if direct(host) else [])
    opener = urllib.request.build_opener(*handlers)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": ACCEPT, "Accept-Encoding": "gzip"})
    for attempt in (1, 2):
        try:
            with opener.open(req, timeout=timeout) as res:
                return Answer(res.geturl(), res.headers.get("Content-Type") or "", read_body(res), res.headers)
        except urllib.error.HTTPError as e:
            status, headers = e.code, e.headers
            try:
                body = e.read(20000)
            except (OSError, http.client.HTTPException):
                body = b""
            e.close()
            if status in (301, 302, 303, 307, 308):
                to = urllib.parse.urljoin(url, (headers.get("Location") or "") if headers else "")
                if same_site(url, to):
                    raise FetchError(f"{url}: redirects in a loop (last to {to})") from None
                raise FetchError(f"{url} moves to another site, {to}: read that address instead if it's the one "
                                 "you meant") from None
            if status == 429:
                wait = wait_asked(headers)
                if attempt == 1 and wait is not None and wait <= LONGEST_WAIT:
                    time.sleep(wait + 1)
                    NOTES["waited_seconds"] = NOTES.get("waited_seconds", 0) + round(wait + 1)
                    continue
                again = f" for the next {round(wait)} seconds" if wait is not None else ""
                raise FetchError(f"{url}: HTTP 429, the site is refusing more requests from this address{again}; "
                                 "make fewer calls and try later") from None
            title = page_title(body)
            reason = getattr(e, "reason", "") or ""
            raise FetchError(f"{url}: HTTP {status} {reason}".rstrip() + (f" ({title})" if title else "")) from None
        except socket.timeout:
            raise FetchError(f"{url}: no answer from {host} within {timeout:g} seconds") from None
        except urllib.error.URLError as e:
            why = e.reason
            if isinstance(why, socket.gaierror):
                raise FetchError(f"{url}: couldn't find the server {host} (no such name, or no network)") from None
            if isinstance(why, ConnectionRefusedError):
                raise FetchError(f"{url}: nothing answered at {host}") from None
            if isinstance(why, (socket.timeout, TimeoutError)):
                raise FetchError(f"{url}: no answer from {host} within {timeout:g} seconds") from None
            if isinstance(why, ssl.SSLError):
                raise FetchError(f"{url}: the secure connection to {host} failed ({why})") from None
            raise FetchError(f"{url}: couldn't connect to {host} ({why})") from None
        except (OSError, http.client.HTTPException) as e:
            raise FetchError(f"{url}: the connection to {host} broke off ({type(e).__name__}: {e})") from None
        except ValueError as e:  # a port that isn't a number, say
            raise FetchError(f"{url}: not a usable web address ({e})") from None
    raise FetchError(f"{url}: no answer")  # not reached: the loop returns or raises


# ---------------------------------------------------------------- text and dates


class TextOf(html.parser.HTMLParser):
    """The readable text of an HTML fragment. With reddit=True only the post or comment body (Reddit puts it in
    <div class="md">) and the address of the [link] anchor (a link post's outside address)."""

    BLOCKS = {"p", "div", "br", "li", "ul", "ol", "tr", "table", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote",
              "pre", "hr", "section", "article", "figure", "figcaption", "dd", "dt"}

    def __init__(self, reddit: bool = False):
        super().__init__(convert_charrefs=True)
        self.reddit = reddit
        self.parts: list[str] = []
        self.skip = 0
        self.md_depth = 0  # how deep inside Reddit's <div class="md"> we are
        self.href = ""
        self.anchor: list[str] = []
        self.outside_link = ""

    def keep(self) -> bool:
        return not self.skip and (not self.reddit or self.md_depth > 0)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = dict(attrs)
        if tag in ("script", "style"):
            self.skip += 1
        if tag == "div" and self.reddit:
            if self.md_depth:
                self.md_depth += 1
            elif "md" in (a.get("class") or "").split():
                self.md_depth = 1
        if tag == "a":
            self.href, self.anchor = a.get("href") or "", []
        if tag in self.BLOCKS and self.keep():
            self.parts.append("\n")

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in ("br", "hr") and self.keep():
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in ("script", "style") and self.skip:
            self.skip -= 1
        if tag == "a":
            if "".join(self.anchor).strip() == "[link]":
                self.outside_link = self.href
            self.href = ""
        if tag in self.BLOCKS and self.keep():
            self.parts.append("\n")
        if tag == "div" and self.md_depth:
            self.md_depth -= 1

    def handle_data(self, data: str) -> None:
        self.anchor.append(data)
        if self.keep():
            self.parts.append(data)

    def text(self) -> str:
        lines = (" ".join(line.split()) for line in "".join(self.parts).split("\n"))
        return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def html_text(fragment: str, reddit: bool = False) -> tuple[str, str]:
    """(text, outside link) of an HTML fragment."""
    parser = TextOf(reddit)
    try:
        parser.feed(fragment)
        parser.close()
    except Exception:  # html.parser copes with almost anything; this is for the rest
        return " ".join(re.sub(r"<[^>]+>", " ", html.unescape(fragment)).split()), ""
    return parser.text(), parser.outside_link


def plain(value: str | None) -> str:
    return " ".join((value or "").split())


def cut(text: str, chars: int) -> str:
    if len(text) <= chars:
        return text
    return text[:chars].rstrip() + " …"


ISO_DATE = re.compile(
    r"(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?\s*(Z|UTC|GMT|[+-]\d{2}(?::?\d{2})?)?$",
    re.I)


def parse_date(value: str | None) -> datetime | None:
    """A date as feeds write them (RFC 822 in RSS, RFC 3339 in Atom and JSON Feed, and either one where the other
    belongs), in UTC. None when it can't be read; a date with no time zone is taken as UTC."""
    text = " ".join((value or "").split())
    if not text:
        return None
    m = ISO_DATE.match(text)
    try:
        if m:
            y, mo, d, hh, mm, ss, zone = m.groups()
            when = datetime(int(y), int(mo), int(d), int(hh or 0), int(mm or 0), int(ss or 0), tzinfo=UTC)
            if zone and zone.upper() not in ("Z", "UTC", "GMT"):
                digits = zone[1:].replace(":", "")
                offset = timedelta(hours=int(digits[:2]), minutes=int(digits[2:4] or 0))
                when -= offset if zone[0] == "+" else -offset
            return when
        when = parsedate_to_datetime(text)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None
    if when is None:
        return None
    return when.replace(tzinfo=UTC) if when.tzinfo is None else when.astimezone(UTC)


def iso(when: datetime | None) -> str | None:
    return when.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ") if when else None


def since_value(text: str) -> datetime:
    """--since: a date, a date and time, or an age such as 7d or 12h."""
    m = re.fullmatch(r"\s*(\d+)\s*([dh])\s*", text, re.I)
    if m:
        amount = int(m.group(1))
        if amount <= 0:
            raise argparse.ArgumentTypeError("an age must be above 0, such as 7d or 12h")
        unit = timedelta(days=1) if m.group(2).lower() == "d" else timedelta(hours=1)
        return datetime.now(UTC) - amount * unit
    when = parse_date(text) if ISO_DATE.match(" ".join(text.split())) else None
    if when is None:
        raise argparse.ArgumentTypeError(f"{text!r} isn't a date (2026-11-01), a date and time (2026-11-01T08:00Z) "
                                         "or an age (7d, 12h)")
    return when


def count_value(low: int) -> Callable[[str], int]:
    def check(text: str) -> int:
        try:
            n = int(text)
        except ValueError:
            raise argparse.ArgumentTypeError(f"{text!r} isn't a whole number") from None
        if n < low:
            raise argparse.ArgumentTypeError(f"must be {low} or more")
        return n
    return check


def listing_limit(text: str) -> int:
    n = count_value(1)(text)
    if n > 100:
        raise argparse.ArgumentTypeError("Reddit sends at most 100 at a time")
    return n


def seconds_value(text: str) -> float:
    try:
        n = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} isn't a number of seconds") from None
    if not 0 < n <= 300:
        raise argparse.ArgumentTypeError("must be above 0 and at most 300 seconds")
    return n


# ---------------------------------------------------------------- feeds

ATOM = "http://www.w3.org/2005/Atom"
RSS1 = "http://purl.org/rss/1.0/"
RDF = "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
DC = "http://purl.org/dc/elements/1.1/"
CONTENT = "http://purl.org/rss/1.0/modules/content/"
XML_ENTITIES = {"amp", "lt", "gt", "quot", "apos"}
PROLOG = re.compile(r"\A(?:\s|<\?.*?\?>|<!--.*?-->|<!DOCTYPE(?:[^\[>]|\[.*?\])*>)*<([\w:.-]+)", re.S | re.I)


class Entry:
    def __init__(self, key: str, title: str, link: str, raw_date: str | None, author: str, body: str, is_html: bool):
        self.key = key
        self.title = title
        self.link = link
        self.raw_date = plain(raw_date)
        self.date = parse_date(raw_date)
        self.author = author
        self.body = body
        self.is_html = is_html
        self.extra: dict[str, Any] = {}


class Feed:
    def __init__(self, fmt: str, title: str, site: str, entries: list[Entry]):
        self.format = fmt
        self.title = title
        self.site = site
        self.entries = entries
        self.notes: list[str] = []


def sniff(body: bytes) -> str:
    """'json', 'rss', 'atom', 'rdf' or '' (not a feed: an HTML page, say)."""
    head = body[:8192]
    if head[:2] in (codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE):
        text = head.decode("utf-16", "replace")
    else:
        text = head.decode("latin-1")
    text = text.lstrip("\ufeff\u00ef\u00bb\u00bf \t\r\n")
    if text.startswith("{"):
        return "json"
    m = PROLOG.match(text)
    if not m:
        return ""
    name = m.group(1).split(":")[-1].lower()
    return {"rss": "rss", "feed": "atom", "rdf": "rdf"}.get(name, "")


def xml_text(body: bytes, ctype: str) -> str:
    if body[:2] in (codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE):
        return body.decode("utf-16", "replace")
    m = re.match(rb"\s*<\?xml[^>]*encoding=[\"']([\w.-]+)[\"']", body)
    charset = m.group(1).decode("ascii") if m else ""
    if not charset:
        c = re.search(r"charset=([\w.-]+)", ctype)
        charset = c.group(1) if c else "utf-8"
    try:
        return body.decode(charset, "replace")
    except LookupError:
        return body.decode("utf-8", "replace")


def repair_xml(text: str) -> str:
    """What sloppy feeds get wrong most: HTML entities such as &nbsp; (unknown to XML), a bare &, control
    characters. The XML declaration goes too: the text is already decoded."""
    text = re.sub(r"\A\s*<\?xml[^>]*\?>", "", text)
    text = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", text)

    def entity(m: re.Match[str]) -> str:
        name = m.group(1)
        if name in XML_ENTITIES:
            return m.group(0)
        code = html.entities.name2codepoint.get(name)
        return f"&#{code};" if code else f"&amp;{name};"

    text = re.sub(r"&([A-Za-z][A-Za-z0-9]*);", entity, text)
    return re.sub(r"&(?![A-Za-z][A-Za-z0-9]*;|#[0-9]+;|#[xX][0-9A-Fa-f]+;)", "&amp;", text)


def xml_root(body: bytes, ctype: str, url: str) -> tuple[ET.Element, bool]:
    """The parsed document, and whether it needed repairing first."""
    head = xml_text(body[:65536], ctype)
    m = PROLOG.match(head.lstrip("\ufeff"))
    if m and re.search(r"<!DOCTYPE[^>]*\[", m.group(0), re.I):
        raise FetchError(f"{url}: the feed declares its own XML entities, which this script doesn't read (they can "
                         "be used to blow up memory)")
    try:
        return ET.fromstring(body), False
    except ET.ParseError as first:
        try:
            return ET.fromstring(repair_xml(xml_text(body, ctype))), True
        except ET.ParseError:
            raise FetchError(f"{url}: looks like a feed but isn't readable XML ({first})") from None


def child_text(el: ET.Element, *names: str) -> str | None:
    for name in names:
        found = el.find(name)
        if found is not None and (found.text or "").strip():
            return found.text
    return None


def atom_text(el: ET.Element | None) -> tuple[str, bool]:
    """(content, is_html) of an Atom text construct: type text, html or xhtml."""
    if el is None:
        return "", False
    kind = (el.get("type") or "text").lower()
    if kind == "xhtml":
        inner = "".join(ET.tostring(c, encoding="unicode") for c in el)
        return re.sub(r"<(/?)[\w.-]+:", r"<\1", inner), True
    return el.text or "", kind in ("html", "text/html")


def parse_atom(root: ET.Element, url: str) -> Feed:
    a = f"{{{ATOM}}}"
    feed_author = plain(child_text(root, f"{a}author/{a}name"))

    def alternate(el: ET.Element) -> str:
        links = el.findall(f"{a}link")
        for link in links:
            if (link.get("rel") or "alternate") == "alternate" and link.get("href"):
                return urllib.parse.urljoin(url, link.get("href") or "")
        return urllib.parse.urljoin(url, links[0].get("href") or "") if links else ""

    entries = []
    for e in root.findall(f"{a}entry"):
        title, title_html = atom_text(e.find(f"{a}title"))
        body, is_html = atom_text(e.find(f"{a}content"))
        if not body.strip():
            body, is_html = atom_text(e.find(f"{a}summary"))
        link = alternate(e)
        entry = Entry(plain(e.findtext(f"{a}id")) or link or title, html_text(title)[0] if title_html else plain(title),
                      link, child_text(e, f"{a}published", f"{a}updated"),
                      plain(child_text(e, f"{a}author/{a}name")) or feed_author, body, is_html)
        category = e.find(f"{a}category")
        if category is not None and category.get("term"):
            entry.extra["category"] = category.get("term")
        entries.append(entry)
    title, title_html = atom_text(root.find(f"{a}title"))
    return Feed("atom", html_text(title)[0] if title_html else plain(title), alternate(root), entries)


def parse_rss(root: ET.Element, url: str) -> Feed:
    channel = root.find("channel")
    if channel is None:
        channel = root
    entries = []
    for item in channel.iter("item"):
        guid = item.find("guid")
        guid_text = plain(guid.text) if guid is not None else ""
        link = plain(child_text(item, "link"))
        if not link and guid_text.startswith("http") and (guid is None or guid.get("isPermaLink") != "false"):
            link = guid_text
        if not link:
            atom_link = item.find(f"{{{ATOM}}}link")
            link = atom_link.get("href") or "" if atom_link is not None else ""
        body = child_text(item, f"{{{CONTENT}}}encoded", "description") or ""
        title = plain(html_text(child_text(item, "title") or "")[0])
        entry = Entry(guid_text or link or title, title, urllib.parse.urljoin(url, link) if link else "",
                      child_text(item, "pubDate", f"{{{DC}}}date", f"{{{ATOM}}}updated"),
                      plain(child_text(item, f"{{{DC}}}creator", "author")), body, True)
        comments = plain(child_text(item, "comments"))
        if comments:
            entry.extra["comments"] = comments
        enclosure = item.find("enclosure")
        if enclosure is not None and enclosure.get("url"):
            entry.extra["enclosure"] = {"url": enclosure.get("url"), "type": enclosure.get("type") or ""}
        entries.append(entry)
    return Feed("rss", plain(html_text(child_text(channel, "title") or "")[0]), plain(child_text(channel, "link")),
                entries)


def parse_rdf(root: ET.Element, url: str) -> Feed:
    r = f"{{{RSS1}}}"
    entries = []
    for item in root.iter(f"{r}item"):
        link = plain(child_text(item, f"{r}link"))
        title = plain(html_text(child_text(item, f"{r}title") or "")[0])
        entries.append(Entry(item.get(f"{{{RDF}}}about") or link or title, title, link,
                             child_text(item, f"{{{DC}}}date"), plain(child_text(item, f"{{{DC}}}creator")),
                             child_text(item, f"{{{CONTENT}}}encoded", f"{r}description") or "", True))
    channel = root.find(f"{r}channel")
    title = plain(child_text(channel, f"{r}title")) if channel is not None else ""
    site = plain(child_text(channel, f"{r}link")) if channel is not None else ""
    return Feed("rss1", title, site, entries)


def parse_json_feed(body: bytes, url: str) -> Feed | None:
    try:
        doc = json.loads(decode(body, url))
    except ValueError:
        return None
    if not isinstance(doc, dict) or not isinstance(doc.get("items"), list):
        return None
    if "jsonfeed.org" not in str(doc.get("version", "")):
        return None

    def names(holder: dict[str, Any]) -> str:
        people = holder.get("authors") if isinstance(holder.get("authors"), list) else [holder.get("author")]
        return ", ".join(plain(p.get("name")) for p in people if isinstance(p, dict) and p.get("name"))

    feed_author = names(doc)
    entries = []
    for item in doc["items"]:
        if not isinstance(item, dict):
            continue
        link = str(item.get("url") or item.get("external_url") or "")
        title = plain(str(item.get("title") or ""))
        html_body = item.get("content_html")
        body = str(html_body or item.get("content_text") or item.get("summary") or "")
        entry = Entry(str(item.get("id") or link or title), title, urllib.parse.urljoin(url, link) if link else "",
                      str(item.get("date_published") or item.get("date_modified") or "") or None,
                      names(item) or feed_author, body, bool(html_body))
        if item.get("external_url") and item.get("url"):
            entry.extra["outside_link"] = item["external_url"]
        entries.append(entry)
    return Feed("json", plain(str(doc.get("title") or "")), str(doc.get("home_page_url") or ""), entries)


def parse_feed(answer: Answer) -> Feed | None:
    """The feed in an answer, or None when it isn't one (an HTML page, an empty answer)."""
    kind = sniff(answer.body)
    if kind == "json":
        return parse_json_feed(answer.body, answer.url)
    if not kind:
        return None
    root, repaired = xml_root(answer.body, answer.ctype, answer.url)
    name = root.tag.rsplit("}", 1)[-1].lower()
    if name == "feed":
        feed = parse_atom(root, answer.url)
    elif name == "rss":
        feed = parse_rss(root, answer.url)
    elif name == "rdf":
        feed = parse_rdf(root, answer.url)
    else:
        return None
    if repaired:
        feed.notes.append("the feed isn't well-formed XML (stray & or HTML entities); it was repaired to read it, "
                          "so check odd-looking text against the entry's page")
    return feed


def is_reddit(url: str) -> bool:
    host = (urllib.parse.urlsplit(url).hostname or "").lower()
    return host == "reddit.com" or host.endswith(".reddit.com") or url.startswith(REDDIT + "/")


def entry_out(e: Entry, chars: int, reddit: bool) -> dict[str, Any]:
    out: dict[str, Any] = {"title": e.title, "link": e.link, "date": iso(e.date)}
    if e.date is None:
        out["date_problem"] = f"can't read the date {e.raw_date!r}" if e.raw_date else "the feed gives no date"
    if e.author:
        out["author"] = e.author.removeprefix("/u/") if reddit else e.author
    text, outside = html_text(e.body, reddit) if e.is_html else (e.body.strip(), "")
    if reddit:
        if e.extra.get("category"):
            out["subreddit"] = e.extra["category"]
        if outside and outside.rstrip("/") != e.link.rstrip("/"):
            out["outside_link"] = outside
    elif e.extra.get("category"):
        out["category"] = e.extra["category"]
    for key in ("comments", "enclosure", "outside_link"):
        if key in e.extra:
            out[key] = e.extra[key]
    if chars:
        out["text"] = cut(text, chars)
        out["text_chars"] = len(text)
    return out


def ordered(entries: list[Entry]) -> list[Entry]:
    """Newest first; entries with no readable date after them, in the feed's own order."""
    dated = sorted((e for e in entries if e.date), key=lambda e: e.date or datetime.min.replace(tzinfo=UTC),
                   reverse=True)
    return dated + [e for e in entries if not e.date]


# ---------------------------------------------------------------- discovery


class PageLinks(html.parser.HTMLParser):
    """The <link> and <a> tags of a page, and its <base href>."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.links: list[dict[str, str]] = []
        self.anchors: list[tuple[str, str]] = []
        self.base = ""
        self.href: str | None = None
        self.text: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "link":
            self.links.append(a)
        elif tag == "base" and a.get("href") and not self.base:
            self.base = a["href"]
        elif tag == "a" and a.get("href"):
            self.href, self.text = a["href"], []

    def handle_startendtag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        self.handle_starttag(tag, attrs)
        if tag == "a":
            self.handle_endtag("a")

    def handle_data(self, data: str) -> None:
        if self.href is not None:
            self.text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self.href is not None:
            self.anchors.append((self.href, " ".join("".join(self.text).split())))
            self.href = None


FEED_TYPES = ("application/rss+xml", "application/atom+xml", "application/feed+json", "application/rdf+xml")
COMMON_PATHS = ("feed", "rss", "feed.xml", "rss.xml", "atom.xml", "index.xml", "feed.json")
FEEDISH = re.compile(r"(?:^|[/._?=-])(?:rss|atom|feeds?)(?:$|[/._?=&-])", re.I)


def candidates(page_url: str, body: bytes, ctype: str) -> list[tuple[str, str, str]]:
    """(url, title, found_by) for a page: its advertised feeds first, then feed-looking links on the page, then the
    usual addresses beside the page and at the site's root."""
    parser = PageLinks()
    try:
        parser.feed(xml_text(body, ctype))
        parser.close()
    except Exception:  # a page html.parser can't take still gets the usual addresses
        pass
    base = urllib.parse.urljoin(page_url, parser.base) if parser.base else page_url
    found: list[tuple[str, str, str]] = []
    seen: set[str] = set()

    def add(href: str, title: str, by: str) -> None:
        url = urllib.parse.urljoin(base, html.unescape(href.strip())).split("#")[0]
        if urllib.parse.urlsplit(url).scheme in ("http", "https") and url not in seen:
            seen.add(url)
            found.append((url, title, by))

    advertised = [link for link in parser.links
                  if "alternate" in link.get("rel", "").lower().split() and link.get("href")]
    for link in advertised:
        if link.get("type", "").lower().split(";")[0].strip() in FEED_TYPES:
            add(link["href"], link.get("title", ""), "link tag")
    if not found:  # application/json only when no feed says application/feed+json (JSON Feed's advice)
        for link in advertised:
            if link.get("type", "").lower().split(";")[0].strip() == "application/json":
                add(link["href"], link.get("title", ""), "link tag")
    for href, text in parser.anchors:
        if FEEDISH.search(urllib.parse.urlsplit(href).path + "?" + urllib.parse.urlsplit(href).query) or \
                re.fullmatch(r"(?:rss|atom|feed|rss feed|subscribe via rss)", text, re.I):
            add(href, text, "link on the page")
    page = urllib.parse.urlsplit(page_url)
    roots = [f"{page.scheme}://{page.netloc}/"]
    folder = page.path if page.path.endswith("/") else page.path.rsplit("/", 1)[0] + "/"
    if folder not in ("", "/"):
        roots.insert(0, f"{page.scheme}://{page.netloc}{folder}")
    for root in roots:
        for path in COMMON_PATHS:
            add(root + path, "", "usual address")
    return found


def find_feeds(page: Answer, timeout: float, want: int) -> tuple[list[dict[str, Any]], list[dict[str, str]],
                                                                    dict[str, tuple[Answer, Feed]]]:
    """Check a page's candidates in order until `want` feeds are found: (feeds, what was checked and why it isn't a
    feed, the feeds' answers by address). Advertised feeds are checked first (up to 8); the links on the page and
    the usual addresses only when none of those works, and only until one does."""
    feeds: list[dict[str, Any]] = []
    checked: list[dict[str, str]] = []
    answers: dict[str, tuple[Answer, Feed]] = {}
    tried = {"link tag": 0, "link on the page": 0, "usual address": 0}
    most = {"link tag": 8, "link on the page": 5, "usual address": 2 * len(COMMON_PATHS)}
    for url, title, by in candidates(page.url, page.body, page.ctype):
        if len(feeds) >= want or (by != "link tag" and feeds):
            break
        if tried[by] >= most[by]:
            continue
        tried[by] += 1
        try:
            answer = fetch(url, timeout)
            feed = parse_feed(answer)
        except FetchError as e:
            checked.append({"url": url, "found_by": by, "result": str(e).replace(f"{url}: ", "", 1)})
            continue
        if feed is None:
            what = "an HTML page" if b"<html" in answer.body[:4096].lower() else "not a feed"
            checked.append({"url": url, "found_by": by, "result": what})
            continue
        if any(f["url"] == answer.url for f in feeds):
            continue
        answers[answer.url] = (answer, feed)
        feeds.append({"url": answer.url, "format": feed.format, "title": feed.title or title,
                      "entries": len(feed.entries), "found_by": by})
    return feeds, checked, answers


# ---------------------------------------------------------------- state for digests


def load_state(path: str) -> dict[str, Any]:
    if not os.path.exists(path):
        return {"written_by": "feeds.py", "feeds": {}}
    if os.path.isdir(path):
        raise Fail(f"--state {path} is a folder; give a file name, such as feeds-state.json")
    try:
        state = json.loads(read_text(path, "the state file"))
    except ValueError:
        state = None
    if not isinstance(state, dict) or not isinstance(state.get("feeds"), dict):
        raise Fail(f"{path} isn't a state file feeds.py wrote; give a new file name, or delete it to start over")
    return state


def save_state(path: str, state: dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    data = json.dumps(state, ensure_ascii=False, indent=1).encode("utf-8")
    write_atomic(path, lambda fh: fh.write(data))


# ---------------------------------------------------------------- commands


def feed_list(path: str) -> list[str]:
    """Addresses from a text file (one per line, # for comments) or an OPML export from a feed reader."""
    text = read_text(path, "the feed list")
    if re.search(r"<opml\b", text[:4096], re.I):
        try:
            root = ET.fromstring(re.sub(r"\A\s*<\?xml[^>]*\?>", "", text.lstrip("\ufeff")))
        except ET.ParseError as e:
            raise Fail(f"{path} looks like OPML but isn't readable XML ({e})") from None
        return [o.get("xmlUrl") or "" for o in root.iter("outline") if o.get("xmlUrl")]
    urls = []
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            urls.append(line.split()[0])
    return urls


def read_one(asked: str, args: argparse.Namespace, state: dict[str, Any] | None) -> dict[str, Any]:
    asked = normalise_url(asked)
    first = fetch(asked, args.timeout)
    feed = parse_feed(first)
    result: dict[str, Any] = {}
    answer = first
    if feed is None:
        if "html" not in first.ctype and b"<html" not in first.body[:4096].lower():
            raise FetchError(f"{asked}: not a feed or a web page ({first.ctype or 'no content type'})")
        feeds, checked, answers = find_feeds(first, args.timeout, 1)
        if not feeds:
            raise FetchError(f"{asked}: no feed found ({len(checked)} addresses checked; discover lists them)")
        answer, feed = answers[feeds[0]["url"]]
        result["discovered_from"] = first.url
    result.update({"url": answer.url, "format": feed.format, "title": feed.title, "site": feed.site,
                   "entries_in_feed": len(feed.entries)})
    reddit = is_reddit(answer.url)
    entries = ordered(feed.entries)
    newest = next((e.date for e in entries if e.date), None)
    result["newest"] = iso(newest)
    left_out = {"older": 0, "seen_before": 0, "over_limit": 0}
    remembered = state["feeds"].get(asked) if state is not None else None
    before = [str(k) for k in remembered["seen"]] if isinstance(remembered, dict) and isinstance(
        remembered.get("seen"), list) else []
    seen = set(before)
    kept = []
    for e in entries:
        if e.key in seen:
            left_out["seen_before"] += 1
        elif args.since and e.date and e.date < args.since:
            left_out["older"] += 1
        else:
            kept.append(e)
    left_out["over_limit"] = max(0, len(kept) - args.limit)
    shown = kept[: args.limit]
    result["entries"] = [entry_out(e, args.chars, reddit) for e in shown]
    if any(left_out.values()):
        result["left_out"] = {k: v for k, v in left_out.items() if v}
    undated = sum(1 for e in shown if not e.date)
    notes = list(feed.notes)
    if args.since and undated:
        notes.append(f"{undated} entries have no readable date, so --since couldn't leave them out")
    if notes:
        result["notes"] = notes
    if state is not None:
        keys = list(dict.fromkeys(e.key for e in feed.entries))
        now = set(keys)
        keys += [k for k in before if k not in now]  # entries gone from the feed stay remembered for a while
        state["feeds"][asked] = {"checked": iso(datetime.now(UTC)), "seen": keys[:1000]}
    return result


def cmd_read(args: argparse.Namespace) -> int:
    urls = list(args.urls) + (feed_list(args.list) if args.list else [])
    if not urls:
        raise Fail("give at least one feed or page address, or --list with a file of them")
    state = load_state(args.state) if args.state else None
    feeds, failed = [], 0
    for url in dict.fromkeys(urls):
        try:
            feeds.append(read_one(url, args, state))
        except FetchError as e:
            failed += 1
            feeds.append({"asked": url, "error": str(e)})
        except Exception as e:  # one feed nobody expected mustn't stop the others
            failed += 1
            feeds.append({"asked": url, "error": f"{url}: stopped unexpectedly ({type(e).__name__}: {e})"})
    if failed == len(feeds):
        reasons = "; ".join(f["error"] for f in feeds)
        raise Fail(reasons if len(feeds) == 1 else f"none of the {len(feeds)} feeds could be read: {reasons}")
    out: dict[str, Any] = {"feeds": feeds}
    if args.since:
        out["since"] = iso(args.since)
    if state is not None:
        save_state(args.state, state)
        out["state"] = os.path.abspath(args.state)
    emit(out)
    return 1 if failed else 0


def cmd_discover(args: argparse.Namespace) -> int:
    try:
        page = fetch(args.url, args.timeout)
        own = parse_feed(page)
    except FetchError as e:
        raise Fail(str(e)) from None
    if own is not None:
        emit({"page": page.url, "feeds": [{"url": page.url, "format": own.format, "title": own.title,
                                          "entries": len(own.entries), "found_by": "the address itself"}]})
        return 0
    feeds, checked, _ = find_feeds(page, args.timeout, 8)
    out: dict[str, Any] = {"page": page.url, "feeds": feeds, "checked": checked}
    if not feeds:
        out["next"] = ("no feed found: look for one in the page's footer, an RSS or Subscribe page, the site's "
                       "/sitemap.xml, or a blog on another address (blog.<site>, Substack, Medium)")
    emit(out)
    return 0 if feeds else 1


# ---------------------------------------------------------------- reddit

# a thread's address (old., new., np. or none), with the comment's id when it's a comment's
THREAD = re.compile(r"^(?:https?://)?(?:[\w-]+\.)?reddit\.com/r/(\w+)/comments/([a-z0-9]+)"
                    r"(?:/[^/?#]*)?(?:/([a-z0-9]+))?", re.I)
SHORT = re.compile(r"^(?:https?://)?(?:(?:[\w-]+\.)?reddit\.com/comments|redd\.it)/([a-z0-9]+)(?:[/?#]|$)", re.I)


def reddit_name(value: str, what: str, prefix: str) -> str:
    name = re.sub(rf"^/?{prefix}/", "", value.strip(), flags=re.I).strip("/")
    pattern = r"\w+(?:\+\w+)*" if prefix == "r" else r"[\w-]+"
    if not re.fullmatch(pattern, name):
        raise Fail(f"{value!r} isn't a {what} name (such as {'LocalLLaMA' if prefix == 'r' else 'spez'})")
    return name


def reddit_get(path: str, params: dict[str, Any], timeout: float) -> tuple[Answer, Feed]:
    query = urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, "")})
    url = f"{REDDIT}{path}" + (f"?{query}" if query else "")
    try:
        answer = fetch(url, timeout)
        feed = parse_feed(answer)
    except FetchError as e:
        message = str(e)
        if "HTTP 429" in message:
            message += " (Reddit allows about one anonymous request a minute from one address)"
        if "HTTP 404" in message or "HTTP 403" in message:
            message += " (a private, banned or misspelt subreddit or user, or a removed post)"
        raise Fail(message) from None
    if feed is None:
        raise Fail(f"{url}: Reddit answered with a page, not a feed ({page_title(answer.body) or 'no title'})")
    remaining, reset = answer.headers.get("x-ratelimit-remaining"), answer.headers.get("x-ratelimit-reset")
    try:
        if remaining is not None and float(remaining) < 1 and reset is not None:
            NOTES["next_call_waits"] = (f"Reddit's limit for this address is used up for {round(float(reset))} more "
                                        "seconds; a call before then waits that long first")
    except ValueError:
        pass
    return answer, feed


def reddit_item(e: Entry, chars: int) -> dict[str, Any]:
    kind = {"t3": "post", "t1": "comment", "t5": "subreddit"}.get(e.key.split("_")[0], "other")
    out = entry_out(e, chars, True)
    out = {"kind": kind, **out}
    if kind == "comment":
        on = re.sub(r"^/u/\S+ on ", "", out.pop("title", ""))
        out["on"] = on
    if kind == "subreddit":
        out.pop("author", None)
        out.pop("date_problem", None)
    return out


def cmd_reddit(args: argparse.Namespace) -> int:
    if args.what == "sub":
        name = reddit_name(args.name, "subreddit", "r")
        path = f"/r/{name}/.rss" if args.sort == "hot" else f"/r/{name}/{args.sort}/.rss"
        answer, feed = reddit_get(path, {"limit": args.limit, "t": args.time if args.sort == "top" else None},
                                  args.timeout)
    elif args.what == "search":
        params = {"q": args.query, "sort": args.sort, "t": args.time, "limit": args.limit}
        if args.sub:
            path = f"/r/{reddit_name(args.sub, 'subreddit', 'r')}/search.rss"
            params["restrict_sr"] = "on"
        else:
            path = "/search.rss"
        answer, feed = reddit_get(path, params, args.timeout)
    elif args.what == "user":
        name = reddit_name(args.name, "user", "u(?:ser)?")
        part = {"all": "", "posts": "submitted/", "comments": "comments/"}[args.only]
        answer, feed = reddit_get(f"/user/{name}/{part}.rss", {"limit": args.limit}, args.timeout)
    else:
        m, short = THREAD.match(args.url.strip()), SHORT.match(args.url.strip())
        if m:
            sub, post_id, comment = m.groups()
            path = f"/r/{sub}/comments/{post_id}/" + (f"_/{comment}/" if comment else "") + ".rss"
        elif short:
            comment, path = None, f"/comments/{short.group(1)}/.rss"
        else:
            raise Fail(f"{args.url!r} isn't a Reddit thread address: it needs /r/<subreddit>/comments/<id>/ in it "
                       "(for a /s/ share link, ask for the address it opens)")
        answer, feed = reddit_get(path, {"limit": args.limit, "depth": 1 if args.top_level else None}, args.timeout)
        items = [reddit_item(e, args.chars) for e in feed.entries]
        posts = [i for i in items if i["kind"] == "post"]
        if not posts and not comment:
            raise Fail(f"{answer.url}: Reddit sent no post for this thread; it may have been removed")
        comments = [{k: v for k, v in i.items() if k not in ("kind", "on", "subreddit")}
                    for i in items if i["kind"] == "comment"]
        emit({"source": answer.url, "post": posts[0] if posts else None, "comments": comments,
              "about_comments": "Reddit's order; replies are included but the feed doesn't say which comment each "
                                "one answers, and it carries no scores"})
        return 0
    items = [reddit_item(e, args.chars) for e in feed.entries][: args.limit]
    out: dict[str, Any] = {"source": answer.url, "items": [i for i in items if i["kind"] != "subreddit"]}
    subs = [i for i in items if i["kind"] == "subreddit"]
    if subs:
        out["subreddits_found"] = [{"name": s.get("title"), "link": s.get("link")} for s in subs]
    emit(out)
    return 0


# ---------------------------------------------------------------- command line


def build_parser() -> Parser:
    p = Parser(prog="feeds.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", parser_class=Parser)

    def common(c: argparse.ArgumentParser, chars: int) -> None:
        c.add_argument("--chars", type=count_value(0), default=chars,
                       help=f"characters of each entry's text to show (default {chars}; 0 leaves the text out). "
                            "text_chars says how long the whole text in the feed is")
        c.add_argument("--timeout", type=seconds_value, default=30,
                       help="seconds to wait for each answer (default 30, at most 300)")

    r = sub.add_parser("read", help="the newest entries of one or more feeds (or of the feed behind a page)",
                       description="The newest entries of one or more feeds, newest first. A page's address works "
                                   "too: its feed is found the way discover finds it. Exit 1 when some feeds "
                                   "couldn't be read (each says why); 2 when none could.")
    r.add_argument("urls", nargs="*", metavar="URL", help="a feed's address, or a page's")
    r.add_argument("--list", metavar="FILE", help="a file of addresses, one per line (# starts a comment), or an "
                                                  "OPML file exported from a feed reader")
    r.add_argument("--limit", type=count_value(1), default=20, help="entries to show per feed (default 20)")
    r.add_argument("--since", type=since_value, metavar="WHEN",
                   help="leave out entries older than this: 2026-11-01, 2026-11-01T08:00Z, 7d or 12h")
    r.add_argument("--state", metavar="FILE",
                   help="a file this script keeps for digests: show only entries that weren't in the feed at the "
                        "last read with this file, then remember every entry now in it")
    common(r, 500)
    r.set_defaults(func=cmd_read)

    d = sub.add_parser("discover", help="the feeds a page offers, each one checked",
                       description="The feeds a page offers: those it advertises in <link rel=\"alternate\">, then "
                                   "feed links on the page, then the usual addresses (/feed, /rss.xml, /atom.xml...). "
                                   "Each is fetched to check it really is a feed. Exit 1 when none is found.")
    d.add_argument("url", metavar="URL")
    d.add_argument("--timeout", type=seconds_value, default=30,
                   help="seconds to wait for each answer (default 30, at most 300)")
    d.set_defaults(func=cmd_discover)

    rd = sub.add_parser("reddit", help="Reddit through its public .rss feeds, no account",
                        description="Reddit through its anonymous .rss feeds: no account, no scores, about one "
                                    "request a minute from one address. Each command makes one request.")
    rsub = rd.add_subparsers(dest="what", parser_class=Parser)
    times = ["hour", "day", "week", "month", "year", "all"]
    s = rsub.add_parser("sub", help="a subreddit's posts")
    s.add_argument("name", help="the subreddit, such as LocalLLaMA (r/ is fine)")
    s.add_argument("--sort", choices=["hot", "new", "top", "rising"], default="hot", help="default hot")
    s.add_argument("--time", choices=times, default="week", help="the period for --sort top (default week)")
    s.add_argument("--limit", type=listing_limit, default=25, help="posts to show (default 25, at most 100)")
    common(s, 500)
    q = rsub.add_parser("search", help="search all of Reddit or one subreddit")
    q.add_argument("query")
    q.add_argument("--sub", help="search only this subreddit")
    q.add_argument("--sort", choices=["relevance", "hot", "top", "new", "comments"], default="relevance",
                   help="default relevance")
    q.add_argument("--time", choices=times, default="all", help="how far back (default all)")
    q.add_argument("--limit", type=listing_limit, default=25, help="results to show (default 25, at most 100)")
    common(q, 500)
    t = rsub.add_parser("thread", help="a post and its comments")
    t.add_argument("url", help="the thread's address (…/r/<sub>/comments/<id>/…, or redd.it/<id>); a comment's "
                               "address gives that comment and the replies under it")
    t.add_argument("--limit", type=count_value(1), default=100, help="comments to ask Reddit for (default 100)")
    t.add_argument("--top-level", action="store_true", help="only comments on the post itself, no replies")
    common(t, 4000)
    u = rsub.add_parser("user", help="a user's recent posts and comments")
    u.add_argument("name", help="the user name, such as spez (u/ is fine)")
    u.add_argument("--only", choices=["all", "posts", "comments"], default="all", help="default all")
    u.add_argument("--limit", type=listing_limit, default=25, help="items to show (default 25, at most 100)")
    common(u, 500)
    rd.set_defaults(func=cmd_reddit)
    return p


def main(argv: list[str] | None = None) -> int:
    utf8_output()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.error("needs a command: read, discover or reddit")
    if args.command == "reddit" and not getattr(args, "what", None):
        parser.error("reddit needs what to read: sub, search, thread or user")
    name = f"feeds.py {args.command}" + (f" {args.what}" if args.command == "reddit" else "")
    try:
        return args.func(args)
    except Fail as e:
        why = str(e)
    except OSError as e:  # a state file open in another program on Windows, a full disk
        where = e.filename2 or e.filename
        why = f"{e.strerror or e}" + (f": {where}" if where else "")
    except Exception as e:  # a feed no parser expected
        why = f"stopped unexpectedly ({type(e).__name__}: {e})"
    print(f"{name}: " + " ".join(why.split()), file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
