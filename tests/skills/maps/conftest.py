"""A stand-in for the services the maps skill's script calls: Nominatim, Overpass and FOSSGIS's OSRM routers.

It answers from responses/, the real answers of nominatim.openstreetmap.org, overpass-api.de and
routing.openstreetmap.de captured on 4 November 2026 (OSRM's per-intersection detail and step geometry left out to
keep them short). The script is pointed at it with --nominatim-url, --overpass-url and --router-url; nothing here
talks to the real services.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.parse
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

RESPONSES = Path(__file__).parent / "responses"


def saved(name: str) -> Any:
    return json.loads((RESPONSES / name).read_text(encoding="utf-8"))


SEARCHES = {
    "eiffel tower": "nominatim_search_eiffel_tower.json",
    "eiffel tower, paris": "nominatim_search_eiffel_tower.json",
    "東京駅": "nominatim_search_tokyo_station.json",
}


@dataclass
class Request:
    method: str
    path: str
    query: dict[str, str]
    body: dict[str, str]
    user_agent: str
    at: float


@dataclass
class FakeMaps:
    url: str = ""
    overpass: Any = field(default_factory=lambda: saved("overpass_pharmacies_tokyo.json"))
    # (status, content type, body) to answer instead, by the start of the path; "/search#2" only the second search
    replies: dict[str, tuple[int, str, bytes]] = field(default_factory=dict)
    requests: list[Request] = field(default_factory=list)

    def of(self, prefix: str) -> list[Request]:
        return [r for r in self.requests if r.path.startswith(prefix)]

    @property
    def overpass_queries(self) -> list[str]:
        return [r.body.get("data", "") for r in self.of("/api/interpreter")]


def _handler(fake: FakeMaps):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

        def send(self, status: int, data: Any = None, raw: bytes | None = None, ctype: str = "application/json; charset=utf-8") -> None:
            body = raw if raw is not None else json.dumps(data, ensure_ascii=False).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def record(self) -> Request:
            url = urllib.parse.urlsplit(self.path)
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode("utf-8") if length else ""
            req = Request(self.command, urllib.parse.unquote(url.path), dict(urllib.parse.parse_qsl(url.query)),
                          dict(urllib.parse.parse_qsl(body)), self.headers.get("User-Agent", ""), time.monotonic())
            fake.requests.append(req)
            return req

        def override(self, req: Request) -> bool:
            nth = len([r for r in fake.requests if r.path == req.path])  # this request included
            for key, (status, ctype, body) in fake.replies.items():
                prefix, _, only = key.partition("#")
                if req.path.startswith(prefix) and (not only or int(only) == nth):
                    self.send(status, raw=body, ctype=ctype)
                    return True
            return False

        def do_GET(self) -> None:
            req = self.record()
            if self.override(req):
                return
            if req.path == "/search":
                hits = saved(SEARCHES[req.query["q"].lower()]) if req.query.get("q", "").lower() in SEARCHES else []
                return self.send(200, hits[: int(req.query.get("limit", "10"))])
            if req.path == "/reverse":
                near = abs(float(req.query["lat"]) - 48.8584) < 0.01 and abs(float(req.query["lon"]) - 2.2945) < 0.01
                return self.send(200, saved("nominatim_reverse_eiffel_tower.json" if near else "nominatim_reverse_open_sea.json"))
            for profile in ("car", "foot", "bike"):
                if req.path.startswith(f"/routed-{profile}/route/v1/driving/"):
                    return self.send(200, saved(f"osrm_{profile}_eiffel_tower_to_louvre.json"))
            if req.path.startswith("/route/v1/driving/"):  # your own OSRM server: one profile, no prefix
                return self.send(200, saved("osrm_car_eiffel_tower_to_louvre.json"))
            return self.send(404, raw=b"<html><body><h1>Not Found</h1></body></html>", ctype="text/html")

        def do_POST(self) -> None:
            req = self.record()
            if self.override(req):
                return
            if req.path == "/api/interpreter":
                return self.send(200, fake.overpass)
            return self.send(404, raw=b"Not Found", ctype="text/plain")

    return Handler


def _serve(handler: type[BaseHTTPRequestHandler]):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


@pytest.fixture
def maps():
    fake = FakeMaps()
    server = _serve(_handler(fake))
    fake.url = f"http://127.0.0.1:{server.server_address[1]}"
    yield fake
    server.shutdown()
    server.server_close()


@pytest.fixture
def redirector():
    """A server that sends every request on to another host (localhost instead of 127.0.0.1)."""
    seen: list[str] = []

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

        def do_GET(self) -> None:
            seen.append(self.path)
            self.send_response(302)
            self.send_header("Location", f"http://localhost:{self.server.server_address[1]}{self.path}")
            self.send_header("Content-Length", "0")
            self.end_headers()

    server = _serve(Handler)
    yield f"http://127.0.0.1:{server.server_address[1]}", seen
    server.shutdown()
    server.server_close()


@pytest.fixture
def closed_url():
    """An address where nothing listens."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    url = f"http://127.0.0.1:{server.server_address[1]}"
    server.server_close()
    return url
