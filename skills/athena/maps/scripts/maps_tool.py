#!/usr/bin/env python3
"""Places, routes and time zones from OpenStreetMap's free services: geocode, reverse, nearby, route, timezone,
categories.

    python maps_tool.py geocode "Eiffel Tower, Paris"
    python maps_tool.py reverse 48.8584,2.2945
    python maps_tool.py nearby 48.8584,2.2945 --category pharmacy
    python maps_tool.py route "Eiffel Tower, Paris" "Louvre, Paris" --mode foot
    python maps_tool.py timezone 35.6812,139.7671
    python maps_tool.py categories

A point is "LAT,LON" (latitude first, as a map pin gives it) or a place name, which Nominatim looks up first.

Services: Nominatim (nominatim.openstreetmap.org) for names and addresses, Overpass (overpass-api.de) for places by
OpenStreetMap tag, and FOSSGIS's OSRM servers (routing.openstreetmap.de) for car, foot and bike routes. They ask for
a User-Agent that names the program; this one sends "AthenaAgents/1.0 (maps_tool)", plus --contact when given, and
waits at least a second between requests to Nominatim and to the routers, as their usage policies require. Time zones
are worked out on this computer.

Packages: the standard library; timezone for a point needs timezonefinder, and on Windows timezone needs tzdata.

Prints JSON with OpenStreetMap's attribution. Exit codes: 0 done; 1 it ran but found nothing for a place, no places,
or no route, or stopped a long batch early (the JSON says which); 2 it couldn't do the job, with one line on stderr
saying why.
"""

from __future__ import annotations

import argparse
import codecs
import difflib
import html
import http.client
import importlib.metadata
import ipaddress
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
import zoneinfo
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, NoReturn

START = time.monotonic()
USER_AGENT = "AthenaAgents/1.0 (maps_tool)"
NOMINATIM = "https://nominatim.openstreetmap.org"
OVERPASS = "https://overpass-api.de/api/interpreter"
ROUTER = "https://routing.openstreetmap.de/routed-{mode}"
ATTRIBUTION = "Data © OpenStreetMap contributors, ODbL 1.0. https://www.openstreetmap.org/copyright"
FIX_THE_MAP = "https://www.openstreetmap.org/fixthemap"
NOMINATIM_POLICY = "https://operations.osmfoundation.org/policies/nominatim/"
# The least time between two requests to one public server, from its usage policy: Nominatim's (above) and the
# FOSSGIS routers' (routing.openstreetmap.de/about.html). --wait can only make it longer.
MIN_WAIT = {"nominatim.openstreetmap.org": 1.0, "routing.openstreetmap.de": 1.0, "router.project-osrm.org": 1.0}
# Overpass hands back places in id order, not by distance, so nearby asks for up to this many and sorts them itself.
OVERPASS_CAP = 1000
# A bigger circle is a heavy query for a shared server; a whole region is better done with your own copy of the data.
MAX_RADIUS = 50000
NET_ERRORS = (OSError, http.client.HTTPException)

# mode: (FOSSGIS profile, Google Maps travelmode, openstreetmap.org directions engine)
MODES = {
    "car": ("car", "driving", "fossgis_osrm_car"),
    "foot": ("foot", "walking", "fossgis_osrm_foot"),
    "bike": ("bike", "bicycling", "fossgis_osrm_bicycle"),
}
MODE_NAMES = {"car": "car", "drive": "car", "driving": "car", "foot": "foot", "walk": "foot", "walking": "foot",
              "bike": "bike", "bicycle": "bike", "cycle": "bike", "cycling": "bike"}


def _tag(key: str, value: str, *more: tuple[str, str]) -> list[tuple[str, str]]:
    return [(key, value), *more]


# name: (group, alternatives). A place is in the category when it has every tag of one alternative.
CATEGORIES: dict[str, tuple[str, list[list[tuple[str, str]]]]] = {
    "restaurant": ("Food and drink", [_tag("amenity", "restaurant")]),
    "fast_food": ("Food and drink", [_tag("amenity", "fast_food")]),
    "cafe": ("Food and drink", [_tag("amenity", "cafe")]),
    "bar": ("Food and drink", [_tag("amenity", "bar")]),
    "pub": ("Food and drink", [_tag("amenity", "pub")]),
    "bakery": ("Food and drink", [_tag("shop", "bakery"), _tag("amenity", "bakery")]),
    "ice_cream": ("Food and drink", [_tag("amenity", "ice_cream"), _tag("shop", "ice_cream")]),
    "supermarket": ("Food and drink", [_tag("shop", "supermarket")]),
    "convenience": ("Food and drink", [_tag("shop", "convenience")]),
    "marketplace": ("Food and drink", [_tag("amenity", "marketplace")]),
    "pharmacy": ("Health", [_tag("amenity", "pharmacy"), _tag("healthcare", "pharmacy")]),
    "hospital": ("Health", [_tag("amenity", "hospital")]),
    "clinic": ("Health", [_tag("amenity", "clinic")]),
    "doctor": ("Health", [_tag("amenity", "doctors")]),
    "dentist": ("Health", [_tag("amenity", "dentist")]),
    "veterinary": ("Health", [_tag("amenity", "veterinary")]),
    "atm": ("Money", [_tag("amenity", "atm")]),
    "bank": ("Money", [_tag("amenity", "bank")]),
    "bureau_de_change": ("Money", [_tag("amenity", "bureau_de_change")]),
    "fuel": ("Getting around", [_tag("amenity", "fuel")]),
    "charging_station": ("Getting around", [_tag("amenity", "charging_station")]),
    "parking": ("Getting around", [_tag("amenity", "parking")]),
    "bicycle_rental": ("Getting around", [_tag("amenity", "bicycle_rental")]),
    "car_rental": ("Getting around", [_tag("amenity", "car_rental")]),
    "taxi": ("Getting around", [_tag("amenity", "taxi")]),
    "bus_stop": ("Getting around", [_tag("highway", "bus_stop")]),
    "train_station": ("Getting around", [_tag("railway", "station")]),
    "ferry_terminal": ("Getting around", [_tag("amenity", "ferry_terminal")]),
    "airport": ("Getting around", [_tag("aeroway", "aerodrome")]),
    "hotel": ("Places to stay", [_tag("tourism", "hotel")]),
    "hostel": ("Places to stay", [_tag("tourism", "hostel")]),
    "guest_house": ("Places to stay", [_tag("tourism", "guest_house")]),
    "camp_site": ("Places to stay", [_tag("tourism", "camp_site")]),
    "museum": ("Things to do", [_tag("tourism", "museum")]),
    "attraction": ("Things to do", [_tag("tourism", "attraction")]),
    "viewpoint": ("Things to do", [_tag("tourism", "viewpoint")]),
    "zoo": ("Things to do", [_tag("tourism", "zoo")]),
    "park": ("Things to do", [_tag("leisure", "park")]),
    "playground": ("Things to do", [_tag("leisure", "playground")]),
    "cinema": ("Things to do", [_tag("amenity", "cinema")]),
    "theatre": ("Things to do", [_tag("amenity", "theatre")]),
    "nightclub": ("Things to do", [_tag("amenity", "nightclub")]),
    "gym": ("Things to do", [_tag("leisure", "fitness_centre")]),
    "swimming": ("Things to do", [
        _tag("leisure", "sports_centre", ("sport", "swimming")),
        _tag("leisure", "swimming_pool", ("access", "yes")),
        _tag("leisure", "swimming_pool", ("access", "customers")),
    ]),
    "post_office": ("Everyday services", [_tag("amenity", "post_office")]),
    "post_box": ("Everyday services", [_tag("amenity", "post_box")]),
    "police": ("Everyday services", [_tag("amenity", "police")]),
    "fire_station": ("Everyday services", [_tag("amenity", "fire_station")]),
    "toilets": ("Everyday services", [_tag("amenity", "toilets")]),
    "drinking_water": ("Everyday services", [_tag("amenity", "drinking_water")]),
    "library": ("Everyday services", [_tag("amenity", "library")]),
    "laundry": ("Everyday services", [_tag("shop", "laundry")]),
    "hairdresser": ("Everyday services", [_tag("shop", "hairdresser")]),
    "bookshop": ("Everyday services", [_tag("shop", "books")]),
    "place_of_worship": ("Worship", [_tag("amenity", "place_of_worship")]),
    "church": ("Worship", [_tag("amenity", "place_of_worship", ("religion", "christian"))]),
    "mosque": ("Worship", [_tag("amenity", "place_of_worship", ("religion", "muslim"))]),
    "synagogue": ("Worship", [_tag("amenity", "place_of_worship", ("religion", "jewish"))]),
    "hindu_temple": ("Worship", [_tag("amenity", "place_of_worship", ("religion", "hindu"))]),
    "buddhist_temple": ("Worship", [_tag("amenity", "place_of_worship", ("religion", "buddhist"))]),
    "school": ("Education", [_tag("amenity", "school")]),
    "university": ("Education", [_tag("amenity", "university")]),
    "kindergarten": ("Education", [_tag("amenity", "kindergarten")]),
}
ALIASES = {"gas_station": "fuel", "petrol_station": "fuel", "doctors": "doctor", "ev_charging": "charging_station",
           "bookstore": "bookshop", "pool": "swimming", "swimming_pool": "swimming", "chemist": "pharmacy",
           "drugstore": "pharmacy", "petrol": "fuel", "hotel_room": "hotel", "railway_station": "train_station"}


# ---------------------------------------------------------------- shared helpers


def utf8_output() -> None:
    # A Windows pipe is cp1252 unless the script says otherwise; place names come in every script.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
        except (AttributeError, ValueError):
            pass


class Fail(Exception):
    """A problem to report in one line and exit 2."""


class Partial(Fail):
    """A failure after some requests already went through: what they found is printed too, so nothing is sent twice."""

    def __init__(self, message: str, data: dict[str, Any]):
        super().__init__(message)
        self.data = data


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
    except Partial as e:
        emit(e.data)
        why = str(e)
    except Fail as e:
        why = str(e)
    except OSError as e:  # a locked output file on Windows, a full disk, a folder where a file should go
        where = e.filename2 or e.filename
        why = f"{e.strerror or e}" + (f": {where}" if where else "")
    except Exception as e:  # an answer shaped in a way nobody expected
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


def write_into_place(path: str, text: str) -> None:
    """Write to a temporary file beside the output and move it into place, so a failed run leaves no half file."""
    if os.path.isdir(path):
        raise Fail(f"the output path is a folder: {path}")
    folder = os.path.dirname(os.path.abspath(path))
    if not os.path.isdir(folder):
        raise Fail(f"the folder for the output doesn't exist: {folder}")
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".maps-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


# ---------------------------------------------------------------- talking to the services


class SameHost(urllib.request.HTTPRedirectHandler):
    """Follows a redirect only to the same host: each request goes to the service it was meant for."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        new, old = urllib.parse.urlsplit(newurl), urllib.parse.urlsplit(req.full_url)
        if new.scheme not in ("http", "https") or new.hostname != old.hostname:
            return None  # urllib then raises an HTTPError with the redirect's status
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def direct(host: str) -> bool:
    """Whether to go round the system proxy: your own server on this machine or the local network is reached
    directly. Other names follow the system's proxy settings."""
    host = host.lower().rstrip(".")
    if host == "localhost" or host.endswith(".local") or ("." not in host and ":" not in host):
        return True
    try:
        return not ipaddress.ip_address(host).is_global
    except ValueError:
        return False


def one_line(body: bytes, ctype: str) -> str:
    """A server's error page as one short line of text."""
    text = body.decode("utf-8", "replace")
    if "html" in ctype.lower() or text.lstrip().startswith("<"):
        text = re.sub(r"(?is)<(script|style|head)\b.*?</\1>", " ", text)
        text = re.sub(r"\s+([:;,.])", r"\1", html.unescape(re.sub(r"<[^>]+>", " ", text)))
        at = text.find("Error:")  # Overpass puts its message after this
        if at >= 0:
            text = text[at:]
    text = " ".join(text.split())
    return (text[:240] + "…") if len(text) > 240 else (text or "an empty answer")


class Client:
    def __init__(self, contact: str | None, wait: float | None, timeout: float):
        self.user_agent = f"AthenaAgents/1.0 (maps_tool; {contact})" if contact else USER_AGENT
        self.wait = wait or 0.0
        self.timeout = timeout
        self.last: dict[str, float] = {}

    def gap(self, host: str) -> float:
        return max(MIN_WAIT.get(host, 0.0), self.wait)

    def call(self, service: str, url: str, data: bytes | None = None) -> tuple[int, str, bytes]:
        host = (urllib.parse.urlsplit(url).hostname or "").lower()
        gap = self.gap(host)
        if gap:
            # The first request waits too, counted from when the script started, so runs one after another still
            # keep the gap.
            delay = self.last.get(host, START) + gap - time.monotonic()
            if delay > 0:
                time.sleep(delay)
        handlers: list[Any] = [SameHost()] + ([urllib.request.ProxyHandler({})] if direct(host) else [])
        headers = {"User-Agent": self.user_agent, "Accept": "application/json"}
        if data is not None:
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        req = urllib.request.Request(url, data=data, headers=headers)
        try:
            with urllib.request.build_opener(*handlers).open(req, timeout=self.timeout) as res:
                return res.status, res.headers.get("Content-Type", ""), res.read()
        except urllib.error.HTTPError as e:
            try:
                body = e.read()
            except NET_ERRORS:
                body = b""
            e.close()
            return e.code, (e.headers.get("Content-Type", "") if e.headers else ""), body
        except urllib.error.URLError as e:
            reason = e.reason
            if isinstance(reason, TimeoutError):
                raise Fail(f"{service} at {host} didn't answer within {self.timeout:g} seconds") from None
            raise Fail(f"can't reach {service} at {host}: {reason}") from None
        except TimeoutError:
            raise Fail(f"{service} at {host} didn't answer within {self.timeout:g} seconds") from None
        except NET_ERRORS as e:
            raise Fail(f"{service} at {host} broke off the answer: {e}") from None
        finally:
            self.last[host] = time.monotonic()


def refused(service: str, host: str, status: int, ctype: str, body: bytes) -> Fail:
    if status == 429:
        wait = "wait at least 30 seconds, as its rules ask," if service == "Overpass" else "stop for now and wait"
        return Fail(f"{service} at {host} says too many requests (HTTP 429): {wait} before trying again, never in a loop")
    if status in (403, 418) and service == "Nominatim":
        return Fail(f"Nominatim at {host} refused the request (HTTP {status}); it blocks programs that break its usage "
                    f"policy ({NOMINATIM_POLICY}). Don't retry; tell the user")
    if status == 504 and service == "Overpass":
        return Fail(f"Overpass at {host} is overloaded (HTTP 504): try again later, with a smaller --radius, or with "
                    "another server through --overpass-url")
    if 300 <= status < 400:
        return Fail(f"{service} at {host} sent the request to another address (HTTP {status}); not followed")
    return Fail(f"{service} at {host} answered HTTP {status}: {one_line(body, ctype)}")


def parse_json(service: str, host: str, status: int, ctype: str, body: bytes) -> Any:
    try:
        return json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise Fail(f"{service} at {host} didn't answer with JSON (HTTP {status}, {ctype or 'no type'}); is that the "
                   f"right address? It said: {one_line(body, ctype)}") from None


def service_url(text: str, option: str) -> str:
    parts = urllib.parse.urlsplit(text.strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise Fail(f"{option} must be an http or https address, not {text!r}")
    return text.strip().rstrip("/")


# ---------------------------------------------------------------- points, places and links

POINT = re.compile(r"\s*([+-]?\d+(?:\.\d+)?)\s*(?:,|;|\s)\s*([+-]?\d+(?:\.\d+)?)\s*")


def parse_point(text: str) -> tuple[float, float] | None:
    """(lat, lon) from "LAT,LON" (or "LAT LON"), None when the text is a place name."""
    m = POINT.fullmatch(text)
    if not m:
        return None
    lat, lon = float(m.group(1)), float(m.group(2))
    if not -90 <= lat <= 90 or not -180 <= lon <= 180:
        hint = " (longitude first? this takes LAT,LON)" if -90 <= lon <= 90 and -180 <= lat <= 180 else ""
        raise Fail(f"{text.strip()} isn't a point on Earth: latitude goes from -90 to 90, longitude from -180 to 180{hint}")
    return lat, lon


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Straight-line (great-circle) distance in metres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * 6371008.8 * math.asin(min(1.0, math.sqrt(a)))


def coord(value: float) -> str:
    return f"{value:.6f}".rstrip("0").rstrip(".")


def map_links(lat: float, lon: float) -> dict[str, str]:
    la, lo = coord(lat), coord(lon)
    return {
        "openstreetmap": f"https://www.openstreetmap.org/?mlat={la}&mlon={lo}#map=18/{la}/{lo}",
        "google_maps": f"https://www.google.com/maps/search/?api=1&query={la},{lo}",
    }


def osm_url(kind: str, ident: Any) -> str | None:
    return f"https://www.openstreetmap.org/{kind}/{ident}" if kind in ("node", "way", "relation") and ident else None


def nice_distance(m: float) -> str:
    miles = m / 1609.344
    mi = f"{miles:.1f} mi" if miles < 100 else f"{miles:.0f} mi"
    if m < 1000:
        return f"{m:.0f} m ({mi})"
    km = m / 1000
    return (f"{km:.1f} km" if km < 100 else f"{km:.0f} km") + f" ({mi})"


def nice_duration(s: float) -> str:
    minutes = int(round(s / 60))
    if minutes < 60:
        return f"{max(minutes, 1)} min"
    h, m = divmod(minutes, 60)
    return f"{h} h {m:02d} min"


# ---------------------------------------------------------------- Nominatim


class Lookup:
    """Nominatim lookups for one run, each asked once."""

    def __init__(self, client: Client, args: argparse.Namespace):
        self.client = client
        self.base = service_url(args.nominatim_url, "--nominatim-url")
        self.host = (urllib.parse.urlsplit(self.base).hostname or "").lower()
        self.lang = args.lang
        self.country = args.country
        self.cache: dict[tuple[str, int], list[dict[str, Any]]] = {}

    def get(self, path: str, params: dict[str, Any]) -> Any:
        params = {**params, "format": "jsonv2"}
        if self.lang:
            params["accept-language"] = self.lang
        url = f"{self.base}/{path}?{urllib.parse.urlencode(params)}"
        status, ctype, body = self.client.call("Nominatim", url)
        if status != 200:
            raise refused("Nominatim", self.host, status, ctype, body)
        return parse_json("Nominatim", self.host, status, ctype, body)

    def search(self, query: str, limit: int) -> list[dict[str, Any]]:
        key = (" ".join(query.lower().split()), limit)
        if key not in self.cache:
            params: dict[str, Any] = {"q": query, "limit": limit, "addressdetails": 1}
            if self.country:
                params["countrycodes"] = self.country
            data = self.get("search", params)
            if not isinstance(data, list):
                raise Fail(f"Nominatim at {self.host} didn't answer a search with a list of places; is that the right address?")
            self.cache[key] = [place(item) for item in data if isinstance(item, dict)]
        return self.cache[key]

    def reverse(self, lat: float, lon: float, zoom: int) -> dict[str, Any] | None:
        data = self.get("reverse", {"lat": coord(lat), "lon": coord(lon), "zoom": zoom, "addressdetails": 1})
        if not isinstance(data, dict):
            raise Fail(f"Nominatim at {self.host} didn't answer a reverse lookup with a place; is that the right address?")
        if "error" in data or "lat" not in data:
            return None
        return place(data)


def place(item: dict[str, Any]) -> dict[str, Any]:
    lat, lon = float(item["lat"]), float(item["lon"])
    out: dict[str, Any] = {
        "name": item.get("name") or None,
        "display_name": item.get("display_name"),
        "lat": lat,
        "lon": lon,
        "kind": f"{item.get('category') or item.get('class')}={item.get('type')}",
        "address": item.get("address") or {},
    }
    box = item.get("boundingbox")
    if isinstance(box, list) and len(box) == 4:
        south, north, west, east = (float(v) for v in box)
        out["bounding_box"] = {"south": south, "north": north, "west": west, "east": east}
    url = osm_url(str(item.get("osm_type", "")), item.get("osm_id"))
    if url:
        out["osm"] = url
    out["links"] = map_links(lat, lon)
    return out


def resolve(lookup: Lookup, text: str) -> dict[str, Any] | None:
    """A point as {"given", "lat", "lon"} (and "found" when a name was looked up); None when nothing matched."""
    point = parse_point(text)
    if point:
        return {"given": text.strip(), "lat": point[0], "lon": point[1]}
    if not text.strip():
        raise Fail("an empty place name")
    hits = lookup.search(text, 1)
    if not hits:
        return None
    hit = hits[0]
    return {"given": text.strip(), "lat": hit["lat"], "lon": hit["lon"], "found": hit["display_name"], "osm": hit.get("osm")}


# ---------------------------------------------------------------- commands


def cmd_geocode(args: argparse.Namespace) -> int:
    queries = [q for q in args.query if q.strip()]
    if args.file:
        lines = read_text(args.file, "the list of places").splitlines()
        queries += [line.strip() for line in lines if line.strip() and not line.lstrip().startswith("#")]
    if not queries:
        raise Fail("give at least one place to look up, or --file with one place per line")
    if args.out and args.file and os.path.abspath(args.out) == os.path.abspath(args.file):
        raise Fail(f"--out would write over the list of places: {args.out}")
    unique: list[str] = []
    seen: set[str] = set()
    for q in queries:
        key = " ".join(q.lower().split())
        if key not in seen:
            seen.add(key)
            unique.append(q.strip())
    lookup = Lookup(Client(args.contact, args.wait, args.timeout), args)
    out: dict[str, Any] = {"command": "geocode", "service": lookup.host, "places": [], "not_found": []}
    began = time.monotonic()
    for i, q in enumerate(unique):
        if i and time.monotonic() - began > args.max_time:
            out["not_sent"] = unique[i:]
            out["note"] = (f"stopped after {args.max_time:g} seconds so the shell doesn't cut the run off; run the "
                           "places in not_sent next")
            break
        try:
            hits = lookup.search(q, args.limit)
        except Fail as e:
            if not out["places"] and not out["not_found"]:
                raise
            out["not_sent"] = unique[i:]
            out["attribution"] = ATTRIBUTION
            raise Partial(f"{e} (stopped at {q!r}; the answers before it are printed)", out) from None
        out["places"].append({"query": q, "found": bool(hits), "results": hits})
        if not hits:
            out["not_found"].append(q)
    if len(queries) != len(unique):
        out["duplicates_skipped"] = len(queries) - len(unique)
    out["attribution"] = ATTRIBUTION
    code = 1 if out["not_found"] or out.get("not_sent") else 0
    if args.out:
        write_into_place(args.out, json.dumps(out, ensure_ascii=False, indent=2) + "\n")
        emit({"command": "geocode", "written": os.path.abspath(args.out), "places": len(out["places"]),
              "not_found": out["not_found"], "not_sent": out.get("not_sent", []), "attribution": ATTRIBUTION})
    else:
        emit(out)
    return code


def cmd_reverse(args: argparse.Namespace) -> int:
    text = " ".join(args.point)
    point = parse_point(text)
    if not point:
        raise Fail(f"reverse takes a point as LAT,LON, not {text!r}")
    lookup = Lookup(Client(args.contact, args.wait, args.timeout), args)
    found = lookup.reverse(point[0], point[1], args.zoom)
    out: dict[str, Any] = {"command": "reverse", "service": lookup.host, "point": {"lat": point[0], "lon": point[1]},
                           "found": found is not None}
    if found:
        out["place"] = found
        out["place_is_m_away"] = round(distance_m(point[0], point[1], found["lat"], found["lon"]))
    else:
        out["note"] = "Nominatim has no address here (open sea, or no map data)"
    out["links"] = map_links(point[0], point[1])
    out["attribution"] = ATTRIBUTION
    emit(out)
    return 0 if found else 1


def ql(text: str) -> str:
    """A string literal in Overpass QL."""
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def literal_regex(text: str) -> str:
    return re.sub(r"([.^$|?*+()\[\]{}\\])", r"\\\1", text)


def key_value(text: str, option: str) -> tuple[str, str | None]:
    key, eq, value = text.partition("=")
    key, value = key.strip(), value.strip()
    if not key or (eq and not value) or any(ord(c) < 32 for c in text):
        raise Fail(f"{option} takes KEY=VALUE (or KEY), not {text!r}")
    return key, (value if eq and value != "*" else None)


def category_tags(name: str) -> list[list[tuple[str, str]]]:
    key = re.sub(r"[\s-]+", "_", name.strip().lower())
    key = ALIASES.get(key, key)
    if key not in CATEGORIES:
        close = difflib.get_close_matches(key, list(CATEGORIES) + list(ALIASES), n=3)
        hint = f" (did you mean {', '.join(close)}?)" if close else ""
        raise Fail(f"no category {name!r}{hint}; run the categories command for the list, or use --tag KEY=VALUE")
    return CATEGORIES[key][1]


def cmd_nearby(args: argparse.Namespace) -> int:
    alternatives: list[tuple[str, list[tuple[str, str | None]]]] = []
    for name in args.category or []:
        for alt in category_tags(name):
            alternatives.append((" + ".join(f"{k}={v}" for k, v in alt), list(alt)))
    for text in args.tag or []:
        k, v = key_value(text, "--tag")
        alternatives.append((f"{k}={v if v is not None else '*'}", [(k, v)]))
    if not alternatives:
        raise Fail("say what to look for: --category NAME (see the categories command) or --tag KEY=VALUE")
    extra = ""
    for text in args.with_ or []:
        k, v = key_value(text, "--with")
        # a value can be one of a list ("italian;pizza"); match it as a whole word of that list, any case
        extra += f"[{ql(k)}~{ql('(^|;) *' + literal_regex(v) + ' *(;|$)')},i]" if v is not None else f"[{ql(k)}]"
    if args.name:
        extra += f'["name"~{ql(literal_regex(args.name.strip()))},i]'

    client = Client(args.contact, args.wait, args.timeout)
    where_text = " ".join(args.where)
    lookup = Lookup(client, args)
    center = resolve(lookup, where_text)
    out: dict[str, Any] = {"command": "nearby"}
    if center is None:
        out.update({"found": False, "not_found": where_text, "attribution": ATTRIBUTION})
        emit(out)
        return 1
    lat, lon = center["lat"], center["lon"]
    radius = args.radius
    lines = []
    for _, alt in alternatives:
        tags = "".join(f"[{ql(k)}={ql(v)}]" if v is not None else f"[{ql(k)}]" for k, v in alt)
        lines.append(f"  nwr{tags}{extra}(around:{radius:g},{coord(lat)},{coord(lon)});")
    query = "[out:json][timeout:25];\n(\n" + "\n".join(lines) + f"\n);\nout center tags {OVERPASS_CAP};"

    base = service_url(args.overpass_url, "--overpass-url")
    host = (urllib.parse.urlsplit(base).hostname or "").lower()
    status, ctype, body = client.call("Overpass", base, urllib.parse.urlencode({"data": query}).encode("utf-8"))
    if status != 200:
        raise refused("Overpass", host, status, ctype, body)
    data = parse_json("Overpass", host, status, ctype, body)
    if not isinstance(data, dict) or not isinstance(data.get("elements"), list):
        raise Fail(f"Overpass at {host} didn't answer like an Overpass server; is that the right address?")
    remark = str(data.get("remark") or "")
    if "error" in remark.lower():
        raise Fail(f"Overpass at {host} stopped the search: {' '.join(remark.split())}. Try a smaller --radius")

    places: dict[tuple[str, Any], dict[str, Any]] = {}
    for el in data["elements"]:
        if not isinstance(el, dict):
            continue
        pos = el if "lat" in el else el.get("center") or {}
        if "lat" not in pos or "lon" not in pos:
            continue
        key = (el.get("type"), el.get("id"))
        if key in places:
            continue
        places[key] = describe(el, float(pos["lat"]), float(pos["lon"]), lat, lon, alternatives, args.lang)
    ordered = sorted(places.values(), key=lambda p: p["straight_line_m"])
    out.update({
        "service": host,
        "center": center,
        "radius_m": radius,
        "searched_for": [label for label, _ in alternatives],
        "found_in_radius": len(ordered),
        "complete": len(data["elements"]) < OVERPASS_CAP,
        "places": ordered[: args.limit],
    })
    if not out["complete"]:
        out["note"] = (f"more than {OVERPASS_CAP} matches in the circle; these are the nearest of the first "
                       f"{OVERPASS_CAP} the server sent. Use a smaller --radius")
    if remark:
        out["server_remark"] = remark
    base_time = (data.get("osm3s") or {}).get("timestamp_osm_base")
    if base_time:
        out["map_data_as_of"] = base_time
    out["attribution"] = ATTRIBUTION
    emit(out)
    return 0 if ordered else 1


def describe(el: dict[str, Any], lat: float, lon: float, clat: float, clon: float,
             alternatives: list[tuple[str, list[tuple[str, str | None]]]], lang: str | None) -> dict[str, Any]:
    tags: dict[str, str] = {k: str(v) for k, v in (el.get("tags") or {}).items()}
    local = tags.get("name")
    wanted = tags.get(f"name:{lang.split(',')[0].strip()}") if lang else None
    out: dict[str, Any] = {"name": wanted or local or tags.get("brand") or None}
    if wanted and local and wanted != local:
        out["local_name"] = local
    for label, alt in alternatives:
        if all(tags.get(k) == v if v is not None else k in tags for k, v in alt):
            out["is"] = label
            break
    out["lat"], out["lon"] = lat, lon
    out["straight_line_m"] = round(distance_m(clat, clon, lat, lon))
    address = {k[5:]: v for k, v in tags.items() if k.startswith("addr:")}
    if address:
        out["address"] = address
    for field, keys in (("opening_hours", ("opening_hours",)), ("phone", ("phone", "contact:phone")),
                        ("website", ("website", "contact:website", "url")), ("cuisine", ("cuisine",)),
                        ("wheelchair", ("wheelchair",)), ("brand", ("brand",)),
                        ("checked_on", ("check_date:opening_hours", "check_date"))):
        for k in keys:
            if tags.get(k):
                out[field] = tags[k]
                break
    url = osm_url(str(el.get("type", "")), el.get("id"))
    if url:
        out["osm"] = url
    out["links"] = map_links(lat, lon)
    return out


def side_of(mod: str) -> str:
    return "right" if "right" in mod else "left" if "left" in mod else ""


def instruction(step: dict[str, Any], leg: int, last_leg: int) -> str:
    """Words for one OSRM step. OSRM sends only the manoeuvre (its type and modifier) and the road's name."""
    m = step.get("maneuver") or {}
    kind, mod = str(m.get("type") or "turn"), str(m.get("modifier") or "")
    road = str(step.get("name") or "")
    if step.get("ref"):
        road = f"{road} ({step['ref']})" if road else str(step["ref"])
    onto = f" onto {road}" if road else ""
    side = side_of(mod)
    if step.get("mode") == "ferry" and kind not in ("depart", "arrive"):
        return f"Take the ferry{(' ' + road) if road else ''}"
    if kind == "depart":
        heading = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"]
        bearing = m.get("bearing_after")
        start = f"Start on {road}" if road else "Start"
        return f"{start}, heading {heading[round(float(bearing) / 45) % 8]}" if isinstance(bearing, (int, float)) else start
    if kind == "arrive":
        where = f", on the {side}" if mod in ("left", "right", "slight left", "slight right") else ""
        return (f"Arrive at stop {leg + 1}" if leg < last_leg else "Arrive at the destination") + where
    if kind in ("roundabout", "rotary"):
        exit_no = m.get("exit")
        return f"At the roundabout take exit {exit_no}{onto}" if exit_no else f"Go round the roundabout{onto}"
    if kind in ("exit roundabout", "exit rotary"):
        return f"Leave the roundabout{onto}"
    if kind in ("new name", "notification"):
        return f"Continue{onto}"
    if kind == "fork":
        return f"Keep {side or 'ahead'} at the fork{onto}"
    if kind == "end of road":
        return f"At the end of the road turn {side}{onto}" if side else f"At the end of the road continue{onto}"
    if kind == "merge":
        return f"Merge{(' ' + side) if side else ''}{onto}"
    if kind in ("on ramp", "off ramp"):
        what = "slip road" if kind == "on ramp" else "exit"
        return f"Take the {what}{(' on the ' + side) if side else ''}{onto}"
    if mod == "uturn":
        return f"Make a U-turn{onto}"
    if mod == "straight" or not mod:
        return f"Continue straight{onto}" if mod else f"Continue{onto}"
    if kind == "continue":
        return f"Continue {side}{onto}"
    if mod.startswith("slight"):
        return f"Bear {side}{onto}"
    return f"Turn {mod}{onto}"


def cmd_route(args: argparse.Namespace) -> int:
    mode = args.mode
    profile, travelmode, engine = MODES[mode]
    client = Client(args.contact, args.wait, args.timeout)
    lookup = Lookup(client, args)
    texts = [args.start, *(args.via or []), args.end]
    points: list[dict[str, Any]] = []
    out: dict[str, Any] = {"command": "route", "mode": mode}
    for text in texts:
        p = resolve(lookup, text)
        if p is None:
            out.update({"found": False, "not_found": text, "attribution": ATTRIBUTION})
            emit(out)
            return 1
        points.append(p)
    base = service_url(args.router_url.replace("{mode}", profile), "--router-url")
    host = (urllib.parse.urlsplit(base).hostname or "").lower()
    coords = ";".join(f"{coord(p['lon'])},{coord(p['lat'])}" for p in points)  # OSRM wants longitude first
    url = f"{base}/route/v1/driving/{coords}?overview=false&steps={'true' if args.steps else 'false'}"
    status, ctype, body = client.call("the router", url)
    if status not in (200, 400):  # OSRM answers its own errors with 400 and a JSON code
        raise refused("the router", host, status, ctype, body)
    data = parse_json("the router", host, status, ctype, body)
    if not isinstance(data, dict) or "code" not in data:
        raise Fail(f"the router at {host} didn't answer like an OSRM server; is that the right address?")
    out.update({"server": base, "from": points[0], "to": points[-1]})
    if len(points) > 2:
        out["via"] = points[1:-1]
    code = str(data["code"])
    if code in ("NoRoute", "NoSegment"):
        why = ("no road or path near one of the points" if code == "NoSegment"
               else f"no {mode} route connects these points (an island, a closed area, or a gap in the map)")
        out.update({"found": False, "reason": f"{code}: {why}", "attribution": ATTRIBUTION})
        emit(out)
        return 1
    if code != "Ok" or not data.get("routes"):
        raise Fail(f"the router at {host} said {code}: {data.get('message') or 'no route in the answer'}")
    route = data["routes"][0]
    snapped = data.get("waypoints") or []
    for p, w in zip(points, snapped):
        if isinstance(w, dict):
            p["nearest_road"] = w.get("name") or None
            if isinstance(w.get("distance"), (int, float)):
                p["snapped_m"] = round(float(w["distance"]))
    dist, dur = float(route.get("distance", 0)), float(route.get("duration", 0))
    out.update({
        "found": True,
        "distance_m": round(dist),
        "duration_s": round(dur),
        "distance": nice_distance(dist),
        "duration": nice_duration(dur),
        "straight_line_m": round(sum(distance_m(a["lat"], a["lon"], b["lat"], b["lon"]) for a, b in zip(points, points[1:]))),
    })
    legs = route.get("legs") or []
    if len(legs) > 1:
        out["legs"] = [{"distance_m": round(float(leg.get("distance", 0))), "duration_s": round(float(leg.get("duration", 0)))}
                       for leg in legs]
    if args.steps:
        steps = []
        for i, leg in enumerate(legs):
            for step in leg.get("steps") or []:
                m = step.get("maneuver") or {}
                steps.append({
                    "instruction": instruction(step, i, len(legs) - 1),
                    "distance_m": round(float(step.get("distance", 0))),
                    "duration_s": round(float(step.get("duration", 0))),
                    "maneuver": " ".join(x for x in (m.get("type"), m.get("modifier")) if x),
                })
        out["steps"] = steps
    route_param = urllib.parse.quote(";".join(f"{coord(p['lat'])},{coord(p['lon'])}" for p in points), safe="")
    google = {"api": "1", "origin": f"{coord(points[0]['lat'])},{coord(points[0]['lon'])}",
              "destination": f"{coord(points[-1]['lat'])},{coord(points[-1]['lon'])}", "travelmode": travelmode}
    if len(points) > 2:
        google["waypoints"] = "|".join(f"{coord(p['lat'])},{coord(p['lon'])}" for p in points[1:-1])
    out["links"] = {
        "openstreetmap": f"https://www.openstreetmap.org/directions?engine={engine}&route={route_param}",
        "google_maps": "https://www.google.com/maps/dir/?" + urllib.parse.urlencode(google),
    }
    out["note"] = "Times come from the router's profile, with no live traffic, timetables or waits."
    out["attribution"] = ATTRIBUTION
    if host in ("routing.openstreetmap.de", "router.project-osrm.org"):
        out["routing_by"] = f"FOSSGIS's OSRM servers ({host}). Map wrong? {FIX_THE_MAP}"
    emit(out)
    return 0


def tz_data_source(zone: str) -> str:
    for root in zoneinfo.TZPATH:
        if os.path.isfile(os.path.join(root, *zone.split("/"))):
            return "this computer's time zone database"
    try:
        return f"tzdata {importlib.metadata.version('tzdata')}"
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


def offset_text(delta: timedelta | None) -> str:
    total = int((delta or timedelta(0)).total_seconds())
    sign = "+" if total >= 0 else "-"
    h, rest = divmod(abs(total), 3600)
    m, s = divmod(rest, 60)
    return f"{sign}{h:02d}:{m:02d}" + (f":{s:02d}" if s else "")


def parse_when(text: str) -> datetime:
    t = text.strip()
    if t[-1:] in ("Z", "z"):
        t = t[:-1] + "+00:00"  # Python 3.10 doesn't read the Z itself
    try:
        return datetime.fromisoformat(t)
    except ValueError:
        raise Fail(f"--when {text!r} isn't a date and time such as 2026-03-29T09:00 or 2026-03-29T09:00+01:00") from None


def cmd_timezone(args: argparse.Namespace) -> int:
    where_text = " ".join(args.where).strip()
    if bool(where_text) == bool(args.zone):
        raise Fail("give a point or place, or --zone NAME (such as --zone Europe/Paris), not both")
    out: dict[str, Any] = {"command": "timezone"}
    zone_name = args.zone.strip() if args.zone else ""
    if where_text:
        point = parse_point(where_text)
        if point is None:
            lookup = Lookup(Client(args.contact, args.wait, args.timeout), args)
            found = resolve(lookup, where_text)
            if found is None:
                out.update({"found": False, "not_found": where_text, "attribution": ATTRIBUTION})
                emit(out)
                return 1
            out["place"] = found
            point = (found["lat"], found["lon"])
        else:
            out["point"] = {"lat": point[0], "lon": point[1]}
        try:
            from timezonefinder import TimezoneFinder
        except ImportError:
            raise Fail("the time zone of a point needs the Python package timezonefinder: python -m pip install "
                       "timezonefinder (or name the zone with --zone, such as --zone Asia/Tokyo)") from None
        zone_name = TimezoneFinder().timezone_at(lng=point[1], lat=point[0]) or ""
        if not zone_name:
            raise Fail(f"timezonefinder has no time zone for {coord(point[0])},{coord(point[1])}")
        out["zone_from"] = f"timezonefinder {importlib.metadata.version('timezonefinder')} (on this computer)"
        out["attribution"] = ATTRIBUTION + " (time zone boundaries: timezone-boundary-builder)"
    if not zoneinfo.available_timezones():
        raise Fail("this computer has no time zone database: python -m pip install tzdata")
    try:
        zone = zoneinfo.ZoneInfo(zone_name)
    except (zoneinfo.ZoneInfoNotFoundError, ValueError):
        close = difflib.get_close_matches(zone_name, sorted(zoneinfo.available_timezones()), n=3)
        hint = f" (did you mean {', '.join(close)}?)" if close else ""
        raise Fail(f"no time zone called {zone_name!r}{hint}; names look like Europe/Paris or America/New_York") from None

    if args.when:
        when = parse_when(args.when)
        if when.tzinfo is None:
            # a wall-clock time at the place
            local = when.replace(tzinfo=zone)
            utc = local.astimezone(timezone.utc)
            real = utc.astimezone(zone)
            if real.replace(tzinfo=None) != when:
                out["warning"] = (f"{when.isoformat()} doesn't happen in {zone_name}: the clocks skip that hour when "
                                  f"they go forward. Counted with the offset before the change, it is "
                                  f"{real.isoformat(timespec='minutes')} there")
                local = real
            elif local.replace(fold=1).utcoffset() != local.utcoffset():
                other = local.replace(fold=1).astimezone(timezone.utc)
                out["warning"] = (f"{when.isoformat()} happens twice in {zone_name} when the clocks go back: first at "
                                  f"{utc.strftime('%Y-%m-%dT%H:%M:%SZ')}, then at {other.strftime('%Y-%m-%dT%H:%M:%SZ')}")
        else:
            local = when.astimezone(zone)
    else:
        local = datetime.now(timezone.utc).astimezone(zone)
    if zone_name.startswith("Etc/"):
        out["at_sea"] = True
        out["note"] = "No country's time zone here: this is the nautical zone. Etc/GMT+N means N hours behind UTC."
    utc_time = local.astimezone(timezone.utc)
    out.update({
        "zone": zone_name,
        "local_time": local.isoformat(timespec="seconds"),
        "utc_time": utc_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "utc_offset": offset_text(local.utcoffset()),
        "abbreviation": local.tzname(),
        "daylight_saving": bool(local.dst()),
        "tz_data": tz_data_source(zone_name),
    })
    if not args.when:
        out["note_time"] = "the time when this ran"
    emit(out)
    return 0


def cmd_categories(args: argparse.Namespace) -> int:
    emit({
        "command": "categories",
        "categories": {
            name: {"group": group, "any_of": [" + ".join(f"{k}={v}" for k, v in alt) for alt in alts]}
            for name, (group, alts) in CATEGORIES.items()
        },
        "aliases": ALIASES,
    })
    return 0


# ---------------------------------------------------------------- command line


def number(lo: float, hi: float, integer: bool = False) -> Callable[[str], float]:
    def parse(text: str) -> float:
        try:
            value: float = int(text) if integer else float(text)
        except ValueError:
            raise argparse.ArgumentTypeError(f"{text.strip()!r} isn't {'a whole number' if integer else 'a number'}") from None
        if not math.isfinite(value) or not lo <= value <= hi:
            raise argparse.ArgumentTypeError(f"{text.strip()} is out of range: give {lo:g} to {hi:g}")
        return value

    return parse


def contact(text: str) -> str:
    text = text.strip()
    if not text or len(text) > 200 or not all(32 <= ord(c) < 127 for c in text) or any(c in text for c in "()"):
        raise argparse.ArgumentTypeError("give an email or web address in plain letters, without brackets")
    return text


def mode(text: str) -> str:
    key = text.strip().lower()
    if key not in MODE_NAMES:
        raise argparse.ArgumentTypeError(f"{text!r} isn't a mode: car, foot or bike")
    return MODE_NAMES[key]


def protect_negatives(argv: list[str]) -> list[str]:
    """argparse takes "-33.86,151.21" for an option. A leading space makes it a value; the parsers strip it."""
    return [" " + a if re.match(r"-\.?\d", a) else a for a in argv]


def exits(one: str) -> str:
    return f"Exit codes: 0 done; 1 {one}, which the JSON says; 2 it couldn't do the job (one line on stderr says why)."


def build_parser() -> Parser:
    common = Parser(add_help=False)
    net = common.add_argument_group("asking the services")
    net.add_argument("--contact", type=contact, help="an email or web address the user agreed to send in the "
                     "User-Agent, so the services can reach them; ask once, never make one up")
    net.add_argument("--lang", help="languages for names and addresses, such as en or fr,en (default: the "
                     "service's; nearby uses name:<first> when a place has it)")
    net.add_argument("--country", help="look place names up only in these countries: ISO codes such as gb or de,at")
    net.add_argument("--wait", type=number(0, 600), help="seconds between two requests to the same service "
                     "(default: 1 for Nominatim and the routers, as their rules ask; it can't go lower). Use 15 for a "
                     "scheduled job: Nominatim allows those 4 requests a minute")
    net.add_argument("--timeout", type=number(1, 300), default=60, help="seconds to wait for each answer (default 60)")
    net.add_argument("--nominatim-url", default=NOMINATIM, help=f"another Nominatim, such as your own (default {NOMINATIM})")
    net.add_argument("--overpass-url", default=OVERPASS, help=f"another Overpass server (default {OVERPASS})")
    net.add_argument("--router-url", default=ROUTER, help="another OSRM server; {mode} in it becomes car, foot or "
                     f"bike (default {ROUTER})")

    parser = Parser(prog="maps_tool.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True, metavar="command")

    p = sub.add_parser("geocode", parents=[common], help="places and addresses to coordinates (Nominatim)",
                       description="Look up places and addresses. Several at once are sent one a second, each once.",
                       epilog=exits("a place wasn't found (not_found) or the run stopped before the end (not_sent)"))
    p.add_argument("query", nargs="*", help='a place or address, such as "10 Downing Street, London"')
    p.add_argument("--file", help="a text file with one place per line (lines starting with # are skipped)")
    p.add_argument("--limit", type=number(1, 40, integer=True), default=3, help="results per place, 1 to 40 (default 3)")
    p.add_argument("--max-time", type=number(1, 3600), default=240, help="stop sending after this many seconds and "
                   "list the rest in not_sent (default 240, inside the dashboard's 300-second shell limit)")
    p.add_argument("--out", help="write the full JSON to this file and print only a summary")
    p.set_defaults(func=cmd_geocode)

    p = sub.add_parser("reverse", parents=[common], help="coordinates to the nearest address (Nominatim)",
                       description="The address at a point.", epilog=exits("there's no address at that point"))
    p.add_argument("point", nargs="+", help="LAT,LON, such as 48.8584,2.2945")
    p.add_argument("--zoom", type=number(0, 18, integer=True), default=18, help="detail: 18 a building (default), "
                   "16 a major street, 14 a neighbourhood, 10 a city, 5 a state, 3 a country")
    p.set_defaults(func=cmd_reverse)

    p = sub.add_parser("nearby", parents=[common], help="places of a kind around a point (Overpass)",
                       description="Places of a kind within a radius, nearest first, by straight-line distance.",
                       epilog=exits("the place wasn't found, or nothing matched in the radius"))
    p.add_argument("where", nargs="+", help="LAT,LON or a place name")
    p.add_argument("--category", action="append", help="a category, such as pharmacy or cafe (repeat for more; "
                   "the categories command lists them)")
    p.add_argument("--tag", action="append", help="an OpenStreetMap tag, such as shop=bicycle or amenity=* (repeat for more)")
    p.add_argument("--with", dest="with_", action="append", metavar="KEY=VALUE",
                   help="keep only places with this tag too, such as cuisine=italian or wheelchair=yes; KEY alone "
                   "means any value (repeat for more)")
    p.add_argument("--name", help="keep only places whose name contains this, any case")
    p.add_argument("--radius", type=number(1, MAX_RADIUS), default=1000, help=f"metres, 1 to {MAX_RADIUS} (default 1000)")
    p.add_argument("--limit", type=number(1, 200, integer=True), default=10, help="places to list, 1 to 200 (default 10)")
    p.set_defaults(func=cmd_nearby)

    p = sub.add_parser("route", parents=[common], help="distance, time and turns between places (OSRM)",
                       description="A route by car, on foot or by bike, with its distance and time.",
                       epilog=exits("a place wasn't found, or no route connects the points"))
    p.add_argument("start", help="LAT,LON or a place name")
    p.add_argument("end", help="LAT,LON or a place name")
    p.add_argument("--via", action="append", help="a stop on the way (repeat for more, in order)")
    p.add_argument("--mode", type=mode, default="car", help="car (default), foot or bike (drive, walk, walking, "
                   "cycle and cycling work too)")
    p.add_argument("--steps", action="store_true", help="add turn-by-turn instructions")
    p.set_defaults(func=cmd_route)

    p = sub.add_parser("timezone", parents=[common], help="time zone, offset and local time (offline)",
                       description="The time zone at a point or place, its UTC offset and the local time.",
                       epilog=exits("the place wasn't found"))
    p.add_argument("where", nargs="*", help="LAT,LON or a place name (needs timezonefinder)")
    p.add_argument("--zone", help="a zone name instead, such as America/New_York (needs no extra package)")
    p.add_argument("--when", help="a moment other than now: 2026-03-29T09:00 is local time there, "
                   "2026-03-29T09:00Z or +01:00 a fixed moment")
    p.set_defaults(func=cmd_timezone)

    p = sub.add_parser("categories", help="the categories nearby knows and their OpenStreetMap tags")
    p.set_defaults(func=cmd_categories)
    return parser


def main() -> int:
    utf8_output()
    args = build_parser().parse_args(protect_negatives(sys.argv[1:]))
    for name in ("lang", "country", "zone", "name", "file", "out"):
        if isinstance(getattr(args, name, None), str):
            setattr(args, name, getattr(args, name).strip() or None)
    return run_job("maps_tool.py", lambda: args.func(args))


if __name__ == "__main__":
    sys.exit(main())
