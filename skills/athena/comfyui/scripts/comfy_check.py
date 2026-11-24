#!/usr/bin/env python3
"""Check a ComfyUI workflow against a running ComfyUI before running it: which node types, models, embeddings and
input files the server doesn't have, and values it won't accept.

    python comfy_check.py workflow.json [--server http://127.0.0.1:8188]

The workflow can be in API format (File > Export (API) in ComfyUI), the editor format ComfyUI saves, or a PNG that
ComfyUI made (the workflow inside it is read). Without --server it tries 127.0.0.1:8188 (ComfyUI's own default, and
the new Comfy Desktop's) and then 127.0.0.1:8000 (the old ComfyUI Desktop's).

Prints a JSON report. Exit status: 0 when nothing is missing, 1 when something is, 2 when the check couldn't run.
It only reads: it asks the server with GET requests and installs nothing.

Standard library only (Python 3.11+).
"""

from __future__ import annotations

import argparse
import codecs
import http.client
import ipaddress
import json
import locale
import re
import struct
import sys
import urllib.error
import urllib.parse
import urllib.request
import zlib
from pathlib import Path
from typing import Any

USER_AGENT = "AthenaAgents/1.0 (comfy_check)"
DEFAULT_SERVERS = ["http://127.0.0.1:8188", "http://127.0.0.1:8000"]
# what urllib raises when the address answers with something that isn't HTTP, or hangs up
NET_ERRORS = (OSError, http.client.HTTPException)

# The model inputs of ComfyUI's own loader nodes and the models folder each reads (nodes.py and comfy_extras).
LOADERS: dict[str, dict[str, str]] = {
    "CheckpointLoaderSimple": {"ckpt_name": "checkpoints"},
    "CheckpointLoader": {"ckpt_name": "checkpoints", "config_name": "configs"},
    "unCLIPCheckpointLoader": {"ckpt_name": "checkpoints"},
    "ImageOnlyCheckpointLoader": {"ckpt_name": "checkpoints"},
    "LoraLoader": {"lora_name": "loras"},
    "LoraLoaderModelOnly": {"lora_name": "loras"},
    "VAELoader": {"vae_name": "vae"},
    "ControlNetLoader": {"control_net_name": "controlnet"},
    "DiffControlNetLoader": {"control_net_name": "controlnet"},
    "UNETLoader": {"unet_name": "diffusion_models"},
    "CLIPLoader": {"clip_name": "text_encoders"},
    "DualCLIPLoader": {"clip_name1": "text_encoders", "clip_name2": "text_encoders"},
    "TripleCLIPLoader": {f"clip_name{i}": "text_encoders" for i in (1, 2, 3)},
    "QuadrupleCLIPLoader": {f"clip_name{i}": "text_encoders" for i in (1, 2, 3, 4)},
    "CLIPVisionLoader": {"clip_name": "clip_vision"},
    "StyleModelLoader": {"style_model_name": "style_models"},
    "GLIGENLoader": {"gligen_name": "gligen"},
    "UpscaleModelLoader": {"model_name": "upscale_models"},
    "LatentUpscaleModelLoader": {"model_name": "latent_upscale_models"},
    "HypernetworkLoader": {"hypernetwork_name": "hypernetworks"},
    "PhotoMakerLoader": {"photomaker_model_name": "photomaker"},
    "ModelPatchLoader": {"name": "model_patches"},
    "AudioEncoderLoader": {"audio_encoder_name": "audio_encoders"},
}
# Folders ComfyUI renamed: a server from before the rename knows only the old name.
FOLDER_ALIASES = {"diffusion_models": "unet", "unet": "diffusion_models", "text_encoders": "clip", "clip": "text_encoders"}
MODEL_EXTS = {".ckpt", ".pt", ".pt2", ".bin", ".pth", ".safetensors", ".pkl", ".sft", ".gguf", ".onnx"}
MEDIA_EXTS = {
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif",
    ".mp4", ".webm", ".mov", ".mkv", ".avi", ".wav", ".mp3", ".flac", ".ogg", ".m4a", ".aac", ".opus",
}
UPLOAD_FLAGS = ("image_upload", "video_upload", "audio_upload", "file_upload")
EDITOR_ONLY = {"Reroute", "PrimitiveNode", "Note", "MarkdownNote"}
EMBEDDING_EXTS = (".safetensors", ".pt", ".bin")
EMBEDDING = re.compile(r"(?:^|(?<=[\s()]))embedding:([^\s,<\[()]+)")


def fail(message: str, code: int = 2) -> None:
    print(message, file=sys.stderr)
    sys.exit(code)


# ---------- talking to the server ----------

class SameHost(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only to the same host: the script talks to the ComfyUI it was pointed at and nothing else."""

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
        self._models: dict[str, list[str] | None] = {}
        self.folder_names: dict[str, str] = {}  # the name each folder answered to

    def get(self, path: str, timeout: float | None = None, read: bool = True) -> tuple[int, bytes]:
        """(status, body). With read=False only the status: an input file can be a video of several GB."""
        req = urllib.request.Request(self.url + path, headers={"User-Agent": USER_AGENT})
        try:
            with self.opener.open(req, timeout=timeout or self.timeout) as res:
                return res.status, res.read() if read else b""
        except urllib.error.HTTPError as e:
            e.close()
            return e.code, b""

    def json(self, path: str, timeout: float | None = None) -> Any:
        """The JSON at path, or None when the server answers with an error status."""
        status, body = self.get(path, timeout)
        if status != 200:
            return None
        try:
            return json.loads(body.decode("utf-8"))
        except ValueError:
            return None

    def models(self, folder: str) -> list[str] | None:
        """The files in a models folder, trying the folder's other name on a server that doesn't know it."""
        if folder not in self._models:
            files = None
            for name in (folder, FOLDER_ALIASES.get(folder)):
                if name:
                    files = self.json("/models/" + urllib.parse.quote(name))
                    if isinstance(files, list):
                        self.folder_names[folder] = name
                        break
            self._models[folder] = files if isinstance(files, list) else None
        return self._models[folder]

    def input_exists(self, value: str) -> bool:
        name, kind = value, "input"
        for tag in ("input", "output", "temp"):
            if name.endswith(f" [{tag}]"):
                name, kind = name[: -len(tag) - 3], tag
        sub, _, base = name.replace("\\", "/").rpartition("/")
        query = urllib.parse.urlencode({"filename": base, "subfolder": sub, "type": kind})
        return self.get("/view?" + query, read=False)[0] == 200


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
        fail(f"--server takes an address like http://127.0.0.1:8188, not {given!r}.")
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
    why = ""
    for url in [u for a in ([given] if given else DEFAULT_SERVERS) for u in addresses(a)]:
        server = Server(url, timeout)
        try:
            status, body = server.get("/system_stats", timeout=min(timeout, 5))
        except NET_ERRORS as e:
            why = " ".join(str(getattr(e, "reason", "") or e).split()) or type(e).__name__
            continue
        if status == 200 and is_comfyui(body):
            return server
        why = f"HTTP {status}" if status != 200 else "something answered, but not ComfyUI"
    where = given or " or ".join(DEFAULT_SERVERS)
    fail(f"No ComfyUI answered at {where} ({why}). Start it (and wait until it has loaded), or pass --server with its address.")
    raise AssertionError  # fail() exits


# ---------- reading the workflow ----------

def png_texts(data: bytes) -> dict[str, str]:
    """The text chunks of a PNG (ComfyUI stores the workflow as "prompt" and "workflow")."""
    out: dict[str, str] = {}
    pos = 8
    while pos + 8 <= len(data):
        length, kind = struct.unpack(">I4s", data[pos : pos + 8])
        body = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        try:
            if kind == b"tEXt":
                key, _, text = body.partition(b"\0")
                out[key.decode("latin-1")] = text.decode("latin-1")
            elif kind == b"zTXt":
                key, _, rest = body.partition(b"\0")
                out[key.decode("latin-1")] = zlib.decompress(rest[1:]).decode("latin-1")
            elif kind == b"iTXt":
                key, _, rest = body.partition(b"\0")
                compressed, rest = rest[0], rest[2:]
                _, _, rest = rest.partition(b"\0")  # language
                _, _, text = rest.partition(b"\0")  # translated keyword
                out[key.decode("latin-1")] = (zlib.decompress(text) if compressed else text).decode("utf-8")
            elif kind == b"IEND":
                break
        except (zlib.error, UnicodeDecodeError, IndexError):
            continue
    return out


def read_workflow(path: Path) -> tuple[str, dict[str, Any], list[str]]:
    """(format, workflow, notes). Format is "api" or "editor"."""
    try:
        raw = path.read_bytes()
    except OSError as e:
        fail(f"Can't read {path}: {e}")
    notes: list[str] = []
    candidates: list[Any] = []
    if raw.startswith(b"\x89PNG\r\n\x1a\n"):
        texts = png_texts(raw)
        for key in ("prompt", "workflow"):  # the API form is what actually ran, so it comes first
            if key in texts:
                try:
                    candidates.append(json.loads(texts[key]))
                except ValueError:
                    pass
        if not candidates:
            fail(f"{path.name} is a PNG with no ComfyUI workflow in it.")
        notes.append("Read the workflow stored in the PNG.")
    else:
        text, note = decode(raw)
        if note:
            notes.append(note)
        try:
            candidates.append(json.loads(text))
        except ValueError as e:
            fail(f"{path.name} isn't valid JSON: {e}")
    for data in candidates:
        if not isinstance(data, dict):
            continue
        if isinstance(data.get("nodes"), list):
            return "editor", data, notes
        if isinstance(data.get("prompt"), dict) and is_api(data["prompt"]):
            notes.append('The file is a /prompt request body; checked its "prompt".')
            return "api", data["prompt"], notes
        if is_api(data):
            return "api", data, notes
    fail(f"{path.name} doesn't look like a ComfyUI workflow (no nodes, and no entries with a class_type).")
    raise AssertionError


def decode(raw: bytes) -> tuple[str, str | None]:
    """The text of a file, whichever way Windows PowerShell 5.1 wrote it: > and Out-File write UTF-16, Set-Content
    the ANSI code page, -Encoding utf8 UTF-8 with a byte-order mark."""
    if raw[:2] in (codecs.BOM_UTF16_LE, codecs.BOM_UTF16_BE):
        return raw.decode("utf-16", "replace"), None
    try:
        return raw.decode("utf-8-sig"), None
    except UnicodeDecodeError:
        ansi = locale.getpreferredencoding(False)
        if codecs.lookup(ansi).name == "utf-8":
            ansi = "cp1252"  # not this machine's code page, so most likely Windows' Western European one
        return raw.decode(ansi, "replace"), f"The file isn't UTF-8; read it as {ansi}."


def is_api(data: dict[str, Any]) -> bool:
    return any(isinstance(v, dict) and "class_type" in v for v in data.values())


def is_link(value: Any) -> bool:
    return isinstance(value, list) and len(value) == 2 and isinstance(value[0], (str, int)) and isinstance(value[1], int) and not isinstance(value[1], bool)


# ---------- comparing ----------

def ext(name: str) -> str:
    name = re.sub(r" \[(?:input|output|temp)\]$", "", name)
    dot = name.rfind(".")
    return name[dot:].lower() if dot > max(name.rfind("/"), name.rfind("\\")) else ""


def norm(name: str) -> str:
    return name.replace("\\", "/")


def near(name: str, names: list[str]) -> str | None:
    """The server's own spelling of name when it differs only in slashes, letter case or folder."""
    n = norm(name).lower()
    base = n.rsplit("/", 1)[-1]
    for other in names:
        if not isinstance(other, str):
            continue
        o = norm(other).lower()
        if o == n:
            return other
    hits = [o for o in names if isinstance(o, str) and norm(o).lower().rsplit("/", 1)[-1] == base]
    return hits[0] if len(hits) == 1 else None


def combo(spec: Any) -> tuple[list[Any] | None, dict[str, Any]] | None:
    """(options, extras) when an /object_info input spec is a dropdown; options is None when the server fills it later."""
    if not isinstance(spec, list) or not spec:
        return None
    extra = spec[1] if len(spec) > 1 and isinstance(spec[1], dict) else {}
    if isinstance(spec[0], list):
        return spec[0], extra
    if spec[0] == "COMBO":
        options = extra.get("options")
        return (options if isinstance(options, list) else None), extra
    return None


def input_specs(info: dict[str, Any]) -> dict[str, Any]:
    inputs = info.get("input") if isinstance(info, dict) else None
    specs: dict[str, Any] = {}
    if isinstance(inputs, dict):
        for section in ("required", "optional"):
            if isinstance(inputs.get(section), dict):
                specs.update(inputs[section])
    return specs


def embedding_names(text: str) -> list[str]:
    names = []
    for m in EMBEDDING.finditer(text):
        name = m.group(1).rstrip(",")
        if text[m.end() : m.end() + 1] == ")":  # "(embedding:name:1.2)": the number is a weight
            name = re.sub(r":-?\d+(?:\.\d+)?$", "", name)
        for e in EMBEDDING_EXTS:
            if name.lower().endswith(e):
                name = name[: -len(e)]
        if name:
            names.append(name)
    return names


class Check:
    def __init__(self, server: Server, object_info: dict[str, Any], server_os: str = ""):
        self.server = server
        self.info = object_info
        # Windows and macOS find embedding files whatever their letter case
        self.case_blind = server_os in ("win32", "darwin")
        self.report: dict[str, list[dict[str, Any]]] = {
            "missing_nodes": [], "missing_models": [], "missing_embeddings": [], "missing_inputs": [],
            "near_matches": [], "unknown_values": [], "problems": [],
        }
        self.notes: list[str] = []
        self._embeddings: list[str] | None = None
        self._seen: set[tuple[str, ...]] = set()

    def add(self, kind: str, item: dict[str, Any]) -> None:
        key = tuple(str(item.get(k, "")) for k in ("node", "subgraph", "class_type", "input", "name", "value"))
        key = (kind, *key)
        if key not in self._seen:
            self._seen.add(key)
            self.report[kind].append({k: v for k, v in item.items() if v is not None})

    def embeddings(self) -> list[str]:
        if self._embeddings is None:
            names = self.server.json("/embeddings")
            self._embeddings = [norm(n) for n in names] if isinstance(names, list) else []
        return self._embeddings

    def text(self, where: dict[str, Any], value: str) -> None:
        for name in embedding_names(value):
            have = self.embeddings()
            if norm(name) in have:
                continue
            fix = near(name, have)
            if fix and self.case_blind and norm(fix).lower() == norm(name).lower():
                continue
            if fix:
                self.add("near_matches", {**where, "name": name, "server_name": fix, "why": "the server spells this embedding differently"})
            else:
                self.add("missing_embeddings", {**where, "name": name, "folder": "embeddings"})

    def model(self, where: dict[str, Any], name: str, folder: str | None, options: list[Any] | None, url: str | None = None) -> None:
        files = self.server.models(folder) if folder else None
        have = files if files is not None else options
        if have is None or name in have:
            return  # found, or nothing to compare against
        fix = near(name, have)
        if fix:
            self.add("near_matches", {**where, "name": name, "server_name": fix, "why": "the server spells this model's path differently"})
        else:
            folder = self.server.folder_names.get(folder, folder) if folder else self.folder_of(options)
            self.add("missing_models", {**where, "name": name, "folder": folder, "url": url})

    def folder_of(self, options: list[Any] | None) -> str | None:
        """The models folder whose files are this dropdown's choices (for loaders from custom nodes). Choices that
        aren't model files ("None", or another dropdown's "fp16" in an editor-format node) don't count."""
        choices = {o for o in options or [] if isinstance(o, str) and ext(o) in MODEL_EXTS}
        if not choices:
            return None
        folders = self.server.json("/models")
        for folder in folders if isinstance(folders, list) else []:
            files = self.server.models(folder)
            if files and choices <= set(files):
                return folder
        return None

    def media(self, where: dict[str, Any], value: str) -> None:
        if value.startswith("blake3:"):
            return  # an asset id from ComfyUI's asset system; nothing to look up by name
        if not self.server.input_exists(value):
            self.add("missing_inputs", {**where, "name": value})

    # ----- API format -----
    def api(self, workflow: dict[str, Any]) -> None:
        unknown = 0
        for node_id, node in workflow.items():
            if not isinstance(node, dict) or "class_type" not in node:
                self.add("problems", {"node": node_id, "problem": "not a node: an API-format file holds only nodes, and /prompt rejects anything else"})
                continue
            cls = node["class_type"]
            where = {"node": node_id, "class_type": cls}
            if cls in EDITOR_ONLY:
                self.add("problems", {**where, "problem": f"{cls} exists only in the editor; link its input straight through (or export the workflow with File > Export (API))"})
                continue
            known = cls in self.info
            if not known:
                self.add("missing_nodes", where)
                unknown += 1
            specs = input_specs(self.info.get(cls, {}))
            inputs = node.get("inputs") if isinstance(node.get("inputs"), dict) else {}
            for name, value in inputs.items():
                at = {**where, "input": name}
                if is_link(value):
                    if str(value[0]) not in workflow:
                        self.add("problems", {**at, "problem": f"linked to node {value[0]}, which isn't in the workflow"})
                    continue
                for text in value if isinstance(value, list) else [value]:
                    if isinstance(text, str):
                        self.text(at, text)
                if known and name in specs:
                    self.dropdown(at, cls, name, specs[name], value)
        if unknown:
            self.notes.append("The inputs of nodes this ComfyUI doesn't know weren't checked.")

    def dropdown(self, where: dict[str, Any], cls: str, name: str, spec: Any, value: Any) -> None:
        c = combo(spec)
        if c is None:
            return
        options, extra = c
        for v in value if isinstance(value, list) else [value]:
            if not isinstance(v, str):
                if options and v not in options:
                    self.add("unknown_values", {**where, "value": v, "choices": options[:20]})
                continue
            folder = LOADERS.get(cls, {}).get(name)
            if folder and ext(v):
                self.model(where, v, folder, options)
            elif options is not None and v in options:
                continue
            elif any(extra.get(f) for f in UPLOAD_FLAGS) or ext(v) in MEDIA_EXTS:
                self.media(where, v)
            elif options is None:
                continue  # the server fills this list in later; nothing to compare against
            elif near(v, options):
                self.add("near_matches", {**where, "name": v, "server_name": near(v, options), "why": "the server spells it differently"})
            elif ext(v) in MODEL_EXTS:
                self.model(where, v, None, options)
            elif options:
                self.add("unknown_values", {**where, "value": v, "choices": options[:20]})

    # ----- editor format -----
    def editor(self, workflow: dict[str, Any]) -> None:
        subgraphs = [s for s in (workflow.get("definitions") or {}).get("subgraphs") or [] if isinstance(s, dict)]
        subgraph_ids = {s.get("id") for s in subgraphs}
        declared: dict[str, dict[str, Any]] = {}
        for m in workflow.get("models") or []:
            if isinstance(m, dict) and isinstance(m.get("name"), str):
                declared[m["name"]] = m
        nodes: list[tuple[dict[str, Any], str | None]] = [(n, None) for n in workflow.get("nodes") or []]
        for s in subgraphs:
            nodes += [(n, str(s.get("name") or s.get("id"))) for n in s.get("nodes") or []]
        skipped = 0
        unknown = 0
        for node, subgraph in nodes:
            if not isinstance(node, dict):
                continue
            cls = node.get("type")
            if not isinstance(cls, str) or cls in subgraph_ids or cls in EDITOR_ONLY:
                continue
            if cls.startswith(("workflow>", "workflow/")):
                self.notes.append(f"Group node {cls} wasn't checked; convert it to normal nodes in ComfyUI to check them.")
                continue
            if node.get("mode") in (2, 4):  # muted or bypassed: not part of a run
                skipped += 1
                continue
            props = node.get("properties") if isinstance(node.get("properties"), dict) else {}
            for m in props.get("models") or []:
                if isinstance(m, dict) and isinstance(m.get("name"), str):
                    declared.setdefault(m["name"], m)
            where = {"node": str(node.get("id")), "class_type": cls, "subgraph": subgraph}
            values = node.get("widgets_values")
            strings = [v for v in (values.values() if isinstance(values, dict) else values or []) if isinstance(v, str)]
            for s in strings:
                self.text(where, s)
            if cls not in self.info:
                unknown += 1
                packs = pack_from_properties(props)
                self.add("missing_nodes", {**where, "provided_by": packs, "hint_from": "workflow" if packs else None})
                continue
            self.editor_values(where, cls, strings, declared)
        if skipped:
            self.notes.append(f"{skipped} muted or bypassed node(s) weren't checked; they don't run.")
        if unknown:
            self.notes.append("The settings of nodes this ComfyUI doesn't know weren't checked.")

    def editor_values(self, where: dict[str, Any], cls: str, strings: list[str], declared: dict[str, dict[str, Any]]) -> None:
        # widget values aren't labelled with their input, so each is compared with all of the node's dropdowns
        dropdowns = [c for c in (combo(s) for s in input_specs(self.info[cls]).values()) if c is not None]
        choices = [o for options, _ in dropdowns for o in options or []]
        takes_files = any(any(extra.get(f) for f in UPLOAD_FLAGS) for _, extra in dropdowns) or any(
            isinstance(o, str) and ext(o) in MEDIA_EXTS for o in choices
        )
        folders = set(LOADERS.get(cls, {}).values())
        for v in strings:
            if v in choices or not ext(v):
                continue
            if ext(v) in MODEL_EXTS:
                d = declared.get(v) or {}
                folder = d.get("directory") if isinstance(d.get("directory"), str) else None
                if not folder and len(folders) == 1:
                    folder = next(iter(folders))
                self.model(where, v, folder, choices, d.get("url") if isinstance(d.get("url"), str) else None)
            elif takes_files and ext(v) in MEDIA_EXTS:
                self.media(where, v)


def pack_from_properties(props: dict[str, Any]) -> list[dict[str, Any]] | None:
    """The node pack the editor recorded for a node (its registry id, or its GitHub repo)."""
    cnr, aux, ver = props.get("cnr_id"), props.get("aux_id"), props.get("ver")
    if isinstance(cnr, str) and cnr:
        pack: dict[str, Any] = {"id": cnr, "version": ver if isinstance(ver, str) else None}
        if cnr == "comfy-core":
            pack["note"] = "comes with ComfyUI itself: this ComfyUI is older than the one that made the workflow, so update ComfyUI"
        return [{k: v for k, v in pack.items() if v is not None}]
    if isinstance(aux, str) and aux:
        return [{"repo": f"https://github.com/{aux}"}]
    return None


def manager_hints(server: Server, missing: list[dict[str, Any]]) -> bool:
    """Fill provided_by from ComfyUI-Manager's own list of which pack has which node. False when there's no Manager."""
    mappings = None
    for path in ("/v2/customnode/getmappings?mode=local", "/customnode/getmappings?mode=local"):
        mappings = server.json(path, timeout=30)
        if isinstance(mappings, dict):
            break
    if not isinstance(mappings, dict):
        return False
    for item in missing:
        if item.get("provided_by"):
            continue
        cls = item["class_type"]
        packs = []
        for key, entry in mappings.items():
            if not isinstance(entry, list) or not entry or not isinstance(entry[0], list):
                continue
            meta = entry[1] if len(entry) > 1 and isinstance(entry[1], dict) else {}
            pattern = meta.get("nodename_pattern")
            matched = cls in entry[0]
            if not matched and isinstance(pattern, str):
                try:
                    matched = re.search(pattern, cls) is not None
                except re.error:
                    matched = False
            if matched:
                packs.append({"id": key, "title": meta.get("title_aux")} if meta.get("title_aux") else {"id": key})
        if packs:
            item["provided_by"] = packs[:5]
            item["hint_from"] = "comfyui-manager"
            if len(packs) > 1:
                item["note"] = "more than one pack declares this node; pick one with the user"
    return True


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):  # a Windows pipe is cp1252 otherwise
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(
        description="Report the node types, models, embeddings and input files a ComfyUI workflow needs that a running ComfyUI lacks.",
        epilog="Exit status: 0 nothing missing, 1 something missing or to fix, 2 the check couldn't run.",
    )
    parser.add_argument("workflow", type=Path, help="workflow file: API format, editor format, or a PNG made by ComfyUI")
    parser.add_argument("--server", help="ComfyUI's address (default: try http://127.0.0.1:8188, then :8000)")
    parser.add_argument("--timeout", type=float, default=60, help="seconds to wait for each answer (default 60)")
    args = parser.parse_args()
    if not args.timeout > 0:
        parser.error("--timeout is a number of seconds above 0")

    kind, workflow, notes = read_workflow(args.workflow)
    server = find_server(args.server, args.timeout)
    try:
        stats = server.json("/system_stats", timeout=10) or {}
        object_info = server.json("/object_info")
        if not isinstance(object_info, dict):
            fail(f"{server.url} didn't return its node list (/object_info).")
        system = stats.get("system") if isinstance(stats, dict) else None
        check = Check(server, object_info, (system or {}).get("os", ""))
        check.notes.extend(notes)
        if kind == "api":
            check.api(workflow)
        else:
            check.editor(workflow)
        needing = [m for m in check.report["missing_nodes"] if not m.get("provided_by")]
        if needing and not manager_hints(server, check.report["missing_nodes"]):
            check.notes.append("ComfyUI-Manager isn't on this server, so missing nodes carry no package hint.")
    except NET_ERRORS as e:
        fail(f"Lost the connection to ComfyUI at {server.url}: {' '.join(str(e).split()) or type(e).__name__}")

    ready = not any(check.report.values())
    report = {
        "server": server.url,
        "comfyui_version": (stats.get("system") or {}).get("comfyui_version") if isinstance(stats, dict) else None,
        "workflow": str(args.workflow),
        "format": kind,
        "ready": ready,
        **check.report,
        "notes": check.notes,
    }
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 0 if ready else 1


if __name__ == "__main__":
    sys.exit(main())
