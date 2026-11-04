#!/usr/bin/env python3
"""Search arXiv, fetch papers by id, get arXiv's own BibTeX, and look papers up on Semantic Scholar: citation counts,
the papers that cite one, the papers it cites, similar papers and authors.

    python arxiv_search.py search WORDS... [--phrase TEXT] [--author NAME] [--category CAT] [--from DATE] ...
    python arxiv_search.py get ID... [--file IDS]
    python arxiv_search.py bibtex ID... [--file IDS] [--out refs.bib]
    python arxiv_search.py paper ID... [--file IDS]
    python arxiv_search.py cites ID [--max N] [--contexts]
    python arxiv_search.py refs ID [--max N] [--contexts]
    python arxiv_search.py similar ID... [--not ID] [--pool recent|all-cs]
    python arxiv_search.py author NAME

`python arxiv_search.py <command> --help` explains each one. Results are JSON on stdout; --out writes them to a file
instead. Exit codes: 0 done; 1 it ran but some papers weren't found (the JSON's "not_found" lists them); 2 it couldn't
do the job, and one line on stderr says why (when some answers had already come in, the JSON on stdout has them and
"stopped" says where it ended).

It keeps to each service's published limits: one request at a time, 3 seconds apart for arXiv's API, 15 seconds
apart for arxiv.org's BibTeX pages (the site's robots.txt), 1 second apart for Semantic Scholar, and it waits out the
gap before it ends, so runs one after another keep to it too. A Semantic Scholar API key, if the user has one, is read
from the environment variable SEMANTIC_SCHOLAR_API_KEY and never printed.

Standard library only (Python 3.10+). ARXIV_SEARCH_TEST_SERVER (a http://127.0.0.1 address) is for this script's
tests: it sends every request to that local stand-in and shortens the waits.
"""

from __future__ import annotations

import argparse
import codecs
import http.client
import json
import locale
import math
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from typing import Any, Callable, NoReturn

USER_AGENT = "AthenaAgents/1.0 (arxiv_search)"
ARXIV_API = "https://export.arxiv.org/api/query"
ARXIV_SITE = "https://arxiv.org"
S2_API = "https://api.semanticscholar.org"
KEY_VAR = "SEMANTIC_SCHOLAR_API_KEY"
TEST_VAR = "ARXIV_SEARCH_TEST_SERVER"

# Seconds between requests to each service: arXiv's API terms, arxiv.org's robots.txt crawl delay, and Semantic
# Scholar's rate for a new key (without one, everyone shares a pool; going no faster is the polite choice).
GAPS = {"api": 3.0, "site": 15.0, "s2": 1.0}
RETRIES = 3  # for "busy" answers (429, 503): waits of 5, 10 and 20 seconds unless the answer says how long
PAGE = 100  # search results asked for in one request
ID_CHUNK = 100  # ids in one arXiv request
S2_CHUNK = 500  # ids in one Semantic Scholar batch, its documented maximum

ATOM = "{http://www.w3.org/2005/Atom}"
ARXIV_NS = "{http://arxiv.org/schemas/atom}"
OPENSEARCH = "{http://a9.com/-/spec/opensearch/1.1/}"
NET_ERRORS = (OSError, http.client.HTTPException)

S2_PAPER_FIELDS = ("title,year,authors,venue,publicationDate,citationCount,influentialCitationCount,referenceCount,"
                   "externalIds,url,openAccessPdf")
S2_LIST_FIELDS = "title,year,authors,venue,citationCount,externalIds,url"
S2_TOO_MANY = ("Semantic Scholar is turning requests away (429 Too Many Requests). Without a key every user shares one "
               "pool, which is often full: wait a few minutes and try again, or set " + KEY_VAR + " to the user's key")


# ---------------------------------------------------------------- shared helpers


def utf8_output() -> None:
    # A Windows pipe is cp1252 unless the script says otherwise; titles and author names often aren't.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


class Fail(Exception):
    """A problem to report in one line and exit 2."""


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


def same_file(a: str, b: str) -> bool:
    if os.path.exists(a) and os.path.exists(b):
        return os.path.samefile(a, b)
    return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def write_atomic(out: str, data: bytes) -> None:
    """Write to a temporary file beside the output, then move it into place, so a failure leaves no half file."""
    folder = os.path.dirname(os.path.abspath(out))
    os.makedirs(folder, exist_ok=True)
    script = os.path.splitext(os.path.basename(__file__))[0]
    fd, tmp = tempfile.mkstemp(prefix=f".{script}-", suffix=".part", dir=folder)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.replace(tmp, out)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


# ---------------------------------------------------------------- talking to the services


class Stopped(Exception):
    """A failure after some answers had already come in: they are printed with the reason."""

    def __init__(self, why: str, partial: dict[str, Any]):
        super().__init__(why)
        self.partial = partial


class SameHost(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only to the same host, over http or https."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        new, old = urllib.parse.urlsplit(newurl), urllib.parse.urlsplit(req.full_url)
        if new.scheme not in ("http", "https") or new.hostname != old.hostname:
            return None  # urllib then raises an HTTPError with the redirect's status
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Client:
    def __init__(self, timeout: float):
        test = os.environ.get(TEST_VAR, "").strip()
        self.scale = 1.0
        handlers: list[Any] = [SameHost()]
        self.api, self.site, self.s2 = ARXIV_API, ARXIV_SITE, S2_API
        if test:
            parts = urllib.parse.urlsplit(test)
            if parts.scheme != "http" or parts.hostname not in ("127.0.0.1", "localhost", "::1"):
                raise Fail(f"{TEST_VAR} is only for this script's tests and takes a http://127.0.0.1:<port> address")
            base = test.rstrip("/")
            self.api, self.site, self.s2 = base + "/api/query", base, base
            self.scale = 0.01
            handlers.append(urllib.request.ProxyHandler({}))
        self.opener = urllib.request.build_opener(*handlers)
        self.timeout = timeout
        self.last: dict[str, float] = {}
        key = os.environ.get(KEY_VAR, "").strip()
        self.key = key or None

    def _pause(self, seconds: float) -> None:
        if seconds > 0:
            time.sleep(seconds)

    def _wait_turn(self, service: str) -> None:
        last = self.last.get(service)
        if last is not None:
            self._pause(last + GAPS[service] * self.scale - time.monotonic())

    def settle(self) -> None:
        """Wait out the gap after the last request, so a run started right after this one keeps to it too."""
        now = time.monotonic()
        waits = [last + GAPS[service] * self.scale - now for service, last in self.last.items()]
        self._pause(max(waits, default=0))

    def request(self, service: str, url: str, data: bytes | None = None,
                headers: dict[str, str] | None = None) -> tuple[int, Any, bytes]:
        """(status, headers, body) for one request, waiting its turn, and trying again when the service is busy."""
        host = urllib.parse.urlsplit(url).hostname or url
        for attempt in range(RETRIES + 1):
            self._wait_turn(service)
            req = urllib.request.Request(url, data=data, headers={"User-Agent": USER_AGENT, **(headers or {})})
            try:
                with self.opener.open(req, timeout=self.timeout) as res:
                    status, head, body = res.status, res.headers, res.read()
            except urllib.error.HTTPError as e:
                status, head = e.code, e.headers
                try:
                    body = e.read()
                except NET_ERRORS:
                    body = b""
                e.close()
            except NET_ERRORS as e:
                reason = getattr(e, "reason", None) or e
                raise Fail(f"couldn't reach {host}: {' '.join(str(reason).split()) or type(e).__name__}") from None
            finally:
                self.last[service] = time.monotonic()
            if status in (429, 503) and attempt < RETRIES:
                self._pause(self._busy_wait(head, attempt))
                continue
            if 300 <= status < 400:
                where = head.get("Location", "another address") if head is not None else "another address"
                raise Fail(f"{host} sent the request on to {where}, which this script doesn't follow")
            return status, head, body
        raise AssertionError  # the loop returns on its last try

    def _busy_wait(self, head: Any, attempt: int) -> float:
        given = (head.get("Retry-After") or "").strip() if head is not None else ""
        wait = float(given) if given.isdigit() and int(given) <= 120 else 5.0 * 2 ** attempt
        return wait * self.scale


def one_line(body: bytes, status: int) -> str:
    """What an error answer says, in one line: arXiv's error entry, Semantic Scholar's JSON, or a page's text."""
    text = body.decode("utf-8", "replace")
    m = re.search(r"<summary>(.*?)</summary>", text, re.S)
    if m and "api/errors" in text:
        said = m.group(1)
    else:
        try:
            data = json.loads(text)
            said = (data.get("error") or data.get("message") or "") if isinstance(data, dict) else ""
        except ValueError:
            said = re.sub(r"<[^>]+>", " ", text)
    said = " ".join(said.split())
    if len(said) > 200:
        said = said[:200] + "..."
    return f"HTTP {status}" + (f": {said}" if said else "")


# ---------------------------------------------------------------- arXiv ids


class ArxivId:
    def __init__(self, given: str, base: str, version: int | None):
        self.given, self.base, self.version = given, base, version

    @property
    def full(self) -> str:
        return f"{self.base}v{self.version}" if self.version else self.base


NEW_ID = re.compile(r"(\d{4})\.(\d{4,5})(?:v(\d+))?")
# old ids: an archive name, sometimes with a subject class (math.GT/0309136), then YYMMNNN; archive names can hold a
# "v" (solv-int), so the version is only ever a v and digits at the very end
OLD_ID = re.compile(r"([a-z]+(?:-[a-z]+)?)(?:\.([A-Za-z]+(?:-[a-z]+)?))?/(\d{7})(?:v(\d+))?")
LINK = re.compile(r"(?:https?://)?(?:www\.|export\.)?arxiv\.org/(?:abs|pdf|html|bibtex)/(.+?)(?:\.pdf)?/?(?:[?#].*)?",
                  re.I)


def parse_id(given: str, quiet: bool = False) -> ArxivId:
    s = given.strip().strip("<>")
    m = LINK.fullmatch(s)
    if m:
        s = m.group(1)
    s = re.sub(r"^arxiv:", "", s, flags=re.I)
    m = NEW_ID.fullmatch(s)
    if m:
        yymm, number, version = m.group(1), m.group(2), m.group(3)
        month = int(yymm[2:])
        five = len(number) == 5
        if 1 <= month <= 12 and yymm >= "0704" and five == (yymm >= "1501") and (version is None or int(version) > 0):
            return ArxivId(given, f"{yymm}.{number}", int(version) if version else None)
    m = OLD_ID.fullmatch(s)
    if m and (m.group(4) is None or int(m.group(4)) > 0):
        base = f"{m.group(1)}/{m.group(3)}"
        if m.group(2) and not quiet:
            # arXiv files these under the archive alone: the API finds math/0309136, not math.GT/0309136
            NOTES.setdefault("rewritten_ids", {})[given] = base
        return ArxivId(given, base, int(m.group(4)) if m.group(4) else None)
    raise Fail(f"{given!r} isn't an arXiv id: write it like 2401.01234, 2401.01234v2, hep-th/0601001 or an arxiv.org "
               "link")


def ids_from(args: argparse.Namespace) -> list[str]:
    given = list(args.ids or [])
    if getattr(args, "file", None):
        text = read_text(args.file, "the id file")
        for line in text.splitlines():
            line = line.split("#", 1)[0]
            given.extend(t for t in re.split(r"[\s,;]+", line) if t)
    if not given:
        raise Fail("give at least one id, or --file with one id per line")
    seen: set[str] = set()
    return [g for g in given if not (g in seen or seen.add(g))]


# ---------------------------------------------------------------- arXiv's Atom feed


def clean(text: str | None) -> str | None:
    return " ".join(text.split()) if text and text.strip() else None


WITHDRAWN_COMMENT = re.compile(r"\bwithdrawn\b", re.I)
WITHDRAWN_ABSTRACT = re.compile(r"\b(?:paper|article|submission|manuscript|version|preprint)\s+(?:has\s+been|is|was)"
                                r"\s+withdrawn\b|^withdrawn\b", re.I)


def entry_to_paper(e: ET.Element) -> dict[str, Any]:
    raw_id = (e.findtext(f"{ATOM}id") or "").strip()
    vid = raw_id.split("/abs/", 1)[-1]
    a = parse_id(vid, quiet=True)
    if not a.version:
        raise Fail(f"arXiv's feed gave {raw_id!r} with no version")
    authors, affiliations = [], {}
    for au in e.findall(f"{ATOM}author"):
        name = clean(au.findtext(f"{ATOM}name"))
        if name:
            authors.append(name)
            aff = [clean(x.text) for x in au.findall(f"{ARXIV_NS}affiliation") if clean(x.text)]
            if aff:
                affiliations[name] = aff
    primary = e.find(f"{ARXIV_NS}primary_category")
    comment = clean(e.findtext(f"{ARXIV_NS}comment"))
    abstract = clean(e.findtext(f"{ATOM}summary"))
    paper: dict[str, Any] = {
        "id": a.base,
        "version": f"v{a.version}",
        "versioned_id": a.full,
        "title": clean(e.findtext(f"{ATOM}title")),
        "authors": authors,
        "submitted": (e.findtext(f"{ATOM}published") or "")[:10] or None,
        "version_date": (e.findtext(f"{ATOM}updated") or "")[:10] or None,
        "primary_category": primary.get("term") if primary is not None else None,
        "categories": [c.get("term") for c in e.findall(f"{ATOM}category") if c.get("term")],
        "abstract": abstract,
        "comment": comment,
        "journal_ref": clean(e.findtext(f"{ARXIV_NS}journal_ref")),
        "doi": clean(e.findtext(f"{ARXIV_NS}doi")),
        "abs_url": f"https://arxiv.org/abs/{a.full}",
        "pdf_url": f"https://arxiv.org/pdf/{a.full}",
        "html_url": f"https://arxiv.org/html/{a.full}",
    }
    if affiliations:
        paper["affiliations"] = affiliations
    if comment and WITHDRAWN_COMMENT.search(comment):
        paper["withdrawn_note"] = comment
    elif abstract and WITHDRAWN_ABSTRACT.search(abstract[:400]):
        paper["withdrawn_note"] = abstract[:400]
    return paper


def arxiv_feed(client: Client, params: dict[str, Any]) -> tuple[int, list[dict[str, Any]]]:
    """(totalResults, papers) for one API request."""
    status, _, body = client.request("api", client.api + "?" + urllib.parse.urlencode(params))
    if status != 200:
        raise Fail(f"arXiv's API refused the request ({one_line(body, status)})")
    try:
        root = ET.fromstring(body)
    except ET.ParseError:
        raise Fail("arXiv's API answered with something that isn't its Atom feed") from None
    if root.tag != f"{ATOM}feed":
        raise Fail("arXiv's API answered with something that isn't its Atom feed")
    entries = root.findall(f"{ATOM}entry")
    for e in entries:
        if "/api/errors" in (e.findtext(f"{ATOM}id") or ""):
            raise Fail(f"arXiv's API refused the request: {clean(e.findtext(f'{ATOM}summary')) or 'no reason given'}")
    try:
        total = int((root.findtext(f"{OPENSEARCH}totalResults") or "0").strip())
    except ValueError:
        total = 0
    return total, [entry_to_paper(e) for e in entries]


def fetch_ids(client: Client, ids: list[ArxivId], result: dict[str, Any]) -> tuple[dict[str, dict[str, Any]], list[str]]:
    """Papers by id, asked for in chunks: ({id as given: paper}, [ids not found]). Ids arXiv doesn't have are simply
    missing from its answer, so they're found by comparing."""
    found: dict[str, dict[str, Any]] = {}
    missing: list[str] = []
    for i in range(0, len(ids), ID_CHUNK):
        chunk = ids[i:i + ID_CHUNK]
        try:
            _, papers = arxiv_feed(client, {"id_list": ",".join(a.full for a in chunk), "max_results": len(chunk)})
        except Fail as e:
            if found or missing:
                result["papers"] = list(found.values())
                result["not_found"] = missing
                result["remaining"] = [a.given for a in ids[i:]]
                raise Stopped(str(e), result) from None
            raise
        by_version = {p["versioned_id"]: p for p in papers}
        by_base: dict[str, dict[str, Any]] = {}
        for p in papers:
            if p["id"] not in by_base or int(p["version"][1:]) > int(by_base[p["id"]]["version"][1:]):
                by_base[p["id"]] = p
        for a in chunk:
            hit = by_version.get(a.full) if a.version else by_base.get(a.base)
            if hit:
                found[a.given] = hit
            else:
                missing.append(a.given)
    return found, missing


# ---------------------------------------------------------------- search


FIELDS = {"all": "all", "title": "ti", "abstract": "abs"}
SORTS = {"relevance": "relevance", "submitted": "submittedDate", "updated": "lastUpdatedDate"}


def words_of(texts: list[str]) -> list[str]:
    """Each word on its own, with characters that mean something in arXiv's query syntax taken out."""
    out = []
    for text in texts:
        for w in re.sub(r'["()\[\]{}:]', " ", text).split():
            if w in ("OR", "ANDNOT", "NOT"):
                raise Fail(f"the words are all required, so {w} can't be one of them: for other combinations use "
                           "--query in arXiv's own syntax, and --exclude to leave words out")
            if w != "AND":
                out.append(w)
    return out


def day(text: str, end: bool) -> str:
    """YYYYMMDDTTTT for a date written YYYY, YYYY-MM or YYYY-MM-DD: the start of that span, or with end its last minute."""
    m = re.fullmatch(r"(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?", text.strip())
    if not m:
        raise Fail(f"can't read the date {text!r}: write it as 2024, 2024-03 or 2024-03-15")
    year, month, dd = int(m.group(1)), int(m.group(2) or (12 if end else 1)), m.group(3)
    try:
        if dd:
            d = datetime(year, month, int(dd))
        elif end:
            nxt = datetime(year + (month == 12), month % 12 + 1, 1)
            d = datetime.fromordinal(nxt.toordinal() - 1)
        else:
            d = datetime(year, month, 1)
    except ValueError:
        raise Fail(f"{text!r} isn't a date") from None
    return d.strftime("%Y%m%d") + ("2359" if end else "0000")


def build_query(args: argparse.Namespace) -> str:
    field = FIELDS[args.within]
    parts = [f"{field}:{w}" for w in words_of(args.words)]
    for p in args.phrase or []:
        words = words_of([p])
        if words:
            parts.append(f'{field}:"{" ".join(words)}"')
    for name in args.author or []:
        words = words_of([name])
        if words:
            parts.append(f'au:"{" ".join(words)}"' if len(words) > 1 else f"au:{words[0]}")
    cats = [f"cat:{c.strip()}" for c in args.category or [] if c.strip()]
    for c in cats:
        if not re.fullmatch(r"cat:[A-Za-z-]+(?:\.[A-Za-z-]+)?", c):
            raise Fail(f"{c[4:]!r} isn't an arXiv category: they look like cs.CL, math.AG or hep-th")
    if cats:
        parts.append(cats[0] if len(cats) == 1 else "(" + " OR ".join(cats) + ")")
    if args.date_from or args.date_to:
        start = day(args.date_from, end=False) if args.date_from else "199101010000"
        stop = day(args.date_to, end=True) if args.date_to else datetime.now(timezone.utc).strftime("%Y%m%d") + "2359"
        if start > stop:
            raise Fail("--from is after --to")
        parts.append(f"submittedDate:[{start} TO {stop}]")
    if args.query and args.query.strip():
        parts.append(f"({args.query.strip()})")
    if not parts:
        raise Fail("nothing to search for: give words, --phrase, --author, --category, dates or --query")
    query = parts[0] if len(parts) == 1 else " AND ".join(parts)
    left_out = [f"{field}:{w}" for w in words_of(args.exclude or [])]
    if left_out:
        group = left_out[0] if len(left_out) == 1 else "(" + " OR ".join(left_out) + ")"
        query = f"({query}) ANDNOT {group}" if len(parts) > 1 else f"{query} ANDNOT {group}"
    return query


def cmd_search(args: argparse.Namespace, client: Client) -> int:
    if args.oldest_first and args.sort == "relevance":
        raise Fail("--oldest-first goes with --sort submitted or --sort updated")
    if args.start + args.max > 30000:
        raise Fail("arXiv's API returns at most 30000 results for one query: narrow it down")
    query = build_query(args)
    result: dict[str, Any] = {
        "query": query,
        "sort": args.sort + (", oldest first" if args.oldest_first else ""),
        "searched_on": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "total": None,
        "start": args.start,
        "papers": [],
    }
    papers: list[dict[str, Any]] = result["papers"]
    at, tried_again = args.start, False
    while len(papers) < args.max:
        params = {"search_query": query, "start": at, "max_results": min(PAGE, args.max - len(papers)),
                  "sortBy": SORTS[args.sort], "sortOrder": "ascending" if args.oldest_first else "descending"}
        try:
            total, page = arxiv_feed(client, params)
        except Fail as e:
            if papers:
                result["returned"] = len(papers)
                raise Stopped(str(e), result) from None
            raise
        result["total"] = total
        if not page:
            if at < total and not tried_again:
                tried_again = True  # arXiv sometimes answers a page with no entries before the end: ask once more
                continue
            break
        papers.extend(page)
        at += len(page)
        if at >= total:
            break
    result["returned"] = len(papers)
    return finish(args, result, 0)


# ---------------------------------------------------------------- get and bibtex


def cmd_get(args: argparse.Namespace, client: Client) -> int:
    ids = [parse_id(g) for g in ids_from(args)]
    result: dict[str, Any] = {}
    found, missing = fetch_ids(client, ids, result)
    result = {"papers": [found[a.given] for a in ids if a.given in found], "not_found": missing}
    withdrawn = [p["versioned_id"] for p in result["papers"] if "withdrawn_note" in p]
    if withdrawn:
        result["maybe_withdrawn"] = withdrawn
    return finish(args, result, 1 if missing else 0)


def pin_version(text: str, a: ArxivId, version_date: str) -> tuple[str, dict[str, Any]]:
    """arXiv's entry names no version and gives the year of the latest one; point it at the version that was read."""
    year = re.search(r"\byear\s*=\s*\{(\d{4})\}", text)
    text = re.sub(r"(\beprint\s*=\s*\{)[^}]*(\})", lambda m: m.group(1) + a.full + m.group(2), text, count=1)
    text = re.sub(r"(\burl\s*=\s*\{)https?://arxiv\.org/abs/[^}]*(\})",
                  lambda m: m.group(1) + "https://arxiv.org/abs/" + a.full + m.group(2), text, count=1)
    text = re.sub(r"(\byear\s*=\s*\{)\d{4}(\})", lambda m: m.group(1) + version_date[:4] + m.group(2), text, count=1)
    return text, {"version": f"v{a.version}", "version_date": version_date,
                  "year_arxiv_gave": year.group(1) if year else None}


def cmd_bibtex(args: argparse.Namespace, client: Client) -> int:
    ids = [parse_id(g) for g in ids_from(args)]
    result: dict[str, Any] = {"entries": [], "not_found": []}
    dates: dict[str, str] = {}
    versioned = [a for a in ids if a.version]
    if versioned:
        try:
            found, _ = fetch_ids(client, versioned, {})
        except Stopped as e:  # nothing fetched from arxiv.org yet, so there's nothing to keep
            raise Fail(str(e)) from None
        dates = {found[a.given]["versioned_id"]: found[a.given]["version_date"] for a in versioned if a.given in found}
    pages: dict[str, str | None] = {}
    for n, a in enumerate(ids):
        if a.version and a.full not in dates:
            result["not_found"].append(a.given)  # arXiv has no such version
            continue
        if a.base not in pages:
            try:
                status, _, body = client.request("site", f"{client.site}/bibtex/{a.base}")
                if status == 404:
                    pages[a.base] = None
                elif status != 200:
                    raise Fail(f"arxiv.org's BibTeX page for {a.base} failed ({one_line(body, status)})")
                else:
                    text = body.decode("utf-8", "replace").strip()
                    if not text.startswith("@"):
                        raise Fail(f"arxiv.org didn't answer with BibTeX for {a.base}")
                    pages[a.base] = text
            except Fail as e:
                if result["entries"] or result["not_found"]:
                    result["remaining"] = [b.given for b in ids[n:]]
                    raise Stopped(str(e), result) from None
                raise
        text = pages[a.base]
        if text is None:
            result["not_found"].append(a.given)
            continue
        entry: dict[str, Any] = {"id": a.given}
        if a.version:
            text, entry["pinned"] = pin_version(text, a, dates[a.full])
        entry["bibtex"] = text
        result["entries"].append(entry)
    code = 1 if result["not_found"] else 0
    if args.out and result["entries"]:
        return finish(args, result, code, "\n\n".join(e["bibtex"] for e in result["entries"]) + "\n")
    if args.out:
        emit(result)  # nothing to write
        return code
    return finish(args, result, code)


# ---------------------------------------------------------------- Semantic Scholar


def s2_id(given: str) -> str:
    """The form Semantic Scholar takes: ARXIV:<id> without the version (it keeps one record per paper), DOI:...,
    or its own ids, which pass through."""
    s = given.strip()
    up = s.upper()
    if up.startswith("ARXIV:"):
        return "ARXIV:" + parse_id(s[6:]).base
    if up.startswith(("DOI:", "CORPUSID:", "MAG:", "ACL:", "PMID:", "PMCID:", "URL:")):
        return s
    if re.fullmatch(r"[0-9a-f]{40}", s):
        return s
    m = re.fullmatch(r"(?:https?://(?:dx\.)?doi\.org/)?(10\.\d{4,9}/\S+)", s, re.I)
    if m:
        return "DOI:" + m.group(1)
    m = re.fullmatch(r"https?://(?:www\.)?semanticscholar\.org/paper/(?:[^/]+/)?([0-9a-f]{40})/?", s)
    if m:
        return m.group(1)
    try:
        return "ARXIV:" + parse_id(s).base
    except Fail:
        raise Fail(f"can't tell what {given!r} is: give an arXiv id, a DOI, or a Semantic Scholar id") from None


def s2_call(client: Client, path: str, params: dict[str, Any] | None = None, body: Any = None) -> tuple[int, Any]:
    url = client.s2 + path + ("?" + urllib.parse.urlencode(params) if params else "")
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if client.key:
        headers["x-api-key"] = client.key
    status, _, raw = client.request("s2", url, data, headers)
    if status == 429:
        raise Fail(S2_TOO_MANY if not client.key else
                   "Semantic Scholar is turning requests away (429 Too Many Requests) at the key's rate: wait and try again")
    if status in (401, 403):
        raise Fail(f"Semantic Scholar refused the key in {KEY_VAR} (HTTP {status})" if client.key else
                   f"Semantic Scholar refused the request ({one_line(raw, status)})")
    try:
        parsed = json.loads(raw.decode("utf-8"))
    except ValueError:
        raise Fail(f"Semantic Scholar answered with something that isn't JSON ({one_line(raw, status)})") from None
    if status == 404:
        return 404, parsed
    if status != 200:
        raise Fail(f"Semantic Scholar refused the request ({one_line(raw, status)})")
    return status, parsed


def s2_paper(p: dict[str, Any], short: bool = False) -> dict[str, Any]:
    ext = p.get("externalIds") or {}
    names = [a.get("name") for a in p.get("authors") or [] if isinstance(a, dict) and a.get("name")]
    out: dict[str, Any] = {"paperId": p.get("paperId"), "title": p.get("title"), "year": p.get("year")}
    out["authors"] = names[:5] if short else names
    if short and len(names) > 5:
        out["author_count"] = len(names)
    for key in ("venue", "publicationDate", "citationCount", "influentialCitationCount", "referenceCount"):
        if key in p:
            out[key] = p[key] if p[key] != "" else None
    out["arxiv"] = ext.get("ArXiv")
    out["doi"] = ext.get("DOI")
    if "openAccessPdf" in p:
        out["openAccessPdf"] = (p.get("openAccessPdf") or {}).get("url") or None
    out["url"] = p.get("url")
    return out


def cmd_paper(args: argparse.Namespace, client: Client) -> int:
    given = ids_from(args)
    wanted = [s2_id(g) for g in given]
    result: dict[str, Any] = {"papers": [], "not_found": []}
    for i in range(0, len(wanted), S2_CHUNK):
        chunk = wanted[i:i + S2_CHUNK]
        try:
            _, data = s2_call(client, "/graph/v1/paper/batch", {"fields": S2_PAPER_FIELDS}, {"ids": chunk})
            if not isinstance(data, list) or len(data) != len(chunk):
                raise Fail("Semantic Scholar's batch answer didn't match the ids sent")
        except Fail as e:
            if result["papers"] or result["not_found"]:
                result["remaining"] = given[i:]
                raise Stopped(str(e), result) from None
            raise
        for g, item in zip(given[i:i + S2_CHUNK], data):
            if isinstance(item, dict) and item.get("paperId"):
                result["papers"].append({"asked": g, **s2_paper(item)})
            else:
                result["not_found"].append(g)
    return finish(args, result, 1 if result["not_found"] else 0)


def sort_papers(papers: list[dict[str, Any]], how: str) -> None:
    if how == "citations":
        papers.sort(key=lambda p: -(p.get("citationCount") or 0))
    elif how == "newest":
        papers.sort(key=lambda p: -(p.get("year") or 0))


def links(args: argparse.Namespace, client: Client, kind: str) -> int:
    pid = s2_id(args.id)
    fields = S2_LIST_FIELDS + ",isInfluential" + (",contexts,intents" if args.contexts else "")
    path = f"/graph/v1/paper/{urllib.parse.quote(pid, safe=':/')}/{kind}"
    status, data = s2_call(client, path, {"fields": fields, "limit": args.max})
    if status == 404:
        return finish(args, {"paper": args.id, "not_found": [args.id]}, 1)
    if not isinstance(data, dict) or not isinstance(data.get("data"), list):
        raise Fail(f"Semantic Scholar's answer about {kind} wasn't the list it should be")
    inner = "citingPaper" if kind == "citations" else "citedPaper"
    papers = []
    for item in data["data"]:
        p = s2_paper(item.get(inner) or {}, short=True)
        p["isInfluential"] = item.get("isInfluential")
        if args.contexts:
            p["contexts"] = item.get("contexts") or []
            p["intents"] = item.get("intents") or []
        papers.append(p)
    sort_papers(papers, args.sort)
    key = "citing_papers" if kind == "citations" else "references"
    result = {"paper": args.id, "asked_as": pid, "returned": len(papers), "more_available": "next" in data,
              "sorted_by": args.sort, key: papers, "not_found": []}
    return finish(args, result, 0)


def cmd_cites(args: argparse.Namespace, client: Client) -> int:
    return links(args, client, "citations")


def cmd_refs(args: argparse.Namespace, client: Client) -> int:
    return links(args, client, "references")


def cmd_similar(args: argparse.Namespace, client: Client) -> int:
    liked = [s2_id(g) for g in args.ids]
    disliked = [s2_id(g) for g in args.not_ids or []]
    params = {"fields": S2_LIST_FIELDS, "limit": args.max}
    if len(liked) == 1 and not disliked:
        params["from"] = args.pool or "recent"
        status, data = s2_call(client, f"/recommendations/v1/papers/forpaper/{urllib.parse.quote(liked[0], safe=':/')}",
                               params)
    else:
        if args.pool:
            raise Fail("--pool works with one paper and no --not; several papers are matched against all of "
                       "Semantic Scholar's recommendations")
        status, data = s2_call(client, "/recommendations/v1/papers", params,
                               {"positivePaperIds": liked, "negativePaperIds": disliked})
    if status == 404:
        return finish(args, {"like": args.ids, "not_found": args.ids, "error": one_line(json.dumps(data).encode(), 404)}, 1)
    if not isinstance(data, dict) or not isinstance(data.get("recommendedPapers"), list):
        raise Fail("Semantic Scholar's recommendations answer wasn't the list it should be")
    papers = [s2_paper(p, short=True) for p in data["recommendedPapers"] if isinstance(p, dict)]
    return finish(args, {"like": args.ids, "unlike": args.not_ids or [], "returned": len(papers),
                         "recommended": papers, "not_found": []}, 0)


def cmd_author(args: argparse.Namespace, client: Client) -> int:
    name = " ".join(" ".join(args.name).replace("-", " ").split())  # the search finds nothing for hyphenated words
    if not name:
        raise Fail("give an author's name")
    _, data = s2_call(client, "/graph/v1/author/search",
                      {"query": name, "fields": "name,affiliations,paperCount,citationCount,hIndex,url",
                       "limit": args.max})
    if not isinstance(data, dict) or not isinstance(data.get("data"), list):
        raise Fail("Semantic Scholar's author search answer wasn't the list it should be")
    authors = [{k: a.get(k) for k in ("authorId", "name", "affiliations", "paperCount", "citationCount", "hIndex",
                                      "url")} for a in data["data"] if isinstance(a, dict)]
    return finish(args, {"query": name, "total": data.get("total"), "returned": len(authors), "authors": authors}, 0)


# ---------------------------------------------------------------- output and the command line


def finish(args: argparse.Namespace, result: dict[str, Any], code: int, text: str | None = None) -> int:
    """Print the result, or write it to --out and print a short summary."""
    if not args.out:
        emit(result)
        return code
    data = text if text is not None else json.dumps({**NOTES, **result}, ensure_ascii=False, indent=2) + "\n"
    write_atomic(args.out, data.encode("utf-8"))
    summary: dict[str, Any] = {"wrote": os.path.abspath(args.out)}
    for key, value in result.items():
        if isinstance(value, list) and key not in ("not_found", "remaining", "maybe_withdrawn"):
            summary[key] = len(value)
        elif key in ("total", "query", "not_found", "maybe_withdrawn", "returned"):
            summary[key] = value
    emit(summary)
    return code


def check_out(args: argparse.Namespace) -> None:
    out = getattr(args, "out", None)
    if not out:
        return
    if os.path.isdir(out):
        raise Fail(f"--out is a folder, not a file: {out}")
    if getattr(args, "file", None) and same_file(out, args.file):
        raise Fail(f"won't write over the id file {args.file}: give --out another path")
    if os.path.exists(out) and not args.overwrite:
        raise Fail(f"{out} already exists: give another --out path, or add --overwrite to replace it")


def count(low: int, high: int, what: str) -> Callable[[str], int]:
    def parse(text: str) -> int:
        try:
            n = int(text)
        except ValueError:
            raise argparse.ArgumentTypeError(f"{what} is a whole number, not {text!r}") from None
        if not low <= n <= high:
            raise argparse.ArgumentTypeError(f"{what} is from {low} to {high}")
        return n
    return parse


def seconds(text: str) -> float:
    try:
        n = float(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"--timeout is a number of seconds, not {text!r}") from None
    if not (n > 0 and math.isfinite(n)):
        raise argparse.ArgumentTypeError("--timeout is a number of seconds above 0")
    return n


PACING = ("One request at a time: 3 seconds apart for arXiv's API, 15 for arxiv.org's BibTeX pages, 1 for Semantic "
          "Scholar, and the same wait before it ends. A Semantic Scholar key is read from " + KEY_VAR + ".")
EXITS = ("Exit codes: 0 done; 1 some papers weren't found (see \"not_found\"); 2 it couldn't do the job, with the "
         "reason on stderr.")


def build_parser() -> Parser:
    common = Parser(add_help=False)
    common.add_argument("--out", metavar="FILE", help="write the result to this file instead of stdout (bibtex: a .bib "
                        "file); stdout then gets a short summary")
    common.add_argument("--overwrite", action="store_true", help="let --out replace an existing file")
    common.add_argument("--timeout", type=seconds, default=60.0, metavar="SECONDS",
                        help="seconds to wait for each answer (default 60)")

    parser = Parser(prog="arxiv_search.py", description="Search arXiv, fetch papers by id, get arXiv's BibTeX, and look "
                    "papers up on Semantic Scholar.", epilog=PACING + " " + EXITS)
    sub = parser.add_subparsers(dest="command", metavar="COMMAND")

    def command(name: str, helptext: str, func: Callable[[argparse.Namespace, Client], int]) -> Parser:
        p = sub.add_parser(name, parents=[common], help=helptext, description=helptext, epilog=EXITS)
        p.set_defaults(func=func)
        return p

    s = command("search", "Search arXiv. Every word must appear (they are joined with AND); --phrase keeps words "
                "together; the options narrow it further.", cmd_search)
    s.add_argument("words", nargs="*", help="words that must all appear")
    s.add_argument("--phrase", action="append", metavar="TEXT", help="an exact phrase that must appear (repeatable)")
    s.add_argument("--in", dest="within", choices=sorted(FIELDS), default="all",
                   help="where the words, phrases and exclusions are looked for (default all: title, abstract, "
                   "authors, comments and more)")
    s.add_argument("--author", action="append", metavar="NAME", help="an author, such as LeCun or 'Yann LeCun' "
                   "(repeatable: all of them)")
    s.add_argument("--category", action="append", metavar="CAT", help="an arXiv category such as cs.CL (repeatable: "
                   "any of them)")
    s.add_argument("--exclude", action="append", metavar="WORD", help="leave out papers with this word (repeatable)")
    s.add_argument("--from", dest="date_from", metavar="DATE", help="first submitted on or after: 2024, 2024-03 or "
                   "2024-03-15 (GMT)")
    s.add_argument("--to", dest="date_to", metavar="DATE", help="first submitted on or before (same forms)")
    s.add_argument("--query", metavar="RAW", help="more conditions in arXiv's own syntax, such as "
                   "'ti:GPT OR ti:BERT', added with AND")
    s.add_argument("--sort", choices=list(SORTS), default="relevance",
                   help="relevance (default), submitted (first version's date) or updated (latest version's date)")
    s.add_argument("--oldest-first", action="store_true", help="with --sort submitted or updated: oldest first "
                   "instead of newest")
    s.add_argument("--max", type=count(1, 2000, "--max"), default=10, metavar="N", help="results to return, 1 to 2000 (default 10; "
                   "asked for 100 at a time)")
    s.add_argument("--start", type=count(0, 29999, "--start"), default=0, metavar="N", help="skip this many results first "
                   "(default 0)")

    g = command("get", "Fetch papers by arXiv id. With a version (2401.01234v2) you get that version; without, the "
                "latest.", cmd_get)
    g.add_argument("ids", nargs="*", metavar="ID", help="2401.01234, 2401.01234v2, hep-th/0601001, arXiv:..., or an "
                   "arxiv.org link")
    g.add_argument("--file", metavar="IDS", help="a text file of ids, one per line (or separated by spaces or commas)")

    b = command("bibtex", "arXiv's own BibTeX entries. arXiv's entry names no version and gives the latest version's "
                "year; for an id with a version, the entry is pinned to that version (eprint, url and year).", cmd_bibtex)
    b.add_argument("ids", nargs="*", metavar="ID", help="arXiv ids, with the version you read")
    b.add_argument("--file", metavar="IDS", help="a text file of ids")

    p = command("paper", "Semantic Scholar's record of papers: citation counts, venue, open-access PDF.", cmd_paper)
    p.add_argument("ids", nargs="*", metavar="ID", help="arXiv ids, DOIs (10.xxxx/... or DOI:...), or Semantic "
                   "Scholar ids (CorpusId:..., ACL:..., PMID:..., its 40-character paperId)")
    p.add_argument("--file", metavar="IDS", help="a text file of ids")

    for name, what, func in (("cites", "Papers that cite this one, from Semantic Scholar.", cmd_cites),
                             ("refs", "Papers this one cites, from Semantic Scholar.", cmd_refs)):
        c = command(name, what, func)
        c.add_argument("id", metavar="ID", help="an arXiv id, DOI or Semantic Scholar id")
        c.add_argument("--max", type=count(1, 1000, "--max"), default=100, metavar="N", help="papers to fetch, 1 to 1000 "
                       "(default 100)")
        c.add_argument("--sort", choices=["citations", "newest", "as-given"], default="citations",
                       help="order of the fetched papers: most cited first (default), newest first, or as Semantic "
                       "Scholar gave them")
        c.add_argument("--contexts", action="store_true", help="add the sentences where the citation is made, and "
                       "Semantic Scholar's guess at why (intents)")

    r = command("similar", "Papers Semantic Scholar recommends: like these, and unlike any given with --not.",
                cmd_similar)
    r.add_argument("ids", nargs="+", metavar="ID", help="one or more papers to find more like")
    r.add_argument("--not", dest="not_ids", action="append", metavar="ID", help="a paper to steer away from "
                   "(repeatable)")
    r.add_argument("--pool", choices=["recent", "all-cs"], help="with one paper: recommend from recent papers "
                   "(default) or from all of computer science")
    r.add_argument("--max", type=count(1, 500, "--max"), default=20, metavar="N", help="papers to return, 1 to 500 (default 20)")

    a = command("author", "Find authors on Semantic Scholar by name: affiliations, paper and citation counts, "
                "h-index.", cmd_author)
    a.add_argument("name", nargs="+", help="the author's name")
    a.add_argument("--max", type=count(1, 100, "--max"), default=10, metavar="N", help="authors to return, 1 to 100 (default 10)")
    return parser


def main(argv: list[str] | None = None) -> int:
    utf8_output()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.error("needs a command, such as search")
    prog = f"arxiv_search.py {args.command}"
    client = None
    try:
        check_out(args)
        client = Client(args.timeout)
        return args.func(args, client)
    except Stopped as e:
        emit({**e.partial, "stopped": str(e)})
        why = str(e)
    except Fail as e:
        why = str(e)
    except OSError as e:  # an output file open in another program on Windows, a full disk
        where = e.filename2 or e.filename
        why = f"{e.strerror or e}" + (f": {where}" if where else "")
    except Exception as e:  # an answer shaped in a way nobody expected
        why = f"stopped unexpectedly ({type(e).__name__}: {e})"
    finally:
        if client is not None:
            client.settle()
    print(f"{prog}: " + " ".join(why.split()), file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
