"""A stand-in for the services market_data.py talks to: SEC EDGAR (www.sec.gov and data.sec.gov), Twelve Data and
Tiingo, all on one local address (their paths don't overlap), so MARKET_DATA_TEST_BASE can point the script at it.

The answers in responses/ are shaped like the live ones. Twelve Data's were captured with its public demo key in
November 2026; EDGAR's follow the live answers of the same month, trimmed to a few filings and facts (some accession
numbers and values are made up for the tests); Tiingo's come from the recorded answers in tiingo-python's tests.
Like the real services, EDGAR refuses a User-Agent without an email address and gzips its answers when asked;
Twelve Data answers errors as JSON with a code, a wrong key with 401, and leaves the end_date's own day out of a
time series; Tiingo keeps it in.
"""

from __future__ import annotations

import gzip
import json
import re
import threading
import urllib.parse
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

RESPONSES = Path(__file__).parent / "responses"
TWELVE_KEY = "td-test-0123456789abcdef"
TIINGO_KEY = "ti-test-fedcba9876543210"
CONTACT = "Ada Lovelace ada@lovelace.test"


def saved(name: str) -> Any:
    return json.loads((RESPONSES / name).read_text(encoding="utf-8"))


def _sec_files() -> dict[str, Any]:
    """EDGAR's answers by path."""
    files: dict[str, Any] = {"/files/company_tickers.json": saved("sec_company_tickers.json")}
    for path in sorted(RESPONSES.glob("sec_*.json")):
        name = path.stem
        if name.startswith("sec_submissions_"):
            files[f"/submissions/{name[len('sec_submissions_'):]}.json"] = saved(path.name)
        elif name.startswith("sec_companyfacts_"):
            files[f"/api/xbrl/companyfacts/{name[len('sec_companyfacts_'):]}.json"] = saved(path.name)
        elif name.startswith("sec_companyconcept_"):
            cik, taxonomy, concept = name[len("sec_companyconcept_"):].split("_", 2)
            files[f"/api/xbrl/companyconcept/{cik}/{taxonomy}/{concept}.json"] = saved(path.name)
    return files


@dataclass
class Seen:
    path: str
    query: dict[str, str]
    headers: dict[str, str]


@dataclass
class Fake:
    url: str = ""
    sec: dict[str, Any] = field(default_factory=_sec_files)
    quotes: dict[str, Any] = field(default_factory=lambda: saved("twelvedata_quote.json"))
    series: dict[str, Any] = field(default_factory=lambda: saved("twelvedata_time_series.json"))
    search: dict[str, Any] = field(default_factory=lambda: saved("twelvedata_symbol_search.json"))
    tiingo: dict[str, Any] = field(default_factory=lambda: saved("tiingo.json"))
    twelve_allowance: int | None = None  # Twelve Data requests left before it answers 429
    echo_key: bool = False  # a 401 that repeats the key it was given, to prove the script never prints one
    sec_status: int | None = None  # EDGAR answers every request with this status and an HTML page
    redirect_to: str = ""  # every request is sent on to this address
    requests: list[Seen] = field(default_factory=list)

    def seen(self, prefix: str) -> list[Seen]:
        return [r for r in self.requests if r.path.startswith(prefix)]


def _handler(fake: Fake):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:  # keep test output quiet
            pass

        def send(self, status: int, data: Any = None, raw: bytes | None = None, kind: str = "application/json") -> None:
            body = raw if raw is not None else json.dumps(data).encode("utf-8")
            self.send_response(status)
            if "gzip" in (self.headers.get("Accept-Encoding") or "") and self.path.startswith(("/files/", "/submissions/", "/api/")):
                body = gzip.compress(body)
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            url = urllib.parse.urlsplit(self.path)
            query = dict(urllib.parse.parse_qsl(url.query, keep_blank_values=True))
            fake.requests.append(Seen(url.path, query, dict(self.headers)))
            if fake.redirect_to:
                self.send_response(302)
                self.send_header("Location", fake.redirect_to + self.path)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            p = url.path
            if p.startswith(("/files/", "/submissions/", "/api/xbrl/")):
                return self.edgar(p)
            if p in ("/quote", "/time_series", "/symbol_search"):
                return self.twelve(p, query)
            if p.startswith("/tiingo/daily/"):
                return self.tiingo(p, query)
            return self.send(404, {"error": "no such route"})

        def edgar(self, p: str) -> None:
            if "@" not in (self.headers.get("User-Agent") or ""):
                page = b"<html><head><title>SEC.gov | Your Request Originates from an Undeclared Automated Tool</title></head></html>"
                return self.send(403, raw=page, kind="text/html")
            if fake.sec_status:
                page = b"<html><head><title>503 Service Unavailable</title></head><body>Try again later</body></html>"
                return self.send(fake.sec_status, raw=page, kind="text/html")
            if p in fake.sec:
                return self.send(200, fake.sec[p])
            xml = b"<?xml version='1.0' encoding='UTF-8'?><Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>"
            return self.send(404, raw=xml, kind="application/xml")

        def twelve(self, p: str, q: dict[str, str]) -> None:
            if p == "/symbol_search":  # answers without a key
                return self.send(200, fake.search.get(q.get("symbol", "").upper(), {"data": [], "status": "ok"}))
            auth = self.headers.get("Authorization") or ""
            if auth != f"apikey {TWELVE_KEY}":
                message = "**apikey** parameter is incorrect or not specified."
                if fake.echo_key:
                    message += f" You sent: {auth}"
                return self.send(401, {"code": 401, "message": message, "status": "error"})
            if fake.twelve_allowance is not None:
                if fake.twelve_allowance <= 0:
                    return self.send(429, {"code": 429, "message": "You have run out of API credits for the current minute. "
                                           "9 API credits were used, with the current limit being 8.", "status": "error"})
                fake.twelve_allowance -= 1
            symbol = q.get("symbol", "").upper()
            if p == "/quote":
                if symbol in fake.quotes:
                    return self.send(200, fake.quotes[symbol])
                return self.send(404, {"code": 404, "message": f"**symbol** not found: {symbol}.", "status": "error"})
            if symbol not in fake.series:
                return self.send(404, {"code": 404, "message": f"**symbol** not found: {symbol}.", "status": "error"})
            s = fake.series[symbol]
            bars = s["all"] if q.get("adjust", "splits") == "all" else s["none"]
            start, end = q.get("start_date", ""), q.get("end_date", "9999")
            bars = [b for b in bars if start <= b["datetime"] < end]  # end_date's own day left out, as Twelve Data does
            if not bars:
                return self.send(400, {"code": 400, "message": "No data is available on the specified dates. Try setting different start/end dates.",
                                       "status": "error", "meta": {"symbol": symbol, "interval": q.get("interval"), "exchange": ""}})
            if q.get("order", "desc") == "desc":
                bars = bars[::-1]
            return self.send(200, {"meta": {**s["meta"], "interval": q.get("interval")}, "values": bars, "status": "ok"})

        def tiingo(self, p: str, q: dict[str, str]) -> None:
            if (self.headers.get("Authorization") or "") != f"Token {TIINGO_KEY}":
                return self.send(401, {"detail": "Invalid token."})
            m = re.fullmatch(r"/tiingo/daily/([^/]+)(/prices)?", p)
            ticker = urllib.parse.unquote(m.group(1)).upper() if m else ""
            if not m or ticker not in fake.tiingo["meta"]:
                return self.send(404, {"detail": "Not found."})
            if not m.group(2):
                return self.send(200, fake.tiingo["meta"][ticker])
            bars = fake.tiingo["prices"].get(ticker, [])
            if "startDate" not in q:
                return self.send(200, bars[-1:])  # no dates: the latest day only
            start, end = q["startDate"], q.get("endDate", "9999")
            return self.send(200, [b for b in bars if start <= b["date"][:10] <= end])

    return Handler


@pytest.fixture
def fake():
    stand_in = Fake()
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(stand_in))
    stand_in.url = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield stand_in
    server.shutdown()
    server.server_close()


@pytest.fixture
def md(run, fake):
    """md(*args, ok=True, **env) runs market_data.py against the stand-in, with no keys or contact from this machine."""

    def _md(*args: object, ok: bool = True, **env: str):
        environ = {"MARKET_DATA_TEST_BASE": fake.url, "TWELVE_DATA_API_KEY": "", "TIINGO_API_KEY": "", "SEC_CONTACT": "", **env}
        return run("stocks", "market_data.py", *args, ok=ok, env=environ)

    return _md


@pytest.fixture
def other_host():
    """A second server, standing for another host a redirect might point at: it records whatever reaches it."""
    reached: list[dict[str, str]] = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

        def do_GET(self) -> None:
            reached.append(dict(self.headers))
            body = b"{}"
            self.send_response(200)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    # localhost rather than 127.0.0.1: another host name, so the script must not follow
    url = f"http://localhost:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield url, reached
    server.shutdown()
    server.server_close()


@pytest.fixture
def closed_url():
    """An address where nothing listens."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    url = f"http://127.0.0.1:{server.server_address[1]}"
    server.server_close()
    return url
