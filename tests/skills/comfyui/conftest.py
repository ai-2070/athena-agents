"""A small stand-in for a running ComfyUI, for the comfyui skill's scripts.

It answers the routes the scripts use with the saved responses in responses/ (shaped like ComfyUI 0.44's own:
dropdowns as [[choices], {...}] or ["COMBO", {"options": [...]}], upload flags, renamed model folders) and keeps
uploads in memory. /upload/mask does what ComfyUI's does: the mask's alpha becomes the original image's alpha.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import threading
import urllib.parse
from dataclasses import dataclass, field
from email import policy
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest

RESPONSES = Path(__file__).parent / "responses"


def saved(name: str) -> Any:
    return json.loads((RESPONSES / name).read_text(encoding="utf-8"))


@dataclass
class FakeComfy:
    object_info: dict[str, Any] = field(default_factory=lambda: saved("object_info.json"))
    models: dict[str, list[str]] = field(default_factory=lambda: {k: v for k, v in saved("models.json").items() if k != "//"})
    mappings: dict[str, Any] | None = field(default_factory=lambda: saved("getmappings.json"))
    manager_v2: bool = True
    os: str = "linux"  # what /system_stats reports as sys.platform
    # input files by (subfolder, name)
    inputs: dict[tuple[str, str], bytes] = field(default_factory=dict)
    requests: list[tuple[str, str]] = field(default_factory=list)
    user_agents: set[str] = field(default_factory=set)
    uploads: list[dict[str, Any]] = field(default_factory=list)
    refuse: set[str] = field(default_factory=set)  # uploads of these names fail, as when the server's disk is full
    url: str = ""

    def embeddings(self) -> list[str]:
        return [n.rsplit(".", 1)[0] for n in self.models.get("embeddings", [])]


def _parts(handler: BaseHTTPRequestHandler) -> dict[str, tuple[str | None, bytes]]:
    body = handler.rfile.read(int(handler.headers["Content-Length"]))
    head = f"Content-Type: {handler.headers['Content-Type']}\r\n\r\n".encode()
    msg = BytesParser(policy=policy.default).parsebytes(head + body)
    out = {}
    for part in msg.iter_parts():
        name = part.get_param("name", header="content-disposition")
        out[name] = (part.get_filename(), part.get_payload(decode=True))
    return out


def _handler(comfy: FakeComfy):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:  # keep test output quiet
            pass

        def send(self, status: int, data: Any = None, raw: bytes | None = None) -> None:
            body = raw if raw is not None else (json.dumps(data).encode() if data is not None else b"")
            self.send_response(status)
            self.send_header("Content-Type", "application/json" if raw is None else "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self) -> None:
            url = urllib.parse.urlsplit(self.path)
            q = dict(urllib.parse.parse_qsl(url.query, keep_blank_values=True))
            comfy.requests.append(("GET", self.path))
            comfy.user_agents.add(self.headers.get("User-Agent", ""))
            p = url.path
            if p == "/system_stats":
                return self.send(200, {"system": {"os": comfy.os, "comfyui_version": "0.44.0"}, "devices": []})
            if p == "/object_info":
                return self.send(200, comfy.object_info)
            if p == "/models":
                return self.send(200, list(comfy.models))
            if p.startswith("/models/"):
                folder = urllib.parse.unquote(p[len("/models/") :])
                return self.send(200, comfy.models[folder]) if folder in comfy.models else self.send(404)
            if p == "/embeddings":
                return self.send(200, comfy.embeddings())
            if p == "/view":
                if q.get("type", "output") != "input":
                    return self.send(404)
                data = comfy.inputs.get((q.get("subfolder", ""), q.get("filename", "")))
                return self.send(200, raw=data) if data is not None else self.send(404)
            if p in ("/v2/customnode/getmappings", "/customnode/getmappings"):
                v2 = p.startswith("/v2/")
                if comfy.mappings is None or v2 != comfy.manager_v2:
                    return self.send(404)
                return self.send(200, comfy.mappings)
            return self.send(404)

        def do_POST(self) -> None:
            comfy.requests.append(("POST", self.path))
            comfy.user_agents.add(self.headers.get("User-Agent", ""))
            parts = _parts(self)
            filename, data = parts["image"]
            fields = {k: v[1].decode() for k, v in parts.items() if k != "image"}
            sub = fields.get("subfolder", "")
            name = filename or ""
            if name in comfy.refuse:
                return self.send(500, raw=b"500 Internal Server Error\n\nServer got itself in trouble")
            if self.path == "/upload/mask":
                ref = json.loads(fields["original_ref"])
                original = comfy.inputs.get((ref.get("subfolder", ""), ref["filename"]))
                if original is None:  # ComfyUI writes nothing then, and still answers with a name
                    return self.send(200, {"name": name, "subfolder": sub, "type": "input"})
                from PIL import Image

                with Image.open(io.BytesIO(original)) as img, Image.open(io.BytesIO(data)) as mask:
                    out = img.convert("RGBA")
                    out.putalpha(mask.convert("RGBA").getchannel("A"))
                    buf = io.BytesIO()
                    out.save(buf, format="PNG")
                    stored = buf.getvalue()
            elif self.path == "/upload/image":
                stored = data
            else:
                return self.send(404)
            if fields.get("overwrite") not in ("true", "1"):
                stem, dot, suffix = name.rpartition(".")
                i = 1
                while (sub, name) in comfy.inputs:
                    if hashlib.sha256(comfy.inputs[(sub, name)]).digest() == hashlib.sha256(data).digest():
                        break  # the same file again: ComfyUI keeps the one it has
                    name = f"{stem} ({i}){dot}{suffix}"
                    i += 1
            comfy.inputs[(sub, name)] = stored
            comfy.uploads.append({"route": self.path, "fields": fields, "name": name})
            return self.send(200, {"name": name, "subfolder": sub, "type": "input"})

    return Handler


@pytest.fixture
def comfy():
    fake = FakeComfy()
    server = ThreadingHTTPServer(("127.0.0.1", 0), _handler(fake))
    fake.url = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield fake
    server.shutdown()
    server.server_close()


@dataclass
class OtherApp:
    """Something that isn't ComfyUI on a ComfyUI port: a web app that answers 200 with a page to everything, or a
    server that sends every request to another address."""

    url: str = ""
    redirect_to: str = ""  # when set, every GET is a 302 to this address plus the path
    requests: list[tuple[str, str]] = field(default_factory=list)


@pytest.fixture
def other_app():
    app = OtherApp()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

        def answer(self) -> None:
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            app.requests.append((self.command, self.path))
            if app.redirect_to:
                self.send_response(302)
                self.send_header("Location", app.redirect_to + self.path)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            body = b"<!doctype html><title>My app</title>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        do_GET = do_POST = answer

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    app.url = f"http://127.0.0.1:{server.server_address[1]}"
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield app
    server.shutdown()
    server.server_close()


@dataclass
class Proxy:
    """A web proxy that records the address of every request sent through it and answers each with a 502, as a
    proxy does for a host it can't reach."""

    url: str = ""
    requests: list[str] = field(default_factory=list)


@pytest.fixture
def proxy(monkeypatch):
    """The proxy, set as the system's (and no other proxy settings) for the scripts the test runs."""
    seen = Proxy()

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: Any) -> None:
            pass

        def answer(self) -> None:
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            seen.requests.append(self.path)  # through a proxy this is the whole address
            self.send_response(502)
            self.send_header("Content-Length", "0")
            self.end_headers()

        do_GET = do_POST = answer

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    seen.url = f"http://127.0.0.1:{server.server_address[1]}"
    for name in list(os.environ):
        if name.lower().endswith("_proxy"):
            monkeypatch.delenv(name)
    monkeypatch.setenv("http_proxy", seen.url)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield seen
    server.shutdown()
    server.server_close()


@pytest.fixture
def closed_url():
    """An address where nothing listens."""
    server = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
    url = f"http://127.0.0.1:{server.server_address[1]}"
    server.server_close()
    return url
