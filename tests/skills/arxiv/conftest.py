"""A stand-in for arXiv's API, arxiv.org's BibTeX pages and Semantic Scholar, for the arxiv skill's script.

The arXiv answers are real ones, captured once in November 2026 within arXiv's terms (one request at a time, seconds
apart) and kept in responses/: Atom feeds for papers fetched by id (new ids, old ones such as hep-th/0601001 and
solv-int/9901001, a pinned version), a search, a search for withdrawn papers and an error, and arxiv.org's
BibTeX for three papers plus its "not found" answer. arXiv's metadata is CC0. The stand-in builds its
answers from those entries the way arXiv does: ids it doesn't have are left out, and the order isn't the order asked.

Semantic Scholar's shared pool answered 429 to nearly every request while these tests were written. s2-429.json is
that real answer, and s2-batch.json the one real batch answer that got through (for ARXIV:2402.03300 and the unknown
ARXIV:2402.99999: a null in its place); s2-docs.json is built from the API's documentation (see the note inside it).
"""

from __future__ import annotations

import json
import re
import threading
import time
import urllib.parse
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

RESPONSES = Path(__file__).parent / "responses"
ENTRY = re.compile(r"  <entry>.*?</entry>\n", re.S)


def saved(name: str) -> str:
    return (RESPONSES / name).read_text(encoding="utf-8")


def entries_of(name: str) -> dict[str, str]:
    """The entries of a captured feed by versioned id, as arXiv wrote them."""
    out = {}
    for text in ENTRY.findall(saved(name)):
        vid = re.search(r"<id>http://arxiv\.org/abs/(.+?)</id>", text).group(1)
        out[vid] = text
    return out


def all_entries() -> dict[str, str]:
    out: dict[str, str] = {}
    for name in ("id-2402.03300.xml", "id-old-hep-th.xml", "id-solv-int.xml", "id-versioned.xml", "id-mixed.xml",
                 "search-withdrawn.xml", "search-and.xml"):
        out.update(entries_of(name))
    return out


def feed(entries: list[str], total: int, start: int, per_page: int) -> bytes:
    """A feed with arXiv's own header (from a captured answer) around the entries."""
    head = saved("id-2402.03300.xml").split("  <entry>", 1)[0]
    head = re.sub(r"<opensearch:totalResults>\d+<", f"<opensearch:totalResults>{total}<", head)
    head = re.sub(r"<opensearch:startIndex>\d+<", f"<opensearch:startIndex>{start}<", head)
    head = re.sub(r"<opensearch:itemsPerPage>\d+<", f"<opensearch:itemsPerPage>{per_page}<", head)
    return (head + "".join(entries) + "</feed>\n").encode("utf-8")


def many(n: int) -> list[str]:
    """n search results: copies of a real entry, each with its own id."""
    model = next(iter(entries_of("search-and.xml").values()))
    vid = re.search(r"<id>http://arxiv\.org/abs/(.+?)</id>", model).group(1)
    return [model.replace(vid, f"2601.{i:05d}v1").replace(vid.rsplit("v", 1)[0], f"2601.{i:05d}") for i in range(1, n + 1)]


def s2_data() -> dict[str, Any]:
    data = json.loads(saved("s2-docs.json"))
    real, missing = json.loads(saved("s2-batch.json"))
    assert missing is None
    data["papers"]["ARXIV:2402.03300"] = real
    return data


@dataclass
class Hit:
    at: float
    service: str  # api, site or s2
    method: str
    path: str
    query: dict[str, str]
    body: Any
    headers: dict[str, str]


@dataclass
class Fake:
    url: str = ""
    entries: dict[str, str] = field(default_factory=all_entries)
    search_results: list[str] = field(default_factory=lambda: list(entries_of("search-and.xml").values()))
    search_total: int | None = None
    api_errors: list[tuple[int, str]] = field(default_factory=list)  # answered, in turn, before anything else
    api_fail_from: int | None = None  # from this API request on (counting from 1), every answer is a 500
    bibtex: dict[str, str] = field(default_factory=lambda: {
        "2402.03300": saved("bibtex-2402.03300.bib"),
        "hep-th/0601001": saved("bibtex-old.bib"),
        "1706.03762": saved("bibtex-versioned.bib"),
    })
    s2: dict[str, Any] = field(default_factory=lambda: s2_data())
    s2_busy: int = 0  # how many Semantic Scholar requests to answer with its real 429
    redirect_to: str = ""  # when set, every request is sent on there
    hits: list[Hit] = field(default_factory=list)

    def many_results(self, n: int) -> None:
        """Make the search answer with n results."""
        self.search_results = many(n)

    def of(self, service: str) -> list[Hit]:
        return [h for h in self.hits if h.service == service]

    def s2_paper(self, pid: str) -> dict[str, Any] | None:
        pid = self.s2["aliases"].get(pid, pid)
        return self.s2["papers"].get(pid)


def _handler(fake: Fake):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

        def send(self, status: int, body: bytes, kind: str, extra: dict[str, str] | None = None) -> None:
            self.send_response(status)
            self.send_header("Content-Type", kind)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def json(self, status: int, data: Any) -> None:
            self.send(status, json.dumps(data).encode("utf-8"), "application/json")

        def answer(self) -> None:
            url = urllib.parse.urlsplit(self.path)
            query = dict(urllib.parse.parse_qsl(url.query, keep_blank_values=True))
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b""
            body = json.loads(raw) if raw else None
            path = urllib.parse.unquote(url.path)
            service = "api" if path.startswith("/api/") else "site" if path.startswith("/bibtex/") else "s2"
            fake.hits.append(Hit(time.monotonic(), service, self.command, path, query, body, dict(self.headers)))
            if fake.redirect_to:
                return self.send(302, b"", "text/html", {"Location": fake.redirect_to + self.path})
            if service == "api":
                return self.api(query)
            if service == "site":
                return self.site(path[len("/bibtex/"):])
            return self.semantic_scholar(path, query, body)

        do_GET = do_POST = answer

        def api(self, q: dict[str, str]) -> None:
            n = len(fake.of("api"))
            if fake.api_errors:
                status, name = fake.api_errors.pop(0)
                return self.send(status, saved(name).encode(), "application/atom+xml; charset=utf-8")
            if fake.api_fail_from is not None and n >= fake.api_fail_from:
                return self.send(500, b"<html><title>500 Internal Server Error</title></html>", "text/html")
            start, per_page = int(q.get("start", 0)), int(q.get("max_results", 10))
            if q.get("id_list"):
                found = []
                for wanted in q["id_list"].split(","):
                    if re.search(r"v\d+$", wanted):
                        hit = fake.entries.get(wanted)
                    else:
                        versions = sorted((int(v.rsplit("v", 1)[1]), t) for v, t in fake.entries.items()
                                          if v.rsplit("v", 1)[0] == wanted)
                        hit = versions[-1][1] if versions else None
                    if hit:
                        found.append(hit)
                found.reverse()  # arXiv's order isn't the order asked
                body = feed(found[:per_page], len(found), 0, per_page)
            else:
                results = fake.search_results
                total = fake.search_total if fake.search_total is not None else len(results)
                body = feed(results[start:start + per_page], total, start, per_page)
            self.send(200, body, "application/atom+xml; charset=utf-8")

        def site(self, arxiv_id: str) -> None:
            text = fake.bibtex.get(arxiv_id)
            if text is None:
                return self.send(404, saved("bibtex-missing.bib").encode(), "text/html; charset=utf-8")
            self.send(200, text.encode("utf-8"), "text/plain; charset=utf-8")

        def semantic_scholar(self, path: str, q: dict[str, str], body: Any) -> None:
            if fake.s2_busy > 0:
                fake.s2_busy -= 1
                return self.send(429, saved("s2-429.json").encode(), "application/json")
            limit = int(q.get("limit", 100))
            if path == "/graph/v1/paper/batch" and self.command == "POST":
                return self.json(200, [fake.s2_paper(i) for i in body["ids"]])
            m = re.fullmatch(r"/graph/v1/paper/(.+)/(citations|references)", path)
            if m and self.command == "GET":
                if fake.s2_paper(m.group(1)) is None:
                    return self.json(404, {"error": f"Paper with id {m.group(1)} not found"})
                items = fake.s2[m.group(2)]
                page: dict[str, Any] = {"offset": 0, "data": items[:limit]}
                if len(items) > limit:
                    page["next"] = limit
                return self.json(200, page)
            m = re.fullmatch(r"/recommendations/v1/papers/forpaper/(.+)", path)
            if m and self.command == "GET":
                if fake.s2_paper(m.group(1)) is None:
                    return self.json(404, {"error": f"Paper with id {m.group(1)} not found"})
                return self.json(200, {"recommendedPapers": fake.s2["recommended"][:limit]})
            if path == "/recommendations/v1/papers" and self.command == "POST":
                return self.json(200, {"recommendedPapers": fake.s2["recommended"][:limit]})
            if path == "/graph/v1/author/search" and self.command == "GET":
                found = [a for a in fake.s2["authors"] if q.get("query", "").lower() in a["name"].lower()]
                return self.json(200, {"total": len(found), "offset": 0, "data": found[:limit]})
            self.json(404, {"error": "Not found"})

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
def closed_url():
    """An address where nothing listens."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    url = f"http://127.0.0.1:{server.server_address[1]}"
    server.server_close()
    return url
