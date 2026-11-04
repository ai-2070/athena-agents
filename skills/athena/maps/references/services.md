The services behind the maps skill, their rules, and the addresses to call when there's no shell for the script.
Checked on 4 November 2026 against each service's own policy page and live answers; the rules can change without
notice, so a link to each is given.

## Who runs what, and their rules

**Nominatim** (nominatim.openstreetmap.org, run by the OpenStreetMap Foundation) turns names and addresses into
coordinates and back. Its usage policy, operations.osmfoundation.org/policies/nominatim:

- one request a second at most, from one machine and one thread; the limit covers all of an app's users together;
- a User-Agent or Referer that names the application (a library's default one is refused);
- results kept and reused: sending the same query again and again can get a client blocked;
- no autocomplete (lookups as someone types), no systematic queries (reverse lookups across a grid, lists of every
  town or postcode), no downloading of the details pages;
- bulk geocoding isn't encouraged; scripts that run longer than a day or on a schedule keep to 4 requests a minute;
- attribution shown to the user; the data is under the ODbL, which asks that a database built from it is shared alike;
- an AI that suggests the service points prominently to the policy and explains its limits; code an AI writes keeps
  to the policy; no-code, low-code and vibe-coding platforms must not build it in or offer it as a general geocoding
  or place-search service, and using it at all is the application developer's deliberate decision and
  responsibility.

**Overpass** (overpass-api.de, run by FOSSGIS) answers "which things with these tags are here". Its fair-use rules,
on the OpenStreetMap wiki's Overpass API page: under 10,000 queries and 1 GB a day doesn't disturb anyone, and
something that runs regularly should stay at a hundredth of that; after an HTTP 429 or 406, pause 30 seconds before
the next request; no parallel scripts; commercial use belongs on your own or a paid server; send a User-Agent that
names the app. The same page lists other public servers, among them `https://overpass.private.coffee/api/interpreter`
and `https://maps.mail.ru/osm/tools/overpass/api/interpreter` (`--overpass-url`), useful when the main one is
overloaded.

**The FOSSGIS routers** (routing.openstreetmap.de; their about page) run OSRM with car, bike and foot profiles for the
whole world, the same servers openstreetmap.org's directions use. Rules: one request a second at most, a valid
User-Agent, the attribution shown with a link to "fix the map" (www.openstreetmap.org/fixthemap), no scraping or
heavy use. OSRM's own wiki describes them as a demo for reasonable, non-commercial use, with no promise of uptime.

`router.project-osrm.org` is FOSSGIS's too, but it answers with car routes whatever profile the address names: asked
for `/foot/` from the Eiffel Tower to the Louvre it gave 4,304 m in 634 seconds, the car route, where `routed-foot`
gives 3,748 m in 3,002 seconds. Don't send walking or cycling there.

**Time zones** come from the `timezonefinder` package, offline. Its boundaries are timezone-boundary-builder's,
made from OpenStreetMap and under the ODbL. Version 8.2.0 is the last for Python 3.10 (9.x needs 3.12); pip picks
the right one. Ready-made wheels exist only for x86-64 Linux, so elsewhere pip builds it from its source (about 50 MB),
falling back to plain Python when there's no compiler. Python's `zoneinfo`
gives the offsets from the computer's time zone database; Windows has none, so it needs the `tzdata` package.

## One lookup without the script

The dashboard's page fetching can read these addresses directly (GET requests, JSON answers). Its User-Agent names
the dashboard; with the user's contact, add `&email=<contact>` to Nominatim addresses. One lookup at a time, at
least a second apart, and never in a loop: lists go through the script.

| What | Address |
|---|---|
| Place to coordinates | `https://nominatim.openstreetmap.org/search?q=Tour%20Eiffel%2C%20Paris&format=jsonv2&limit=3` |
| Coordinates to address | `https://nominatim.openstreetmap.org/reverse?lat=48.8584&lon=2.2945&format=jsonv2&zoom=18` |
| A walking route | `https://routing.openstreetmap.de/routed-foot/route/v1/driving/2.2945,48.8584;2.3376,48.8606?overview=false` |
| Places by tag | `https://overpass-api.de/api/interpreter?data=` followed by the query below, URL-encoded |

- Nominatim's `jsonv2` gives `lat` and `lon` as strings, `display_name`, `category` and `type`, `address` (with
  `&addressdetails=1`) and `boundingbox` as `[south, north, west, east]`. `&countrycodes=fr` keeps to a country,
  `&accept-language=en` sets the language, `limit` goes up to 40. A reverse lookup with nothing there answers
  `{"error":"Unable to geocode"}`. `zoom` sets the detail: 18 a building, 16 a major street, 14 a neighbourhood,
  10 a city, 5 a state, 3 a country.
- The router wants **longitude first** (`lon,lat;lon,lat`), the reverse of a map pin. Use `routed-car`,
  `routed-bike` or `routed-foot`; the `driving` that follows stays as it is. The answer's `routes[0].distance` is in
  metres and `duration` in seconds; `code` is `Ok`, or `NoRoute` or `NoSegment` (with HTTP 400) when there's none.
  `&steps=true` adds the turns, but only as manoeuvre types and road names.
- An Overpass query for pharmacies within 1,000 m, nearest not guaranteed first (sort by distance yourself):
  `[out:json][timeout:25];nwr["amenity"="pharmacy"](around:1000,48.8584,2.2945);out center tags 50;`. Nodes have
  `lat` and `lon`; ways and areas have them under `center`.

## Links to maps

None needs a key. Google's open the Google Maps app on a phone that has it; OpenStreetMap's open its website.

- OpenStreetMap, a marker: `https://www.openstreetmap.org/?mlat=48.8584&mlon=2.2945#map=18/48.8584/2.2945`; a
  mapped object: `https://www.openstreetmap.org/node/2065895673` (or `way/…`, `relation/…`), which also shows its tags.
- OpenStreetMap, directions (latitude first here; engines `fossgis_osrm_car`, `fossgis_osrm_bicycle` and
  `fossgis_osrm_foot`):
  `https://www.openstreetmap.org/directions?engine=fossgis_osrm_foot&route=48.8584%2C2.2945%3B48.8606%2C2.3376`.
- Google Maps (its "Maps URLs"), a point: `https://www.google.com/maps/search/?api=1&query=48.8584,2.2945`;
  directions:
  `https://www.google.com/maps/dir/?api=1&origin=48.8584,2.2945&destination=48.8606,2.3376&travelmode=walking`.
  `travelmode` is `driving`, `walking`, `bicycling`, `two-wheeler` or `transit`; stops go in `waypoints`, separated
  by `|` (`%7C`), up to three on a phone's browser and nine elsewhere. Leaving out `origin` starts from where the
  phone is.

## Attribution

The OpenStreetMap Foundation's attribution guidelines ask that the credit names OpenStreetMap and makes clear the
data is under the ODbL, for example by linking to openstreetmap.org/copyright; "© OpenStreetMap contributors" is an
accepted form. A list of geocoding or routing results doesn't need it on every item, but the answer or app that shows
them does. For routes from the FOSSGIS servers, credit them too and give the fix-the-map link. The credit line in
SKILL.md covers this.

## Your own servers

Nominatim, Overpass and OSRM are open source and can run on your own machine or server, which is the way for an app,
for large batches or for commercial use. The script takes their addresses: `--nominatim-url`, `--overpass-url`, and
`--router-url` (an OSRM server's address; `{mode}` in it is replaced by `car`, `foot` or `bike` for a layout like
FOSSGIS's). The one-second waits apply only to the public servers.
