#!/usr/bin/env python3
"""Upload images, masks, video or audio into a running ComfyUI's input folder, and print the names it gave them.

    python comfy_upload.py photo.png [more files] [--server URL] [--subfolder NAME] [--overwrite]
    python comfy_upload.py mask.png --mask-onto photo.png [--mask-kind white|transparent]

Each upload's "value" in the output is what a Load Image (or Load Video, Load Audio) node's file input takes. It can
differ from the file's own name: ComfyUI gives an upload a new name ("photo (1).png") rather than replace a different
file of the same name, unless --overwrite is given. --overwrite never replaces the image a mask goes onto: the masked
copy is named after the mask file, so a mask file named like the image is refused.

--mask-onto NAME makes a copy of an image already uploaded (NAME is its value) with the mask as its transparency,
which is what ComfyUI's mask editor does: a Load Image node's MASK output then marks the area to repaint. With
--mask-kind white (the default) the mask is a black-and-white picture, white = repaint; with transparent, its
transparent pixels mark the area. The mask must be the image's size.

Standard library (Python 3.11+), plus Pillow for white masks and the size check: python -m pip install pillow
"""

from __future__ import annotations

import argparse
import http.client
import ipaddress
import io
import json
import mimetypes
import struct
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path
from typing import Any

try:
    from PIL import Image, ImageOps
except ImportError:  # only the mask options need it
    Image = ImageOps = None  # type: ignore[assignment]

USER_AGENT = "AthenaAgents/1.0 (comfy_upload)"
DEFAULT_SERVERS = ["http://127.0.0.1:8188", "http://127.0.0.1:8000"]
# what urllib raises when the address answers with something that isn't HTTP, or hangs up
NET_ERRORS = (OSError, http.client.HTTPException)


class Failed(Exception):
    pass


class SameHost(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only to the same host: files go to the ComfyUI the script was pointed at and nowhere else."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        new, old = urllib.parse.urlsplit(newurl), urllib.parse.urlsplit(req.full_url)
        if new.scheme not in ("http", "https") or new.hostname != old.hostname:
            return None  # urllib then raises an HTTPError with the redirect's status
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def direct(host: str) -> bool:
    """Whether to go round the system proxy: a ComfyUI on this machine or the local network is reached directly, and
    a proxy that can't see it would answer with an error page. Other names follow the system's proxy settings."""
    host = host.lower().rstrip(".")
    if host == "localhost" or host.endswith(".local") or ("." not in host and ":" not in host):
        return True  # this machine, or a computer's name on the local network
    try:
        return not ipaddress.ip_address(host).is_global
    except ValueError:
        return False


class Server:
    def __init__(self, url: str, timeout: float):
        self.url = url.rstrip("/")
        self.timeout = timeout
        host = urllib.parse.urlsplit(self.url).hostname or ""
        handlers: list[Any] = [SameHost()] + ([urllib.request.ProxyHandler({})] if direct(host) else [])
        self.opener = urllib.request.build_opener(*handlers)

    def request(self, path: str, body: bytes | None = None, content_type: str | None = None, timeout: float | None = None) -> tuple[int, bytes]:
        headers = {"User-Agent": USER_AGENT}
        if content_type:
            headers["Content-Type"] = content_type
        req = urllib.request.Request(self.url + path, data=body, headers=headers, method="POST" if body is not None else "GET")
        try:
            with self.opener.open(req, timeout=timeout or self.timeout) as res:
                return res.status, res.read()
        except urllib.error.HTTPError as e:
            with e:
                return e.code, e.read()

    def view(self, value: str) -> bytes | None:
        """An input file's bytes, or None when ComfyUI hasn't got it."""
        sub, base = split(value)
        status, body = self.request("/view?" + urllib.parse.urlencode({"filename": base, "subfolder": sub, "type": "input"}))
        return body if status == 200 else None

    def upload(self, route: str, filename: str, data: bytes, fields: dict[str, str]) -> dict[str, Any]:
        body, content_type = multipart(fields, filename, data)
        status, answer = self.request(route, body, content_type)
        if status != 200:
            text = " ".join(answer.decode("utf-8", "replace").split())  # aiohttp's error pages run over several lines
            raise Failed(f"ComfyUI refused {filename} ({route}, HTTP {status}){': ' + text[:300] if text else ''}")
        try:
            result = json.loads(answer.decode("utf-8"))
        except ValueError:
            raise Failed(f"ComfyUI's answer to {filename} wasn't JSON.") from None
        if not isinstance(result, dict) or not isinstance(result.get("name"), str):
            raise Failed(f"ComfyUI's answer to {filename} has no name in it.")
        return result


def split(value: str) -> tuple[str, str]:
    """(subfolder, file name) of an input value such as "masks/photo.png"."""
    sub, _, base = value.replace("\\", "/").rpartition("/")
    return sub, base


def tidy(folder: str) -> str:
    """A subfolder written with "/" and no empty parts ("jobs\\shoot\\" becomes "jobs/shoot")."""
    return "/".join(p for p in folder.replace("\\", "/").split("/") if p)


def replaces_original(original: str, subfolder: str, mask: Path) -> bool:
    """Whether the masked copy would land on the image it's made from. Letter case doesn't count: Windows and macOS
    see Photo.png and photo.png as one file."""
    sub, base = split(original)
    target = (subfolder or tidy(sub), mask.stem + ".png")
    return tuple(s.casefold() for s in target) == (tidy(sub).casefold(), base.casefold())


def multipart(fields: dict[str, str], filename: str, data: bytes) -> tuple[bytes, str]:
    boundary = "AthenaAgents" + uuid.uuid4().hex
    safe = filename.replace('"', "_").replace("\r", "").replace("\n", "")
    kind = mimetypes.guess_type(safe)[0] or "application/octet-stream"
    out = io.BytesIO()
    for name, value in fields.items():
        out.write(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode("utf-8"))
    out.write(f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{safe}"\r\nContent-Type: {kind}\r\n\r\n'.encode("utf-8"))
    out.write(data)
    out.write(f"\r\n--{boundary}--\r\n".encode("utf-8"))
    return out.getvalue(), f"multipart/form-data; boundary={boundary}"


def addresses(given: str) -> list[str]:
    """The URLs to try for an address the user gave. "localhost" is tried as 127.0.0.1 and then [::1]: on Windows it
    resolves to ::1 first, where ComfyUI doesn't listen, and every request would wait about two seconds for that."""
    url = given if "://" in given else "http://" + given
    parts = urllib.parse.urlsplit(url)
    try:
        port = parts.port
    except ValueError:
        port = -1
    if parts.scheme not in ("http", "https") or not parts.hostname or port == -1:
        raise Failed(f"--server takes an address like http://127.0.0.1:8188, not {given!r}.")
    if parts.hostname != "localhost":
        return [url]
    suffix = f":{port}" if port else ""
    return [urllib.parse.urlunsplit(parts._replace(netloc=host + suffix)) for host in ("127.0.0.1", "[::1]")]


def is_comfyui(body: bytes) -> bool:
    try:
        stats = json.loads(body.decode("utf-8"))
    except ValueError:
        return False
    return isinstance(stats, dict) and isinstance(stats.get("system"), dict)


def find_server(given: str | None, timeout: float) -> Server:
    """The ComfyUI to upload to. Something else answering on the port (a web app on 8000, say) gets nothing."""
    why = ""
    for url in [u for a in ([given] if given else DEFAULT_SERVERS) for u in addresses(a)]:
        server = Server(url, timeout)
        try:
            status, body = server.request("/system_stats", timeout=min(timeout, 5))
        except NET_ERRORS as e:
            why = " ".join(str(getattr(e, "reason", "") or e).split()) or type(e).__name__
            continue
        if status == 200 and is_comfyui(body):
            return server
        why = f"HTTP {status}" if status != 200 else "something answered, but not ComfyUI"
    raise Failed(f"No ComfyUI answered at {given or ' or '.join(DEFAULT_SERVERS)} ({why}). Start it, or pass --server with its address.")


def read_file(path: Path) -> bytes:
    try:
        return path.read_bytes()
    except OSError as e:
        raise Failed(f"Can't read {path}: {e.strerror or e}") from None


def value_of(result: dict[str, Any]) -> str:
    sub = result.get("subfolder") or ""
    return f"{sub}/{result['name']}" if sub else result["name"]


def entry(file: Path, result: dict[str, Any], **extra: str) -> dict[str, Any]:
    return {"file": str(file), **extra, "name": result["name"], "subfolder": result.get("subfolder") or "", "type": result.get("type") or "input", "value": value_of(result)}


def png_has_alpha(data: bytes) -> bool:
    """Whether a PNG can hold transparency (an alpha channel, or a transparency chunk)."""
    if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) < 26:
        return False
    if data[25] in (4, 6):  # colour type: grey + alpha, RGBA
        return True
    pos = 8
    while pos + 8 <= len(data):
        length, kind = struct.unpack(">I4s", data[pos : pos + 8])
        if kind == b"tRNS":
            return True
        if kind == b"IDAT":
            return False
        pos += 12 + length
    return False


def mask_png(path: Path, kind: str, size: tuple[int, int] | None) -> bytes:
    """The mask as a PNG whose transparent pixels mark the area to repaint (what /upload/mask copies into the image)."""
    data = read_file(path)
    if Image is None:
        if kind == "white":
            raise Failed("A black-and-white mask needs Pillow to turn it into transparency: python -m pip install pillow")
        if not png_has_alpha(data):
            raise Failed(f"{path.name} has no transparency. For a black-and-white mask use --mask-kind white.")
        return data
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except (OSError, Image.DecompressionBombError) as e:
        raise Failed(f"{path.name} isn't an image Pillow can read ({e}).") from None
    with img:
        if size and img.size != size:
            raise Failed(f"The mask is {img.size[0]}x{img.size[1]} but the image is {size[0]}x{size[1]}; make them the same size.")
        if kind == "white":
            alpha = ImageOps.invert(img.convert("L"))  # white (repaint) becomes fully transparent
        else:
            if "A" not in img.getbands() and "transparency" not in img.info:
                raise Failed(f"{path.name} has no transparency. For a black-and-white mask use --mask-kind white.")
            alpha = img.convert("RGBA").getchannel("A")
        if alpha.getextrema()[0] == 255:
            raise Failed(f"{path.name} marks nothing to repaint (no {'white' if kind == 'white' else 'transparent'} pixels).")
        out = Image.new("RGBA", img.size, (0, 0, 0, 255))
        out.putalpha(alpha)
        buf = io.BytesIO()
        out.save(buf, format="PNG")
        return buf.getvalue()


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):  # a Windows pipe is cp1252 otherwise
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(
        description="Upload files into a running ComfyUI's input folder and print the names to use in a workflow.",
        epilog="Prints JSON. Exit status 0 when every upload worked; 2 when one didn't, with the reason in one line on "
               "stderr (and the JSON lists any that went up before it).",
    )
    parser.add_argument("files", nargs="+", type=Path, help="images, masks, video or audio to upload")
    parser.add_argument("--server", help="ComfyUI's address (default: try http://127.0.0.1:8188, then :8000)")
    parser.add_argument("--subfolder", default="", help="a folder inside ComfyUI's input folder to put them in")
    parser.add_argument("--overwrite", action="store_true", help="replace a file of the same name instead of renaming the upload (never the image a mask goes onto)")
    parser.add_argument("--mask-onto", metavar="NAME", help="make a copy of this already uploaded image with the mask as its transparency")
    parser.add_argument("--mask-kind", choices=("white", "transparent"), default="white", help="white: white marks the area to repaint (default); transparent: transparent pixels do")
    parser.add_argument("--timeout", type=float, default=120, help="seconds to wait for each answer (default 120)")
    args = parser.parse_args()
    if not args.timeout > 0:
        parser.error("--timeout is a number of seconds above 0")
    # ComfyUI echoes the subfolder back as given, and the value must work on the server's system: "/" works on all
    subfolder = tidy(args.subfolder)

    server, uploaded = None, []
    try:
        for f in args.files:
            if not f.is_file():
                raise Failed(f"No such file: {f}")
        if args.mask_onto and len(args.files) != 1:
            raise Failed("--mask-onto takes one mask file.")
        if args.mask_onto and args.overwrite and replaces_original(args.mask_onto, subfolder, args.files[0]):
            raise Failed(f"--overwrite would replace {args.mask_onto} itself with the masked copy, which is named after the mask file. Rename the mask file, or leave out --overwrite.")
        server = find_server(args.server, args.timeout)
        if args.mask_onto:
            original = server.view(args.mask_onto)
            if original is None:
                raise Failed(f"ComfyUI has no input image {args.mask_onto}. Upload the image first and use the value it prints.")
            size = None
            if Image is not None:
                try:
                    with Image.open(io.BytesIO(original)) as img:
                        size = img.size
                except (OSError, Image.DecompressionBombError):
                    size = None  # not a picture Pillow reads: ComfyUI's own answer is the check
            mask = args.files[0]
            sub, base = split(args.mask_onto)
            fields = {
                "type": "input",
                "subfolder": subfolder or tidy(sub),
                "original_ref": json.dumps({"filename": base, "subfolder": sub, "type": "input"}),
            }
            if args.overwrite:
                fields["overwrite"] = "true"
            result = server.upload("/upload/mask", mask.stem + ".png", mask_png(mask, args.mask_kind, size), fields)
            if server.view(value_of(result)) is None:
                raise Failed("ComfyUI answered but didn't save the masked image; check that the image and mask are the same size.")
            uploaded.append(entry(mask, result, masked=args.mask_onto))
        else:
            for f in args.files:
                fields = {"type": "input", "subfolder": subfolder}
                if args.overwrite:
                    fields["overwrite"] = "true"
                result = server.upload("/upload/image", f.name, read_file(f), fields)
                uploaded.append(entry(f, result))
    except Failed as e:
        error = str(e)
    except NET_ERRORS as e:
        error = f"Lost the connection to ComfyUI: {' '.join(str(e).split()) or type(e).__name__}"
    else:
        print(json.dumps({"server": server.url, "uploaded": uploaded}, indent=2, ensure_ascii=False))
        return 0
    if server is not None and uploaded:  # some went up first: say which, so they aren't sent twice
        print(json.dumps({"server": server.url, "uploaded": uploaded, "error": error}, indent=2, ensure_ascii=False))
    print(error, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
