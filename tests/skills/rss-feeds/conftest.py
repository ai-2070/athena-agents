"""A stand-in web server for the rss-feeds skill's script: it serves saved answers shaped like the real ones (hnrss's
RSS, GitHub's release Atom, a JSON Feed 1.1, Reddit's .rss Atom with its HTML bodies, an old RSS 1.0 file, pages that
point to feeds) and can redirect, answer slowly, or refuse with a 429 the way Reddit does (an empty body and
x-ratelimit-reset)."""

from __future__ import annotations

import gzip
import os
import threading
import time
import urllib.parse
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

import pytest

ANSWERS = Path(__file__).parent / "answers"
TYPES = {".xml": "application/xml; charset=utf-8", ".atom": "application/atom+xml; charset=UTF-8",
         ".json": "application/json", ".html": "text/html; charset=utf-8"}


def answer(name: str) -> bytes:
    """A saved answer. rdf.xml declares ISO-8859-1, so it is served in that encoding."""
    data = (ANSWERS / name).read_bytes()
    return data.decode("utf-8").encode("iso-8859-1") if name == "rdf.xml" else data


@dataclass
class Route:
    status: int = 200
    body: bytes = b""
    ctype: str = "application/xml; charset=utf-8"
    headers: dict[str, str] = field(default_factory=dict)
    delay: float = 0.0
    gzip: bool = False
    # the first `limited` requests get a 429 with this x-ratelimit-reset, as Reddit sends
    limited: int = 0
    reset: str = "1"


@dataclass
class Site:
    url: str = ""
    routes: dict[str, Route] = field(default_factory=dict)
    requests: list[str] = field(default_factory=list)
    user_agents: set[str] = field(default_factory=set)

    def serve(self, path: str, name: str | None = None, **kw: Any) -> str:
        """Serve a saved answer (or kw's body) at path; returns its full address."""
        if name is not None:
            kw.setdefault("body", answer(name))
            kw.setdefault("ctype", TYPES[Path(name).suffix])
        self.routes[path] = Route(**kw)
        return self.url + path

    def redirect(self, path: str, to: str, status: int = 301) -> str:
        self.routes[path] = Route(status=status, headers={"Location": to})
        return self.url + path


def _handler(site: Site) -> Callable[..., BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:  # keep test output quiet
            pass

        def do_GET(self) -> None:
            site.requests.append(self.path)
            site.user_agents.add(self.headers.get("User-Agent", ""))
            route = site.routes.get(self.path) or site.routes.get(urllib.parse.urlsplit(self.path).path)
            if route is None:
                route = Route(status=404, body=b"<html><head><title>Not here</title></head></html>",
                              ctype="text/html")
            if route.delay:
                time.sleep(route.delay)
            status, body, headers = route.status, route.body, dict(route.headers)
            if route.limited:
                route.limited -= 1
                status, body = 429, b""
                headers = {"x-ratelimit-used": "1", "x-ratelimit-remaining": "0.0", "x-ratelimit-reset": route.reset}
            elif route.gzip and "gzip" in self.headers.get("Accept-Encoding", ""):
                body = gzip.compress(body)
                headers["Content-Encoding"] = "gzip"
            self.send_response(status)
            if body:
                self.send_header("Content-Type", route.ctype)
            for k, v in headers.items():
                self.send_header(k, v)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def _start(host: str) -> tuple[Site, ThreadingHTTPServer]:
    site = Site()
    server = ThreadingHTTPServer((host, 0), _handler(site))
    site.url = f"http://{host}:{server.server_address[1]}"
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return site, server


@pytest.fixture(autouse=True)
def no_proxy(monkeypatch):
    """The scripts run without the machine's proxy settings, so the stand-in is reached directly."""
    for name in list(os.environ):
        if name.lower().endswith("_proxy"):
            monkeypatch.delenv(name)


@pytest.fixture
def site():
    s, server = _start("127.0.0.1")
    yield s
    server.shutdown()
    server.server_close()


@pytest.fixture
def other_site():
    """A second server on another host name (localhost rather than 127.0.0.1): another site, as far as redirects go."""
    s, server = _start("127.0.0.1")
    s.url = s.url.replace("127.0.0.1", "localhost")
    yield s
    server.shutdown()
    server.server_close()


@pytest.fixture
def closed_url():
    """An address where nothing listens."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    url = f"http://127.0.0.1:{server.server_address[1]}"
    server.server_close()
    return url
