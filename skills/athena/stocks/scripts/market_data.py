#!/usr/bin/env python3
"""Company filings and market prices, each figure with its source and time.

  cik       find a company's SEC number (CIK) by ticker, CIK or words from its name
  filings   a company's filings on SEC EDGAR, newest first, with links to the documents
  facts     figures a company reported to the SEC (XBRL): the concepts it reports, or one concept's values by period
  symbols   listings that match a ticker or name, with exchange, currency and type (Twelve Data; no key needed)
  quote     the latest price of one or more symbols, crypto and currency pairs included (Twelve Data or Tiingo)
  history   daily, weekly or monthly prices over a date range, with a summary (Twelve Data or Tiingo)

cik, filings and facts send the user's name and email in each request's User-Agent, as the SEC's fair-access rules
ask: --contact "<name> <email>" or the SEC_CONTACT environment variable. They keep under the SEC's 10 requests a
second.

quote and history need the user's key: TWELVE_DATA_API_KEY or TIINGO_API_KEY in the environment, or --key-file with
the key on its first line (then --provider says whose key it is). The key goes in a request header and is never
printed. Without --provider, Twelve Data is used when its key is set, else Tiingo. Twelve Data requests are paced to
--per-minute (8, its free plan); a longer list waits for the next minute.

Prints JSON on stdout; with --out, writes the whole result to that file and prints a summary. Exit codes: 0 done;
1 it ran, but something wasn't found or the run stopped partway ("problems" says what; the rest of the result is what
did come through, and "not_fetched" lists what's left); 2 it couldn't do the job, with one line on stderr.

MARKET_DATA_TEST_BASE, when set, sends every request to that address instead (the tests use a stand-in server).
Standard library only (Python 3.10+).
"""

from __future__ import annotations

import argparse
import codecs
import datetime as dt
import gzip
import http.client
import json
import locale
import os
import re
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import zlib
from dataclasses import dataclass
from typing import Any, Callable, NoReturn

USER_AGENT = "AthenaAgents/1.0 (market_data)"
SEC_DATA = "https://data.sec.gov"
SEC_WWW = "https://www.sec.gov"  # also the links in results, which always point at the real EDGAR
TWELVE_DATA = "https://api.twelvedata.com"
TIINGO = "https://api.tiingo.com"
SEC_GAP = 0.125  # seconds between SEC requests: 8 a second, under the SEC's 10
NET_ERRORS = (OSError, http.client.HTTPException)
KEY_ENV = {"twelvedata": "TWELVE_DATA_API_KEY", "tiingo": "TIINGO_API_KEY"}
SIGNUP = {"twelvedata": "https://twelvedata.com/pricing", "tiingo": "https://www.tiingo.com"}
PROVIDER = {"twelvedata": "Twelve Data", "tiingo": "Tiingo"}
ANNUAL_FORMS = {"10-K", "10-K/A", "10-KT", "10-KT/A", "20-F", "20-F/A", "40-F", "40-F/A"}
ADJUSTED = {"all": "for splits and dividends", "splits": "for splits only", "none": "no: prices as traded that day"}
TIINGO_FREQ = {"1day": "daily", "1week": "weekly", "1month": "monthly"}
SYMBOL = re.compile(r"[A-Za-z0-9][A-Za-z0-9.\-/:_]{0,31}")
EMAIL = re.compile(r"[^@\s<>\"]+@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})")
READING = ("filing_fy and filing_fp describe the filing that reported a value, not the value's period: go by start "
           "and end. Values are in the unit given (USD means dollars, not thousands).")


# ---------------------------------------------------------------- helpers (as in the pdf skill's scripts)


def utf8_output() -> None:
    # A Windows pipe is cp1252 unless the script says otherwise; company names and messages often aren't.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


class Fail(Exception):
    """A problem to report in one line and exit 2."""


# What a result also says, gathered while the command runs: an input read in an encoding other than UTF-8, and
# pauses made to keep to a service's limits.
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
    except Exception as e:  # an answer shaped like nothing the services send
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


# ---------------------------------------------------------------- talking to the services


class Missing(Exception):
    """One item isn't there (an unknown symbol, a concept the company doesn't report): noted, and the run goes on."""


class Stopped(Exception):
    """The service can't go on (a limit reached, the key refused, the network down): the run stops here."""


class SameHost(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only on the same host and never from https to http, so the key and the contact go only
    where they were meant to."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        new, old = urllib.parse.urlsplit(newurl), urllib.parse.urlsplit(req.full_url)
        if new.hostname != old.hostname or new.scheme not in ("http", "https") or (old.scheme, new.scheme) == ("https", "http"):
            return None  # urllib then raises an HTTPError with the redirect's status
        return super().redirect_request(req, fp, code, msg, headers, newurl)


class Window:
    """At most `count` requests in any `seconds`: before one more, wait for the oldest to age out."""

    def __init__(self, count: int, seconds: float, clock: Callable[[], float] = time.monotonic,
                 sleep: Callable[[float], None] = time.sleep):
        self.count, self.seconds, self.clock, self.sleep = count, seconds, clock, sleep
        self.times: list[float] = []
        self.waited = 0.0

    def wait(self) -> None:
        now = self.clock()
        self.times = [t for t in self.times if now - t < self.seconds]
        if len(self.times) >= self.count:
            pause = self.seconds - (now - self.times[0]) + 0.5  # a little over, for the service's clock
            self.sleep(pause)
            self.waited += pause
            now = self.clock()
            self.times = [t for t in self.times if now - t < self.seconds]
        self.times.append(now)


@dataclass
class Answer:
    status: int
    data: Any
    text: str
    host: str


def test_base() -> str | None:
    base = os.environ.get("MARKET_DATA_TEST_BASE", "").strip()
    if not base:
        return None
    parts = urllib.parse.urlsplit(base)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise Fail(f"MARKET_DATA_TEST_BASE takes an http or https address, not {base!r}")
    return base.rstrip("/")


class Web:
    def __init__(self, timeout: float, per_minute: int = 8):
        self.timeout = timeout
        self.base = test_base()
        handlers: list[Any] = [SameHost()] + ([urllib.request.ProxyHandler({})] if self.base else [])
        self.opener = urllib.request.build_opener(*handlers)
        self.sec_last = 0.0
        self.twelve = Window(per_minute, 60.0)
        self.secrets: list[str] = []  # never printed: taken out of anything a server says back

    def hide(self, text: str) -> str:
        for secret in self.secrets:
            text = text.replace(secret, "[key]")
        return text

    def get(self, service: str, root: str, path: str, query: dict[str, Any] | None = None,
            headers: dict[str, str] | None = None, agent: str = USER_AGENT) -> Answer:
        url = (self.base or root) + path + ("?" + urllib.parse.urlencode(query) if query else "")
        host = urllib.parse.urlsplit(root).hostname or root
        if service == "sec":
            gap = SEC_GAP - (time.monotonic() - self.sec_last)
            if gap > 0:
                time.sleep(gap)
        elif service == "twelvedata":
            self.twelve.wait()
        req = urllib.request.Request(url, headers={"User-Agent": agent, "Accept": "application/json",
                                                   "Accept-Encoding": "gzip", **(headers or {})})
        try:
            with self.opener.open(req, timeout=self.timeout) as res:
                status, raw, encoding = res.status, res.read(), res.headers.get("Content-Encoding", "")
        except urllib.error.HTTPError as e:
            status, encoding = e.code, (e.headers.get("Content-Encoding", "") if e.headers else "")
            try:
                raw = e.read()
            except NET_ERRORS:
                raw = b""
            e.close()
        except NET_ERRORS as e:
            why = " ".join(str(getattr(e, "reason", "") or e).split()) or type(e).__name__
            raise Stopped(f"couldn't reach {host}: {why}") from None
        finally:
            if service == "sec":
                self.sec_last = time.monotonic()
        if "gzip" in encoding.lower():
            try:
                raw = gzip.decompress(raw)
            except (OSError, EOFError, zlib.error):
                raise Stopped(f"{host} sent a damaged compressed answer") from None
        text = raw.decode("utf-8", "replace")
        try:
            data = json.loads(text)
        except ValueError:
            data = None
        if 300 <= status < 400:
            raise Stopped(f"{host} sent the request on to another address; not followed")
        return Answer(status, data, text, host)

    def said(self, a: Answer) -> str:
        """What an answer says about itself, in one line: a JSON message, an error page's title, or its first words."""
        message = ""
        if isinstance(a.data, dict):
            for k in ("message", "detail", "error"):
                if isinstance(a.data.get(k), str):
                    message = a.data[k]
                    break
        elif a.data is None:
            title = re.search(r"<title[^>]*>(.*?)</title>", a.text, re.I | re.S)
            message = title.group(1) if title else re.sub(r"<[^>]+>", " ", a.text)
        message = " ".join(message.replace("**", "").split())
        return self.hide(message[:200])


# ---------------------------------------------------------------- SEC EDGAR


def sec_contact(args: argparse.Namespace) -> str:
    contact = " ".join((args.contact or os.environ.get("SEC_CONTACT") or "").split())
    if not contact:
        raise Fail('the SEC asks every request to say who is asking: pass --contact "<name> <email>" with the '
                   "user's own name and email, or set SEC_CONTACT (ask the user; don't make one up)")
    m = EMAIL.search(contact)
    if not m or not contact.replace(m.group(0), "").strip():
        raise Fail('--contact needs a name and an email address, like "<name> <email>"')
    if m.group(1).lower() in ("example.com", "example.org", "example.net"):
        raise Fail(f"{m.group(0)} is an example address: ask the user which name and email to send")
    if not contact.isascii() or not contact.isprintable():
        raise Fail("write --contact in plain ASCII letters (a request header can't carry others)")
    return contact


def sec_json(web: Web, contact: str, root: str, path: str, what: str) -> dict[str, Any]:
    a = web.get("sec", root, path, agent=f"AthenaAgents {contact}")
    if a.status == 200 and isinstance(a.data, dict):
        return a.data
    if a.status == 404:
        raise Missing(f"{what} isn't on EDGAR")
    if a.status in (403, 429):
        raise Stopped(f"the SEC refused the request (HTTP {a.status}). It turns away requests without a contact in "
                      "the User-Agent and more than 10 a second: check --contact, and wait a few minutes before trying again")
    if a.status == 200:
        raise Stopped(f"{a.host} answered with something other than JSON")
    message = web.said(a)
    raise Stopped(f"HTTP {a.status} from {a.host}" + (f": {message}" if message else ""))


def ticker_list(web: Web, contact: str) -> list[tuple[int, str, str]]:
    """(cik, ticker, name) for every ticker in the SEC's list, in the list's own order."""
    data = sec_json(web, contact, SEC_WWW, "/files/company_tickers.json", "the SEC's ticker list")
    rows = []
    for entry in data.values():
        if isinstance(entry, dict) and isinstance(entry.get("cik_str"), int) and isinstance(entry.get("ticker"), str):
            rows.append((entry["cik_str"], entry["ticker"].upper(), str(entry.get("title") or "")))
    if not rows:
        raise Stopped("the SEC's ticker list came back empty")
    return rows


def find_companies(rows: list[tuple[int, str, str]], query: str) -> list[dict[str, Any]]:
    q = query.strip()
    if q.isdigit():
        hits = [r for r in rows if r[0] == int(q)]
    else:
        ticker = q.upper().replace(".", "-")  # the SEC writes share classes as BRK-B
        hits = [r for r in rows if r[1] == ticker]
        if not hits:
            words = q.lower().split()
            hits = [r for r in rows if words and all(w in r[2].lower() for w in words)]
    found: dict[int, dict[str, Any]] = {}
    for cik, ticker, name in hits:
        found.setdefault(cik, {"cik": f"{cik:010d}", "name": name, "tickers": []})
    for cik, ticker, _ in rows:  # every ticker of a company found, share classes included
        if cik in found and ticker not in found[cik]["tickers"]:
            found[cik]["tickers"].append(ticker)
    return list(found.values())


def resolve(web: Web, contact: str, company: str) -> int:
    company = company.strip()
    if company.isdigit() and 0 < len(company) <= 10:
        return int(company)
    hits = find_companies(ticker_list(web, contact), company)
    exact = [h for h in hits if company.upper().replace(".", "-") in h["tickers"]]
    if len(exact) == 1:
        return int(exact[0]["cik"])
    raise Fail(f"{company} isn't a ticker in the SEC's list: find the company's CIK with the cik command")


def cmd_cik(args: argparse.Namespace, web: Web) -> dict[str, Any]:
    contact = sec_contact(args)
    rows = ticker_list(web, contact)
    results, problems = [], []
    for query in args.query:
        hits = find_companies(rows, query)
        if not hits:
            problems.append(f"no company in the SEC's ticker list matches {query!r}")
        results.append({"query": query, "matches": hits[: args.limit], "more": max(0, len(hits) - args.limit)})
    return {"source": "SEC company_tickers.json", "results": results, "problems": problems}


def columns(block: Any) -> list[dict[str, Any]]:
    """EDGAR's filing lists are parallel arrays, one entry per filing; this makes them rows."""
    if not isinstance(block, dict) or not isinstance(block.get("accessionNumber"), list):
        return []
    keys = ("accessionNumber", "filingDate", "reportDate", "form", "primaryDocument", "primaryDocDescription", "items")
    arrays = {k: block.get(k) if isinstance(block.get(k), list) else [] for k in keys}
    return [{k: (arrays[k][i] if i < len(arrays[k]) else None) for k in keys} for i in range(len(arrays["accessionNumber"]))]


def filing_folder(cik: int, accession: str) -> str:
    return f"{SEC_WWW}/Archives/edgar/data/{cik}/{accession.replace('-', '')}"


def form_matches(form: str, wanted: set[str]) -> bool:
    form = form.upper()
    return form in wanted or (form.endswith("/A") and form[:-2] in wanted)


def cmd_filings(args: argparse.Namespace, web: Web) -> dict[str, Any]:
    contact = sec_contact(args)
    cik = resolve(web, contact, args.company)
    try:
        sub = sec_json(web, contact, SEC_DATA, f"/submissions/CIK{cik:010d}.json", f"CIK {cik:010d}")
    except Missing as e:
        return {"company": {"cik": f"{cik:010d}"}, "filings": [], "problems": [str(e)]}
    filings = sub.get("filings") if isinstance(sub.get("filings"), dict) else {}
    rows = columns(filings.get("recent"))
    older = [f for f in filings.get("files") or [] if isinstance(f, dict) and re.fullmatch(r"[\w.-]+\.json", str(f.get("name", "")))]
    problems: list[str] = []
    extra: dict[str, Any] = {}
    if args.older:
        for i, f in enumerate(older):
            if args.since and str(f.get("filingTo", "9999")) < args.since:
                continue
            try:
                rows += columns(sec_json(web, contact, SEC_DATA, f"/submissions/{f['name']}", f["name"]))
            except (Missing, Stopped) as e:
                problems.append(f"older filings: {e}")
                extra["not_fetched"] = [x["name"] for x in older[i:]]
                break
    wanted = {f.strip().upper() for f in (args.form or "").split(",") if f.strip()}
    picked = [r for r in rows if isinstance(r["form"], str) and isinstance(r["accessionNumber"], str)
              and (not wanted or form_matches(r["form"], wanted))
              and (not args.since or str(r["filingDate"] or "") >= args.since)]
    picked.sort(key=lambda r: str(r["filingDate"] or ""), reverse=True)
    out = []
    for r in picked[: args.limit]:
        folder = filing_folder(cik, r["accessionNumber"])
        out.append({
            "form": r["form"], "filed": r["filingDate"], "report_date": r["reportDate"] or None,
            "accession": r["accessionNumber"], "description": r["primaryDocDescription"] or None,
            "items": r["items"] or None,
            "document": f"{folder}/{r['primaryDocument']}" if r["primaryDocument"] else None,
            "index": f"{folder}/{r['accessionNumber']}-index.htm",
        })
    if not picked:
        problems.append("no filings match" + (f" --form {args.form}" if wanted else "") + (f" --since {args.since}" if args.since else ""))
    fye = str(sub.get("fiscalYearEnd") or "")
    result = {
        "company": {
            "cik": f"{cik:010d}", "name": sub.get("name"), "tickers": sub.get("tickers"), "exchanges": sub.get("exchanges"),
            "fiscal_year_end": f"{fye[:2]}-{fye[2:]}" if re.fullmatch(r"\d{4}", fye) else None,
            "industry": sub.get("sicDescription"), "category": sub.get("category"),
        },
        "source": "SEC EDGAR", "filings": out, "matched": len(picked), **extra,
    }
    if older and not args.older:
        result["older"] = (f"{sum(int(f.get('filingCount') or 0) for f in older)} older filings, from "
                           f"{min(str(f.get('filingFrom')) for f in older)}, are in {len(older)} more file(s): add --older")
    result["problems"] = problems
    return result


def period_kind(fact: dict[str, Any]) -> tuple[str, int | None]:
    if not fact.get("start"):
        return "instant", None
    days = (dt.date.fromisoformat(fact["end"]) - dt.date.fromisoformat(fact["start"])).days + 1
    if 350 <= days <= 380:  # 52- and 53-week years run 364 and 371 days
        return "year", days
    if 60 <= days <= 120:  # 12-, 13-, 14- and 16-week quarters
        return "quarter", days
    return "other", days


def series(facts: list[Any], period: str, since: str | None, cik: int) -> list[dict[str, Any]]:
    """One row per period: the value from the latest filing that reported it, with any different earlier values."""
    groups: dict[tuple[str, str], list[tuple[str, int | None, dict[str, Any]]]] = {}
    for f in facts:
        if not isinstance(f, dict) or "val" not in f or not isinstance(f.get("end"), str):
            continue
        kind, days = period_kind(f)
        form = str(f.get("form") or "")
        keep = (period == "all"
                or (period == "annual" and (kind == "year" or (kind == "instant" and form in ANNUAL_FORMS)))
                or (period == "quarter" and kind in ("quarter", "instant")))
        if keep and (not since or f["end"] >= since):
            groups.setdefault((str(f.get("start") or ""), f["end"]), []).append((kind, days, f))
    rows = []
    for (start, end), found in sorted(groups.items(), key=lambda g: (g[0][1], g[0][0])):
        found.sort(key=lambda x: str(x[2].get("filed") or ""))
        kind, days, latest = found[-1]
        accession = str(latest.get("accn") or "")
        row: dict[str, Any] = {
            "start": start or None, "end": end, "days": days, "value": latest["val"], "form": latest.get("form"),
            "filed": latest.get("filed"), "accession": accession or None, "filing_fy": latest.get("fy"),
            "filing_fp": latest.get("fp"),
            "calendar_frame": next((x[2]["frame"] for x in reversed(found) if x[2].get("frame")), None),
            "filing_index": f"{filing_folder(cik, accession)}/{accession}-index.htm" if accession else None,
        }
        earlier = [{"value": x[2]["val"], "filed": x[2].get("filed"), "accession": x[2].get("accn")}
                   for x in found[:-1] if x[2]["val"] != latest["val"]]
        if earlier:
            row["earlier_values"] = earlier
        rows.append(row)
    return rows


def cmd_facts(args: argparse.Namespace, web: Web) -> dict[str, Any]:
    contact = sec_contact(args)
    if args.concept and not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", args.concept):
        raise Fail(f"--concept takes a concept name like Revenues, not {args.concept!r}")
    cik = resolve(web, contact, args.company)
    if not args.concept:
        return list_concepts(args, web, contact, cik)
    data = None
    tried = [args.taxonomy] if args.taxonomy else ["us-gaap", "ifrs-full", "dei"]
    for taxonomy in tried:
        try:
            data = sec_json(web, contact, SEC_DATA, f"/api/xbrl/companyconcept/CIK{cik:010d}/{taxonomy}/{args.concept}.json",
                            f"{taxonomy}:{args.concept} for CIK {cik:010d}")
            break
        except Missing:
            continue
    if data is None:
        return {"company": {"cik": f"{cik:010d}"}, "concept": args.concept, "values": [],
                "problems": [f"CIK {cik:010d} reports no {args.concept} in {', '.join(tried)}: "
                             "list what it does report with --find"]}
    units = {u: v for u, v in (data.get("units") or {}).items() if isinstance(v, list)}
    problems: list[str] = []
    if args.unit and args.unit not in units:
        problems.append(f"no values in {args.unit}; this concept has {', '.join(units) or 'none'}")
        unit = None
    elif args.unit:
        unit = args.unit
    else:
        unit = "USD" if "USD" in units else max(units, key=lambda u: len(units[u]), default=None)
    rows = series(units[unit], args.period, args.since, cik) if unit else []
    if unit and not rows:
        problems.append(f"no {args.period} values" + (f" since {args.since}" if args.since else "")
                        + ("; try --period quarter or all" if args.period == "annual" else ""))
    return {
        "company": {"cik": f"{cik:010d}", "name": data.get("entityName")}, "source": "SEC EDGAR XBRL",
        "taxonomy": data.get("taxonomy"), "concept": data.get("tag"), "label": data.get("label"),
        "description": data.get("description"), "unit": unit,
        "other_units": {u: len(v) for u, v in units.items() if u != unit}, "period": args.period,
        "reading": READING, "values": rows, "problems": problems,
    }


def list_concepts(args: argparse.Namespace, web: Web, contact: str, cik: int) -> dict[str, Any]:
    try:
        data = sec_json(web, contact, SEC_DATA, f"/api/xbrl/companyfacts/CIK{cik:010d}.json", f"XBRL figures for CIK {cik:010d}")
    except Missing as e:
        return {"company": {"cik": f"{cik:010d}"}, "concepts": [], "problems": [str(e)]}
    facts = data.get("facts") if isinstance(data.get("facts"), dict) else {}
    words = (args.find or "").lower().split()
    found = []
    for taxonomy, concepts in facts.items():
        if (args.taxonomy and taxonomy != args.taxonomy) or not isinstance(concepts, dict):
            continue
        for name, c in concepts.items():
            label = str(c.get("label") or "") if isinstance(c, dict) else ""
            if not all(w in f"{name} {label}".lower() for w in words):
                continue
            units = {u: v for u, v in (c.get("units") or {}).items() if isinstance(v, list)}
            ends = [f["end"] for v in units.values() for f in v if isinstance(f, dict) and isinstance(f.get("end"), str)]
            found.append({"taxonomy": taxonomy, "concept": name, "label": label or None,
                          "units": {u: len(v) for u, v in units.items()},
                          "first_end": min(ends, default=None), "latest_end": max(ends, default=None)})
    found.sort(key=lambda c: (c["latest_end"] or "", c["concept"]), reverse=True)  # what's still reported first
    problems = [] if found else [f"no concept matches {args.find!r}" if words else "no XBRL figures"]
    return {
        "company": {"cik": f"{cik:010d}", "name": data.get("entityName")}, "source": "SEC EDGAR XBRL",
        "taxonomies": {t: len(c) for t, c in facts.items() if isinstance(c, dict)},
        "matched": len(found), "concepts": found[: args.limit], "problems": problems,
    }


# ---------------------------------------------------------------- prices


def api_key(args: argparse.Namespace, provider: str, web: Web) -> str:
    if args.key_file:
        lines = [line.strip() for line in read_text(args.key_file, "the key file").splitlines() if line.strip()]
        if not lines:
            raise Fail(f"the key file {args.key_file} is empty")
        key = lines[0]
    else:
        key = os.environ.get(KEY_ENV[provider], "").strip()
        if not key:
            raise Fail(f"{args.command} with {PROVIDER[provider]} needs the user's API key: set {KEY_ENV[provider]} or pass "
                       f"--key-file (the user signs up at {SIGNUP[provider]})")
    if not key.isascii() or not key.isprintable() or any(c.isspace() for c in key):
        raise Fail("the API key has spaces or unusual characters in it: check where it came from")
    web.secrets.append(key)
    return key


def pick_provider(args: argparse.Namespace) -> str:
    if args.provider:
        return args.provider
    if args.key_file:
        raise Fail("with --key-file, say whose key it is: --provider twelvedata or --provider tiingo")
    for provider in ("twelvedata", "tiingo"):
        if os.environ.get(KEY_ENV[provider], "").strip():
            return provider
    raise Fail(f"{args.command} needs the user's key for a price provider: set TWELVE_DATA_API_KEY ({SIGNUP['twelvedata']}) "
               f"or TIINGO_API_KEY ({SIGNUP['tiingo']}), or pass --provider with --key-file")


def num(value: Any) -> float | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    return n if n == n else None  # NaN is no number


def whole(value: Any) -> int | None:
    n = num(value)
    return int(n) if n is not None else None


def pair_currency(symbol: str) -> str | None:
    """A currency or crypto pair (BTC/USD) is priced in its second half."""
    return symbol.split("/", 1)[1].upper() if "/" in symbol else None


def utc(ts: Any) -> str | None:
    n = whole(ts)
    return dt.datetime.fromtimestamp(n, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if n else None


def change_of(price: float | None, before: float | None) -> tuple[float | None, float | None]:
    if price is None or not before:
        return None, None
    return round(price - before, 6), round((price - before) / before * 100, 4)


def twelve(web: Web, key: str, path: str, query: dict[str, Any], what: str) -> dict[str, Any]:
    a = web.get("twelvedata", TWELVE_DATA, path, query, {"Authorization": f"apikey {key}"})
    d = a.data
    if a.status == 200 and isinstance(d, dict) and d.get("status") != "error":
        return d
    code = d.get("code") if isinstance(d, dict) and isinstance(d.get("code"), int) else a.status
    message = web.said(a)
    if code == 429:
        raise Stopped(f"Twelve Data's request limit was reached ({message})")
    if code == 401:
        raise Stopped(f"Twelve Data refused the key ({message})")
    if code in (400, 404):
        raise Missing(f"{what}: {message or 'not found'}")
    if code == 403:
        raise Missing(f"{what}: not on the user's Twelve Data plan ({message})")
    raise Stopped(f"HTTP {a.status} from Twelve Data" + (f": {message}" if message else ""))


def tiingo(web: Web, key: str, path: str, query: dict[str, Any] | None, what: str, want: type) -> Any:
    a = web.get("tiingo", TIINGO, path, query, {"Authorization": f"Token {key}"})
    message = web.said(a)
    if a.status == 200 and isinstance(a.data, want):
        return a.data
    if a.status == 404:
        raise Missing(f"{what}: Tiingo has no such ticker" + (f" ({message})" if message else ""))
    if a.status in (401, 403):
        raise Stopped(f"Tiingo refused the key (HTTP {a.status}" + (f": {message})" if message else ")"))
    if a.status == 429:
        raise Stopped("Tiingo's request limit was reached" + (f" ({message})" if message else ""))
    if a.status == 200:
        raise Stopped("Tiingo said: " + (message or "something other than prices"))
    raise Stopped(f"HTTP {a.status} from Tiingo" + (f": {message}" if message else ""))


def tiingo_ticker(symbol: str) -> str:
    if "/" in symbol or ":" in symbol:
        raise Missing(f"{symbol}: this script reads stocks and funds from Tiingo; use Twelve Data for currency and crypto pairs")
    return urllib.parse.quote(symbol, safe="")


def quote_twelve(web: Web, key: str, symbol: str, exchange: str | None) -> dict[str, Any]:
    d = twelve(web, key, "/quote", {"symbol": symbol, **({"exchange": exchange} if exchange else {})}, symbol)
    price, before = num(d.get("close")), num(d.get("previous_close"))
    change, pct = change_of(price, before)
    week = d.get("fifty_two_week") if isinstance(d.get("fifty_two_week"), dict) else {}
    low, high = num(week.get("low")), num(week.get("high"))
    is_open = d.get("is_market_open")
    return {
        "symbol": d.get("symbol") or symbol, "name": d.get("name"), "exchange": d.get("exchange"),
        "mic_code": d.get("mic_code"), "currency": d.get("currency") or pair_currency(symbol),
        "price": price,
        "price_is": "the latest price, while the market is open" if is_open else "the last close",
        "quote_time_utc": utc(d.get("last_quote_at") or d.get("timestamp")), "trading_day": d.get("datetime"),
        "market_open": is_open if isinstance(is_open, bool) else None,
        "previous_close": before, "change": num(d.get("change")) if d.get("change") is not None else change,
        "change_pct": num(d.get("percent_change")) if d.get("percent_change") is not None else pct,
        "open": num(d.get("open")), "high": num(d.get("high")), "low": num(d.get("low")), "volume": whole(d.get("volume")),
        "fifty_two_week": {
            "low": low, "high": high,
            # how far the price sits from the range's ends: not the change over 52 weeks (history gives that)
            "above_low_pct": round((price - low) / low * 100, 2) if price is not None and low else None,
            "below_high_pct": round((high - price) / high * 100, 2) if price is not None and high else None,
        },
    }


def quote_tiingo(web: Web, key: str, symbol: str) -> dict[str, Any]:
    ticker = tiingo_ticker(symbol)
    meta = tiingo(web, key, f"/tiingo/daily/{ticker}", None, symbol, dict)
    start = (dt.date.today() - dt.timedelta(days=14)).isoformat()
    bars = [b for b in tiingo(web, key, f"/tiingo/daily/{ticker}/prices", {"startDate": start}, symbol, list) if isinstance(b, dict)]
    if not bars:
        raise Missing(f"{symbol}: Tiingo has no prices for it in the last two weeks")
    last, before = bars[-1], (bars[-2] if len(bars) > 1 else {})
    price, prev = num(last.get("close")), num(before.get("close"))
    change, pct = change_of(price, prev)
    return {
        "symbol": str(meta.get("ticker") or symbol).upper(), "name": meta.get("name"),
        "exchange": meta.get("exchangeCode"), "currency": None, "price": price,
        "price_is": "the end-of-day close (Tiingo's free data is end of day)", "quote_time_utc": None,
        "trading_day": str(last.get("date") or "")[:10] or None, "previous_close": prev, "change": change,
        "change_pct": pct, "open": num(last.get("open")), "high": num(last.get("high")), "low": num(last.get("low")),
        "volume": whole(last.get("volume")),
    }


def history_twelve(web: Web, key: str, symbol: str, args: argparse.Namespace, start: dt.date, end: dt.date) -> dict[str, Any]:
    query = {"symbol": symbol, "interval": args.interval, "start_date": start.isoformat(),
             # Twelve Data's end_date leaves that day out; the script's --end keeps it in
             "end_date": (end + dt.timedelta(days=1)).isoformat(), "order": "asc", "adjust": args.adjust,
             "outputsize": 5000, **({"exchange": args.exchange} if args.exchange else {})}
    d = twelve(web, key, "/time_series", query, symbol)
    meta = d.get("meta") if isinstance(d.get("meta"), dict) else {}
    bars = [{"date": v.get("datetime"), "open": num(v.get("open")), "high": num(v.get("high")),
             "low": num(v.get("low")), "close": num(v.get("close")), "volume": whole(v.get("volume"))}
            for v in d.get("values") or [] if isinstance(v, dict) and v.get("datetime")]
    bars.sort(key=lambda b: str(b["date"]))
    out = {"symbol": meta.get("symbol") or symbol, "name": None, "exchange": meta.get("exchange"),
           "mic_code": meta.get("mic_code"), "currency": meta.get("currency") or pair_currency(symbol),
           "timezone": meta.get("exchange_timezone"), "type": meta.get("type"), "bars": bars}
    if len(bars) >= 5000:
        out["cut_short"] = "Twelve Data sends at most 5000 bars: ask for a shorter range or a longer --interval"
    return out


def history_tiingo(web: Web, key: str, symbol: str, args: argparse.Namespace, start: dt.date, end: dt.date) -> dict[str, Any]:
    ticker = tiingo_ticker(symbol)
    meta = tiingo(web, key, f"/tiingo/daily/{ticker}", None, symbol, dict)
    raw = tiingo(web, key, f"/tiingo/daily/{ticker}/prices",
                 {"startDate": start.isoformat(), "endDate": end.isoformat(), "resampleFreq": TIINGO_FREQ[args.interval]},
                 symbol, list)
    adjusted = args.adjust == "all"

    def name(field: str) -> str:  # Tiingo's adjusted fields are adjOpen, adjClose, adjVolume...
        return f"adj{field[0].upper()}{field[1:]}" if adjusted else field

    bars = []
    for b in raw:
        if not isinstance(b, dict) or not b.get("date"):
            continue
        bar: dict[str, Any] = {"date": str(b["date"])[:10], **{f: num(b.get(name(f))) for f in ("open", "high", "low", "close")},
                               "volume": whole(b.get(name("volume")))}
        if num(b.get("divCash")):
            bar["dividend"] = num(b.get("divCash"))
        if num(b.get("splitFactor")) not in (None, 1.0):
            bar["split"] = num(b.get("splitFactor"))
        bars.append(bar)
    bars.sort(key=lambda b: b["date"])
    return {"symbol": str(meta.get("ticker") or symbol).upper(), "name": meta.get("name"),
            "exchange": meta.get("exchangeCode"), "currency": None, "bars": bars}


def summarize(bars: list[dict[str, Any]]) -> dict[str, Any] | None:
    closes = [b for b in bars if b.get("close") is not None]
    if not closes:
        return None
    first, last = closes[0], closes[-1]
    change, pct = change_of(last["close"], first["close"])
    highs = [b for b in bars if b.get("high") is not None]
    lows = [b for b in bars if b.get("low") is not None]
    summary: dict[str, Any] = {
        "bars": len(bars), "first": {"date": first["date"], "close": first["close"]},
        "last": {"date": last["date"], "close": last["close"]}, "change": change,
        "change_pct": round(pct, 2) if pct is not None else None,
    }
    if highs:
        top = max(highs, key=lambda b: b["high"])
        summary["highest"] = {"date": top["date"], "high": top["high"]}
    if lows:
        bottom = min(lows, key=lambda b: b["low"])
        summary["lowest"] = {"date": bottom["date"], "low": bottom["low"]}
    dividends = [{"date": b["date"], "amount": b["dividend"]} for b in bars if "dividend" in b]
    splits = [{"date": b["date"], "factor": b["split"]} for b in bars if "split" in b]
    if dividends:
        summary["dividends"] = dividends
    if splits:
        summary["splits"] = splits
    return summary


def each(items: list[str], fetch: Callable[[str], dict[str, Any]], result: dict[str, Any]) -> list[dict[str, Any]]:
    """Fetch item by item. An item that isn't there is noted; a service that stops ends the run, and what came
    through is still reported, with what's left under not_fetched. A stop before anything came through is a failure."""
    done = []
    for i, item in enumerate(items):
        try:
            done.append(fetch(item))
        except Missing as e:
            result["problems"].append(str(e))
        except Stopped as e:
            if i == 0:
                raise Fail(str(e)) from None
            result["problems"].append(f"stopped before {item}: {e}")
            result["not_fetched"] = items[i:]
            break
    return done


def symbols_of(args: argparse.Namespace) -> list[str]:
    out = []
    for s in args.symbols:
        if not SYMBOL.fullmatch(s):
            raise Fail(f"{s!r} doesn't look like a symbol (AAPL, BRK.B, BTC/USD)")
        if s.upper() not in out:
            out.append(s.upper())
    return out


def pacing_note(web: Web, args: argparse.Namespace) -> None:
    if web.twelve.waited:
        NOTES["paused"] = (f"waited {round(web.twelve.waited)} s to stay within {args.per_minute} Twelve Data requests "
                           "a minute")


def cmd_quote(args: argparse.Namespace, web: Web) -> dict[str, Any]:
    provider = pick_provider(args)
    if args.exchange and provider != "twelvedata":
        raise Fail("--exchange is for Twelve Data")
    symbols = symbols_of(args)
    key = api_key(args, provider, web)
    result: dict[str, Any] = {"provider": PROVIDER[provider], "quotes": [], "problems": []}
    if provider == "twelvedata":
        result["quotes"] = each(symbols, lambda s: quote_twelve(web, key, s, args.exchange), result)
    else:
        result["quotes"] = each(symbols, lambda s: quote_tiingo(web, key, s), result)
    pacing_note(web, args)
    return result


def date_arg(text: str) -> str:
    try:
        return dt.date.fromisoformat(text).isoformat()
    except ValueError:
        raise argparse.ArgumentTypeError(f"takes a date like 2025-01-31, not {text!r}") from None


def cmd_history(args: argparse.Namespace, web: Web) -> dict[str, Any]:
    provider = pick_provider(args)
    if args.exchange and provider != "twelvedata":
        raise Fail("--exchange is for Twelve Data")
    if provider == "tiingo" and args.adjust == "splits":
        raise Fail("Tiingo gives prices as traded (--adjust none) or adjusted for splits and dividends (--adjust all)")
    end = dt.date.fromisoformat(args.end) if args.end else dt.date.today()
    start = dt.date.fromisoformat(args.start) if args.start else end - dt.timedelta(days=365)
    if start > end:
        raise Fail(f"--start {start} is after --end {end}")
    symbols = symbols_of(args)
    key = api_key(args, provider, web)
    fetch = history_twelve if provider == "twelvedata" else history_tiingo
    result: dict[str, Any] = {"provider": PROVIDER[provider], "interval": args.interval,
                              "adjusted": ADJUSTED[args.adjust], "start": start.isoformat(), "end": end.isoformat(),
                              "series": [], "problems": []}

    def one(symbol: str) -> dict[str, Any]:
        s = fetch(web, key, symbol, args, start, end)
        if not s["bars"]:
            raise Missing(f"{symbol}: no prices between {start} and {end}")
        if s.get("cut_short"):
            result["problems"].append(f"{symbol}: {s.pop('cut_short')}")
        return {**{k: v for k, v in s.items() if k != "bars"}, "summary": summarize(s["bars"]), "bars": s["bars"]}

    result["series"] = each(symbols, one, result)
    pacing_note(web, args)
    return result


def cmd_symbols(args: argparse.Namespace, web: Web) -> dict[str, Any]:
    a = web.get("twelvedata", TWELVE_DATA, "/symbol_search", {"symbol": args.query, "outputsize": args.limit})
    d = a.data
    if a.status != 200 or not isinstance(d, dict) or d.get("status") == "error":
        message = web.said(a)
        raise Fail(f"Twelve Data's symbol search answered HTTP {a.status}" + (f": {message}" if message else ""))
    listings = [{"symbol": x.get("symbol"), "name": x.get("instrument_name"), "exchange": x.get("exchange"),
                 "mic_code": x.get("mic_code"), "country": x.get("country"), "currency": x.get("currency"),
                 "type": x.get("instrument_type"), "timezone": x.get("exchange_timezone")}
                for x in d.get("data") or [] if isinstance(x, dict)]
    return {"provider": "Twelve Data", "query": args.query, "listings": listings,
            "problems": [] if listings else [f"no listing matches {args.query!r}"]}


def now_utc() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- command line

BULKY = ("filings", "values", "concepts", "listings")


def slim(result: dict[str, Any]) -> dict[str, Any]:
    """What --out prints: the result without its long lists, which are in the file."""
    out = {}
    for k, v in result.items():
        if k in BULKY and isinstance(v, list):
            out[k] = f"{len(v)} in the file"
        elif k == "series" and isinstance(v, list):
            out[k] = [{x: y for x, y in s.items() if x != "bars"} for s in v]
        else:
            out[k] = v
    return out


def positive(kind: type, name: str, most: float | None = None) -> Callable[[str], Any]:
    def parse(text: str) -> Any:
        try:
            value = kind(text)
        except ValueError:
            raise argparse.ArgumentTypeError(f"{name} takes a number, not {text!r}") from None
        if not value > 0 or (most is not None and value > most):
            raise argparse.ArgumentTypeError(f"{name} takes a number above 0" + (f" and up to {most:g}" if most else ""))
        return value
    return parse


def build_parser() -> argparse.ArgumentParser:
    p = Parser(prog="market_data.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="command", metavar="COMMAND")

    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--out", help="write the whole result to this JSON file and print a summary")
    common.add_argument("--timeout", type=positive(float, "--timeout", 600), default=30,
                        help="seconds to wait for each answer, up to 600 (default 30)")
    sec = argparse.ArgumentParser(add_help=False)
    sec.add_argument("--contact", help='the user\'s name and email for the SEC, like "<name> <email>" (default: SEC_CONTACT)')
    price = argparse.ArgumentParser(add_help=False)
    price.add_argument("--provider", choices=["twelvedata", "tiingo"], help="whose key to use (default: Twelve Data if its key is set, else Tiingo)")
    price.add_argument("--key-file", help="read the API key from the first line of this file instead of the environment")
    price.add_argument("--per-minute", type=positive(int, "--per-minute"), default=8,
                       help="most Twelve Data requests a minute (default 8, the free plan; raise it for a paid plan)")
    price.add_argument("--exchange", help="the exchange to read the symbols on, like LSE (Twelve Data)")

    def add(name: str, help_text: str, parents: list[argparse.ArgumentParser], example: str) -> argparse.ArgumentParser:
        return sub.add_parser(name, parents=parents, help=help_text, description=help_text,
                              epilog=f"example:\n  {example}", formatter_class=argparse.RawDescriptionHelpFormatter)

    sp = add("cik", "Find companies in the SEC's ticker list by ticker, CIK or words from the name.", [common, sec],
             'python market_data.py cik AAPL "berkshire hathaway" --contact "<name> <email>"')
    sp.add_argument("query", nargs="+", help="tickers, CIKs or names")
    sp.add_argument("--limit", type=positive(int, "--limit"), default=10, help="most companies per query (default 10)")

    sp = add("filings", "A company's filings on EDGAR, newest first, with links to each document and its index page.",
             [common, sec], 'python market_data.py filings AAPL --form 10-K,10-Q --limit 8 --contact "<name> <email>"')
    sp.add_argument("company", help="ticker or CIK")
    sp.add_argument("--form", help="only these forms, comma-separated, like 10-K,8-K (a form includes its /A amendments)")
    sp.add_argument("--since", type=date_arg, help="only filings made on or after this date (YYYY-MM-DD)")
    sp.add_argument("--limit", type=positive(int, "--limit"), default=20, help="most filings to list (default 20)")
    sp.add_argument("--older", action="store_true", help="also read the older filings EDGAR keeps in extra files")

    sp = add("facts", "Figures a company reported in XBRL: without --concept, the concepts it reports (with --find to "
             "search them); with --concept, that concept's values, one per period.", [common, sec],
             'python market_data.py facts AAPL --concept RevenueFromContractWithCustomerExcludingAssessedTax --contact "<name> <email>"')
    sp.add_argument("company", help="ticker or CIK")
    sp.add_argument("--concept", help="a concept name, like Revenues or NetIncomeLoss")
    sp.add_argument("--find", help="words that must all appear in a concept's name or label")
    sp.add_argument("--taxonomy", choices=["us-gaap", "ifrs-full", "dei"],
                    help="where the concept is defined (default: us-gaap, then ifrs-full, then dei)")
    sp.add_argument("--period", choices=["annual", "quarter", "all"], default="annual",
                    help="annual: year-long values and balances from annual reports; quarter: quarter-long values and "
                         "every balance; all: everything, year-to-date included (default annual)")
    sp.add_argument("--unit", help="the unit to read, like USD, EUR, shares or USD/shares (default: USD, else the most used)")
    sp.add_argument("--since", type=date_arg, help="only periods ending on or after this date (YYYY-MM-DD)")
    sp.add_argument("--limit", type=positive(int, "--limit"), default=50, help="most concepts to list (default 50)")

    sp = add("symbols", "Listings that match a ticker or name, with exchange, currency, country and type (Twelve Data; no key needed).",
             [common], "python market_data.py symbols SHEL")
    sp.add_argument("query")
    sp.add_argument("--limit", type=positive(int, "--limit", 120), default=10, help="most listings, up to 120 (default 10)")

    sp = add("quote", "The latest price of each symbol, with exchange, currency and time.", [common, price],
             "python market_data.py quote AAPL MSFT BTC/USD EUR/USD")
    sp.add_argument("symbols", nargs="+", metavar="SYMBOL", help="stock or fund tickers, or pairs like BTC/USD (Twelve Data)")

    sp = add("history", "Prices over a date range, with the change from the first close to the last, the high and the low.",
             [common, price], "python market_data.py history AAPL MSFT --start 2025-11-01 --end 2026-10-31 --out market-work/prices.json")
    sp.add_argument("symbols", nargs="+", metavar="SYMBOL")
    sp.add_argument("--start", type=date_arg, help="first day, YYYY-MM-DD (default: a year before --end)")
    sp.add_argument("--end", type=date_arg, help="last day, included, YYYY-MM-DD (default: today)")
    sp.add_argument("--interval", choices=list(TIINGO_FREQ), default="1day", help="bar length (default 1day)")
    sp.add_argument("--adjust", choices=list(ADJUSTED), default="all",
                    help="all: for splits and dividends (default); splits: splits only (Twelve Data); none: as traded")
    return p


COMMANDS: dict[str, Callable[[argparse.Namespace, Web], dict[str, Any]]] = {
    "cik": cmd_cik, "filings": cmd_filings, "facts": cmd_facts, "symbols": cmd_symbols, "quote": cmd_quote,
    "history": cmd_history,
}


def main(argv: list[str] | None = None) -> int:
    utf8_output()
    parser = build_parser()
    args = parser.parse_args(argv)
    if not args.command:
        parser.error("needs a command, such as quote or filings")

    def job() -> int:
        if args.out and os.path.isdir(args.out):
            raise Fail(f"--out is a folder, not a file: {args.out}")
        web = Web(args.timeout, getattr(args, "per_minute", 8))
        try:
            result = COMMANDS[args.command](args, web)
        except (Stopped, Missing) as e:
            raise Fail(str(e)) from None
        result = {"fetched_at_utc": now_utc(), **result}
        if args.out:
            text = json.dumps(result, ensure_ascii=False, indent=2).encode("utf-8")
            out = args.out
            os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
            write_atomic(out, lambda fh: fh.write(text))
            emit({"wrote": os.path.abspath(out), **slim(result)})
        else:
            emit(result)
        return 1 if result.get("problems") else 0

    return run_job(f"market_data.py {args.command}", job)


if __name__ == "__main__":
    sys.exit(main())
