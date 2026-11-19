"""maps_tool.py against a stand-in for Nominatim, Overpass and OSRM (conftest.py) built from their real answers."""

from __future__ import annotations

import importlib.util
import json
import re
import sys
import time
import zoneinfo
from pathlib import Path

import pytest

SKILL = "maps"
SCRIPT = "maps_tool.py"
SKILL_DIR = Path(__file__).resolve().parents[3] / "skills" / "athena" / SKILL
EIFFEL, LOUVRE = "48.8584,2.2945", "48.8606,2.3376"
ATTRIBUTION = "Data © OpenStreetMap contributors, ODbL 1.0. https://www.openstreetmap.org/copyright"

needs_tz_data = pytest.mark.skipif(not zoneinfo.available_timezones(), reason="no time zone database here: pip install tzdata")
needs_finder = pytest.mark.skipif(importlib.util.find_spec("timezonefinder") is None, reason="timezonefinder isn't installed")


def services(maps) -> list[str]:
    return ["--nominatim-url", maps.url, "--overpass-url", f"{maps.url}/api/interpreter",
            "--router-url", maps.url + "/routed-{mode}"]


def maps_tool(run, maps, *args: object, ok: bool = True):
    return run(SKILL, SCRIPT, *args, *services(maps), ok=ok)


def one_line(err: str) -> bool:
    return len(err.strip().splitlines()) == 1 and "Traceback" not in err


def load(monkeypatch):
    """The script as a module, without writing a __pycache__ into the skill folder."""
    monkeypatch.setattr(sys, "dont_write_bytecode", True)
    spec = importlib.util.spec_from_file_location("maps_tool_under_test", SKILL_DIR / "scripts" / SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------- geocode and reverse


def test_geocode_reads_nominatim_and_names_itself_honestly(run, maps):
    out = maps_tool(run, maps, "geocode", "Eiffel Tower", "--contact", "someone@example.org").json()
    [entry] = out["places"]
    best = entry["results"][0]
    assert entry["found"] is True and len(entry["results"]) == 2  # the tower in Paris, then a peak in Canada
    assert (best["lat"], best["lon"]) == (48.8582599, 2.2945006)
    assert best["kind"] == "man_made=tower" and best["name"] == "Tour Eiffel"
    assert best["osm"] == "https://www.openstreetmap.org/way/5013364"
    assert best["bounding_box"]["south"] < best["lat"] < best["bounding_box"]["north"]
    assert best["links"]["google_maps"] == "https://www.google.com/maps/search/?api=1&query=48.85826,2.294501"
    assert entry["results"][1]["address"]["country"] == "Canada"
    assert out["attribution"] == ATTRIBUTION
    [req] = maps.of("/search")
    assert req.user_agent == "AthenaAgents/1.0 (maps_tool; someone@example.org)"
    assert req.query == {"q": "Eiffel Tower", "limit": "3", "addressdetails": "1", "format": "jsonv2"}


def test_without_a_contact_the_user_agent_still_names_the_program(run, maps):
    maps_tool(run, maps, "geocode", "Eiffel Tower", "--country", "fr", "--lang", "en")
    [req] = maps.of("/search")
    assert req.user_agent == "AthenaAgents/1.0 (maps_tool)"
    assert req.query["countrycodes"] == "fr" and req.query["accept-language"] == "en"


def test_a_list_from_a_utf16_file_is_sent_once_each_and_spaced(run, maps, tmp_path):
    places = tmp_path / "places.txt"
    # Windows PowerShell 5.1's > writes UTF-16 with a byte-order mark
    places.write_bytes("# hotels to check\nEiffel Tower\n東京駅\neiffel  TOWER\nNowhere at all\n".encode("utf-16"))
    r = maps_tool(run, maps, "geocode", "--file", places, "--limit", "1", "--wait", "0.3", ok=False)
    out = r.json()
    assert r.code == 1 and out["not_found"] == ["Nowhere at all"] and out["duplicates_skipped"] == 1
    assert [p["query"] for p in out["places"]] == ["Eiffel Tower", "東京駅", "Nowhere at all"]
    tokyo = out["places"][1]["results"][0]
    assert tokyo["name"] == "東京駅(改札外);地下2階" and tokyo["address"]["country"] == "日本"  # through the cp1252 pipe
    times = [req.at for req in maps.of("/search")]
    assert len(times) == 3
    assert all(b - a >= 0.29 for a, b in zip(times, times[1:]))


def test_a_long_list_stops_in_time_and_says_what_is_left(run, maps, tmp_path, monkeypatch):
    module = load(monkeypatch)
    assert module.MIN_WAIT["nominatim.openstreetmap.org"] == 1.0
    places = tmp_path / "places.txt"
    places.write_text("Eiffel Tower\n東京駅\nNowhere at all\n", encoding="utf-8")
    r = maps_tool(run, maps, "geocode", "--file", places, "--wait", "1", "--max-time", "1.5", ok=False)
    out = r.json()
    assert r.code == 1
    assert [p["query"] for p in out["places"]] == ["Eiffel Tower", "東京駅"]
    assert out["not_sent"] == ["Nowhere at all"] and len(maps.of("/search")) == 2


def test_out_writes_the_full_result_and_prints_a_summary(run, maps, tmp_path):
    work = tmp_path / "maps-work"
    work.mkdir()
    r = maps_tool(run, maps, "geocode", "Eiffel Tower", "東京駅", "--out", work / "found.json")
    summary = r.json()
    assert summary["places"] == 2 and summary["written"].endswith("found.json")
    full = json.loads((work / "found.json").read_text(encoding="utf-8"))
    assert full["places"][1]["results"][0]["address"]["city"] == "千代田区"
    assert sorted(p.name for p in work.iterdir()) == ["found.json"]  # no temporary file left behind

    r = maps_tool(run, maps, "geocode", "Eiffel Tower", "--out", work, ok=False)
    assert r.code == 2 and "is a folder" in r.err and one_line(r.err)


def test_a_failure_part_way_prints_what_went_through(run, maps):
    maps.replies["/search#2"] = (429, "text/html", b"<html><body><h1>Too Many Requests</h1></body></html>")
    r = maps_tool(run, maps, "geocode", "Eiffel Tower", "東京駅", "Nowhere at all", ok=False)
    out = r.json()
    assert r.code == 2 and one_line(r.err) and "429" in r.err and "wait" in r.err
    assert [p["query"] for p in out["places"]] == ["Eiffel Tower"]
    assert out["not_sent"] == ["東京駅", "Nowhere at all"]
    assert len(maps.of("/search")) == 2  # the refused one isn't tried again


def test_a_blocked_client_is_told_not_to_retry(run, maps):
    maps.replies["/search"] = (403, "text/html", b"<html><title>Access blocked</title><body>Access blocked</body></html>")
    r = maps_tool(run, maps, "geocode", "Eiffel Tower", ok=False)
    assert r.code == 2 and one_line(r.err) and "Don't retry" in r.err and r.out == ""


def test_reverse_finds_the_address_and_says_how_far_it_is(run, maps):
    out = maps_tool(run, maps, "reverse", EIFFEL).json()
    assert out["found"] is True and out["place"]["address"]["road"] == "Avenue Gustave Eiffel"
    assert out["place_is_m_away"] < 10
    assert maps.of("/reverse")[0].query["zoom"] == "18"
    # two numbers as two words work too
    assert maps_tool(run, maps, "reverse", "48.8584", "2.2945", "--zoom", "10").json()["found"] is True


def test_reverse_at_sea_finds_nothing(run, maps):
    r = maps_tool(run, maps, "reverse", "0,-30", ok=False)
    assert r.code == 1 and r.json()["found"] is False


# ---------------------------------------------------------------- nearby


def test_nearby_asks_for_every_tag_of_a_category_and_sorts_by_distance(run, maps):
    out = maps_tool(run, maps, "nearby", "35.6812,139.7671", "--category", "pharmacy").json()
    [query] = maps.overpass_queries
    assert '  nwr["amenity"="pharmacy"](around:1000,35.6812,139.7671);' in query
    assert '  nwr["healthcare"="pharmacy"](around:1000,35.6812,139.7671);' in query
    assert query.startswith("[out:json][timeout:25];") and query.endswith("out center tags 1000;")
    distances = [p["straight_line_m"] for p in out["places"]]
    assert distances == sorted(distances) and len(distances) == 5
    first = out["places"][0]
    assert first["name"] == "トモズ" and first["is"] == "amenity=pharmacy"
    assert first["opening_hours"] == "Mo-Sa 10:30-21:00; Su,PH 10:00-20:00"
    assert first["osm"] == "https://www.openstreetmap.org/node/2065895673"
    assert out["complete"] is True and out["attribution"] == ATTRIBUTION
    assert out["map_data_as_of"] == "2026-11-04T06:02:51Z"
    assert next(p for p in out["places"] if p["name"] == "クオール薬局")["checked_on"] == "2025-10-30"


def test_lang_picks_the_name_in_that_language(run, maps):
    out = maps_tool(run, maps, "nearby", "35.6812,139.7671", "--category", "pharmacy", "--lang", "en").json()
    first = out["places"][0]
    assert first["name"] == "Tomod's" and first["local_name"] == "トモズ"


@pytest.mark.parametrize(("category", "lines"), [
    ("doctor", ['nwr["amenity"="doctors"]']),
    ("bakery", ['nwr["shop"="bakery"]', 'nwr["amenity"="bakery"]']),
    ("church", ['nwr["amenity"="place_of_worship"]["religion"="christian"]']),
    ("Mosque", ['nwr["amenity"="place_of_worship"]["religion"="muslim"]']),
    ("gas station", ['nwr["amenity"="fuel"]']),
])
def test_categories_with_odd_tags(run, maps, category, lines):
    maps_tool(run, maps, "nearby", EIFFEL, "--category", category, "--radius", "500", ok=False)
    [query] = maps.overpass_queries
    for line in lines:
        assert f"  {line}(around:500,48.8584,2.2945);" in query
    assert query.count("nwr[") == len(lines)


def test_filters_and_names_are_escaped_for_overpass(run, maps):
    maps_tool(run, maps, "nearby", EIFFEL, "--category", "restaurant", "--tag", "shop=*", "--with", "cuisine=italian",
              "--with", "wheelchair", "--name", 'Caf. "Le" (Bon)', ok=False)
    [query] = maps.overpass_queries
    filters = r'["cuisine"~"(^|;) *italian *(;|$)",i]["wheelchair"]["name"~"Caf\\. \"Le\" \\(Bon\\)",i]'
    assert f'  nwr["amenity"="restaurant"]{filters}(around:1000,48.8584,2.2945);' in query
    assert f'  nwr["shop"]{filters}(around:1000,48.8584,2.2945);' in query


def test_nearby_a_place_name_looks_it_up_first_and_uses_way_centres(run, maps):
    maps.overpass = json.loads((Path(__file__).parent / "responses" / "overpass_churches_paris.json").read_text(encoding="utf-8"))
    out = maps_tool(run, maps, "nearby", "Eiffel", "Tower", "--category", "church", "--limit", "3").json()
    assert [r.path for r in maps.requests] == ["/search", "/api/interpreter"]
    assert "(around:1000,48.85826,2.294501);" in maps.overpass_queries[0]
    assert out["center"]["found"].startswith("Tour Eiffel") and out["found_in_radius"] == 6
    assert len(out["places"]) == 3
    leon = next(p for p in out["places"] if p["name"] == "Église Saint-Léon")
    assert (leon["lat"], leon["lon"]) == (48.8509237, 2.2966106)  # a way: its centre
    assert leon["is"] == "amenity=place_of_worship + religion=christian"


def test_negative_coordinates_are_points_not_options(run, maps):
    maps_tool(run, maps, "nearby", "-33.8688,151.2093", "--category", "cafe", ok=False)
    assert "(around:1000,-33.8688,151.2093);" in maps.overpass_queries[0]
    maps_tool(run, maps, "reverse", "-22.9519", "-43.2105", ok=False)
    assert maps.of("/reverse")[0].query["lat"] == "-22.9519"


def test_nothing_nearby_is_exit_1(run, maps):
    maps.overpass = {"version": 0.6, "generator": "Overpass API 0.7.62.11 87bfad18", "elements": []}
    r = maps_tool(run, maps, "nearby", EIFFEL, "--category", "zoo", ok=False)
    assert r.code == 1 and r.json()["places"] == []


@pytest.mark.parametrize(("status", "ctype", "body", "words"), [
    (429, "text/html", b"<html><body><p>Too Many Requests</p></body></html>", "30 seconds"),
    (504, "text/html", b"<html><body><h1>504 Gateway Timeout</h1></body></html>", "smaller --radius"),
    (400, "text/html; charset=utf-8",
     b'<html><body><p><strong style="color:#FF0000">Error</strong>: line 3: parse error: Key expected - \'%\' found. </p></body></html>',
     "Error: line 3: parse error"),
    (200, "application/json", json.dumps({"version": 0.6, "elements": [], "remark": 'runtime error: Query timed out in "query" at line 3 after 26 seconds.'}).encode(),
     "Try a smaller --radius"),
])
def test_overpass_trouble_is_one_line(run, maps, status, ctype, body, words):
    maps.replies["/api/interpreter"] = (status, ctype, body)
    r = maps_tool(run, maps, "nearby", EIFFEL, "--category", "cafe", ok=False)
    assert r.code == 2 and one_line(r.err) and words in r.err and "<" not in r.err


def test_an_unknown_category_suggests_one(run, maps):
    r = maps_tool(run, maps, "nearby", EIFFEL, "--category", "pharmacie", ok=False)
    assert r.code == 2 and one_line(r.err) and "did you mean pharmacy" in r.err
    assert maps.requests == []


# ---------------------------------------------------------------- route


@pytest.mark.parametrize(("mode", "profile", "metres", "seconds", "engine", "travelmode"), [
    ("car", "car", 4304, 634, "fossgis_osrm_car", "driving"),
    ("walking", "foot", 3748, 3002, "fossgis_osrm_foot", "walking"),
    ("foot", "foot", 3748, 3002, "fossgis_osrm_foot", "walking"),
    ("bike", "bike", 3963, 1214, "fossgis_osrm_bicycle", "bicycling"),
])
def test_each_mode_asks_its_own_router(run, maps, mode, profile, metres, seconds, engine, travelmode):
    out = maps_tool(run, maps, "route", EIFFEL, LOUVRE, "--mode", mode).json()
    [req] = maps.requests
    assert req.path == f"/routed-{profile}/route/v1/driving/2.2945,48.8584;2.3376,48.8606"  # longitude first
    assert req.query == {"overview": "false", "steps": "false"}
    assert (out["distance_m"], out["duration_s"]) == (metres, seconds)
    assert out["server"] == f"{maps.url}/routed-{profile}" and out["mode"] == profile
    assert f"engine={engine}&route=48.8584%2C2.2945%3B48.8606%2C2.3376" in out["links"]["openstreetmap"]
    assert out["links"]["google_maps"].endswith(f"travelmode={travelmode}")
    assert out["straight_line_m"] < metres and out["attribution"] == ATTRIBUTION


def test_walking_is_not_the_car_route(run, maps):
    walk = maps_tool(run, maps, "route", EIFFEL, LOUVRE, "--mode", "foot").json()
    drive = maps_tool(run, maps, "route", EIFFEL, LOUVRE, "--mode", "car").json()
    assert walk["duration_s"] > 4 * drive["duration_s"]
    assert walk["duration"] == "50 min" and walk["distance"] == "3.7 km (2.3 mi)"


def test_steps_are_written_out(run, maps):
    out = maps_tool(run, maps, "route", EIFFEL, LOUVRE, "--mode", "foot", "--steps").json()
    steps = out["steps"]
    assert maps.requests[0].query["steps"] == "true"
    assert steps[0]["instruction"] == "Start on Avenue Gustave Eiffel, heading northeast"
    assert steps[-1]["instruction"] == "Arrive at the destination"
    assert any(s["instruction"].startswith("Turn left onto ") for s in steps)
    assert any(s["instruction"].startswith("Bear right") for s in steps)
    assert all(s["instruction"] and "None" not in s["instruction"] for s in steps)
    assert abs(sum(s["distance_m"] for s in steps) - out["distance_m"]) < len(steps)


def test_place_names_and_stops(run, maps):
    out = maps_tool(run, maps, "route", "Eiffel Tower", LOUVRE, "--via", "48.8566,2.3125", "--via", "-0.5,1").json()
    assert [r.path.split("/")[1] for r in maps.requests] == ["search", "routed-car"]
    assert maps.requests[1].path.endswith("/2.294501,48.85826;2.3125,48.8566;1,-0.5;2.3376,48.8606")
    assert out["from"]["found"].startswith("Tour Eiffel") and len(out["via"]) == 2
    assert "waypoints=48.8566%2C2.3125%7C-0.5%2C1" in out["links"]["google_maps"]
    assert out["from"]["nearest_road"] == "Quai Jacques Chirac" and out["from"]["snapped_m"] == 103


def test_a_place_that_isnt_found_is_exit_1_before_routing(run, maps):
    r = maps_tool(run, maps, "route", "Nowhere at all", LOUVRE, ok=False)
    assert r.code == 1 and r.json()["not_found"] == "Nowhere at all"
    assert [req.path for req in maps.requests] == ["/search"]


def test_no_route_is_exit_1(run, maps):
    body = (Path(__file__).parent / "responses" / "osrm_noroute.json").read_bytes()
    maps.replies["/routed-car/"] = (400, "application/json; charset=UTF-8", body)
    r = maps_tool(run, maps, "route", "21.3069,-157.8583", "35.6812,139.7671", ok=False)
    out = r.json()
    assert r.code == 1 and out["found"] is False and out["reason"].startswith("NoRoute")


def test_your_own_osrm_server(run, maps):
    out = run(SKILL, SCRIPT, "route", EIFFEL, LOUVRE, "--router-url", maps.url).json()
    assert maps.requests[0].path.startswith("/route/v1/driving/") and out["distance_m"] == 4304
    assert "routing_by" not in out


def test_something_that_isnt_a_router(run, maps):
    maps.replies["/routed-car/"] = (200, "text/html", b"<!doctype html><title>My app</title><p>Welcome</p>")
    r = maps_tool(run, maps, "route", EIFFEL, LOUVRE, ok=False)
    assert r.code == 2 and one_line(r.err) and "didn't answer with JSON" in r.err


# ---------------------------------------------------------------- timezone


@needs_tz_data
@pytest.mark.parametrize(("zone", "when", "offset", "dst"), [
    ("Europe/Paris", "2026-01-15T12:00Z", "+01:00", False),
    ("Europe/Paris", "2026-07-15T12:00Z", "+02:00", True),
    ("Asia/Kolkata", "2026-07-15T12:00Z", "+05:30", False),
    ("Asia/Kathmandu", "2026-07-15T12:00Z", "+05:45", False),
    ("America/St_Johns", "2026-01-15T12:00Z", "-03:30", False),
    ("America/Los_Angeles", "2026-07-15T12:00Z", "-07:00", True),
])
def test_offsets_are_hours_and_minutes(run, zone, when, offset, dst):
    out = run(SKILL, SCRIPT, "timezone", "--zone", zone, "--when", when).json()
    assert out["utc_offset"] == offset and out["daylight_saving"] is dst
    assert out["local_time"].endswith(offset) and out["utc_time"] == when.replace("Z", ":00Z")


@needs_tz_data
def test_a_local_time_becomes_utc_and_clock_changes_are_flagged(run):
    out = run(SKILL, SCRIPT, "timezone", "--zone", "America/New_York", "--when", "2026-12-01T09:00").json()
    assert out["utc_time"] == "2026-12-01T14:00:00Z" and "warning" not in out
    skipped = run(SKILL, SCRIPT, "timezone", "--zone", "Europe/Paris", "--when", "2026-03-29T02:30").json()
    assert "doesn't happen" in skipped["warning"] and skipped["local_time"] == "2026-03-29T03:30:00+02:00"
    twice = run(SKILL, SCRIPT, "timezone", "--zone", "Europe/London", "--when", "2026-10-25T01:30").json()
    assert "happens twice" in twice["warning"] and "2026-10-25T00:30:00Z" in twice["warning"]


@needs_tz_data
def test_now_and_a_wrong_zone_name(run):
    out = run(SKILL, SCRIPT, "timezone", "--zone", "Asia/Tokyo").json()
    assert out["utc_offset"] == "+09:00" and out["abbreviation"] == "JST"
    r = run(SKILL, SCRIPT, "timezone", "--zone", "Europe/Pariss", ok=False)
    assert r.code == 2 and one_line(r.err) and "Europe/Paris" in r.err


@needs_tz_data
@needs_finder
@pytest.mark.parametrize(("point", "zone"), [
    ("48.8584,2.2945", "Europe/Paris"),
    ("-33.8688,151.2093", "Australia/Sydney"),
    ("33.4484,-112.0740", "America/Phoenix"),
    ("-12.0464,-77.0428", "America/Lima"),
])
def test_the_zone_of_a_point(run, point, zone):
    out = run(SKILL, SCRIPT, "timezone", point, "--when", "2026-07-15T12:00Z").json()
    assert out["zone"] == zone and out["zone_from"].startswith("timezonefinder ")
    assert out["attribution"].startswith(ATTRIBUTION)


@needs_tz_data
@needs_finder
def test_at_sea_and_by_place_name(run, maps):
    sea = run(SKILL, SCRIPT, "timezone", "0,-30", "--when", "2026-07-15T12:00Z").json()
    assert sea["at_sea"] is True and sea["zone"] == "Etc/GMT+2" and sea["utc_offset"] == "-02:00"
    out = maps_tool(run, maps, "timezone", "Eiffel Tower", "--when", "2026-01-15T12:00Z").json()
    assert out["zone"] == "Europe/Paris" and out["place"]["found"].startswith("Tour Eiffel")


# ---------------------------------------------------------------- the rules and the command line


def test_public_services_are_spaced_from_the_start_of_the_run(monkeypatch, maps):
    module = load(monkeypatch)
    client = module.Client(None, None, 10)
    assert client.gap("nominatim.openstreetmap.org") == 1.0 and client.gap("routing.openstreetmap.de") == 1.0
    assert client.gap("127.0.0.1") == 0.0
    assert module.Client(None, 0.2, 10).gap("routing.openstreetmap.de") == 1.0  # can't go below the rule
    assert module.Client(None, 15, 10).gap("nominatim.openstreetmap.org") == 15  # a scheduled job
    monkeypatch.setitem(module.MIN_WAIT, "127.0.0.1", 0.4)
    module.START = time.monotonic()
    client.call("Nominatim", f"{maps.url}/search?q=x&format=jsonv2")
    client.call("Nominatim", f"{maps.url}/search?q=y&format=jsonv2")
    first, second = (r.at for r in maps.requests)
    assert first - module.START >= 0.39 and second - first >= 0.39


@pytest.mark.parametrize("args", [
    ("reverse", "120,45"),
    ("reverse", "91,10"),
    ("reverse", "Paris"),
    ("geocode", "Paris", "--limit", "0"),
    ("geocode", "Paris", "--limit", "41"),
    ("geocode", "Paris", "--wait", "-1"),
    ("geocode", "Paris", "--timeout", "nan"),
    ("geocode", "Paris", "--contact", "Me (me@example.org)"),
    ("geocode", "Paris", "--nominatim-url", "ftp://example.org"),
    ("geocode",),
    ("nearby", "48.8584,2.2945"),
    ("nearby", "48.8584,2.2945", "--category", "cafe", "--radius", "0"),
    ("nearby", "48.8584,2.2945", "--category", "cafe", "--radius", "60000"),
    ("nearby", "48.8584,2.2945", "--tag", "=cafe"),
    ("route", "48.8584,2.2945", "48.8606,2.3376", "--mode", "plane"),
    ("timezone",),
    ("timezone", "48.8584,2.2945", "--zone", "Europe/Paris"),
    ("timezone", "--zone", "Europe/Paris", "--when", "next tuesday"),
    ("geocode", "--file", "missing.txt"),
    ("frobnicate",),
])
def test_bad_input_is_one_line_and_exit_2(run, args):
    r = run(SKILL, SCRIPT, *args, ok=False)
    assert r.code == 2 and one_line(r.err), r.err
    assert r.out == ""


def test_longitude_first_gets_a_hint(run):
    r = run(SKILL, SCRIPT, "reverse", "120,45", ok=False)
    assert "longitude first" in r.err


def test_unreachable_and_redirected_services(run, closed_url, redirector):
    r = run(SKILL, SCRIPT, "geocode", "Paris", "--nominatim-url", closed_url, ok=False)
    assert r.code == 2 and one_line(r.err) and "can't reach Nominatim" in r.err
    url, seen = redirector
    r = run(SKILL, SCRIPT, "geocode", "Paris", "--nominatim-url", url, ok=False)
    assert r.code == 2 and one_line(r.err) and "another address" in r.err and len(seen) == 1


def test_out_never_replaces_the_list_it_reads(run, maps, tmp_path):
    places = tmp_path / "places.txt"
    places.write_text("Eiffel Tower\n", encoding="utf-8")
    r = maps_tool(run, maps, "geocode", "--file", places, "--out", places, ok=False)
    assert r.code == 2 and "write over" in r.err and places.read_text(encoding="utf-8") == "Eiffel Tower\n"
    assert maps.requests == []


# ---------------------------------------------------------------- the skill's text matches the script


def test_the_reference_lists_the_same_categories(run):
    table = {}
    text = (SKILL_DIR / "references" / "categories.md").read_text(encoding="utf-8")
    # bun fmt pads the table's columns
    for name, tags in re.findall(r"^\| `([a-z_]+)` +\| (.+?) *\|$", text, re.M):
        table[name] = [" + ".join(re.findall(r"`([^`]+)`", alt)) for alt in tags.split(" or ")]
    script = run(SKILL, SCRIPT, "categories").json()["categories"]
    assert table == {name: c["any_of"] for name, c in script.items()}


def test_every_option_the_skill_names_is_in_help(run):
    text = (SKILL_DIR / "SKILL.md").read_text(encoding="utf-8")
    helps = {cmd: run(SKILL, SCRIPT, cmd, "--help").out for cmd in ("geocode", "reverse", "nearby", "route", "timezone", "categories")}
    for line in re.findall(r"`(?:maps_tool\.py )?(geocode|reverse|nearby|route|timezone|categories)( [^`]*)?`", text):
        cmd, rest = line
        for option in re.findall(r"--[a-z-]+", rest or ""):
            assert option in helps[cmd], f"{cmd} {option}"
    for option in set(re.findall(r"`(--[a-z-]+)", text)):
        assert any(option in h for h in helps.values()), option
