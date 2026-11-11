---
name: Places, routes and maps
description: Use for places and getting around: "where is…", "coordinates of…", "find a pharmacy near…", "how long to walk from X to Y", directions, distances, "what time is it in…", or a location pin someone sent. Looks places up in OpenStreetMap, routes by car, foot or bike, links a map.
---

Questions about places are answered from OpenStreetMap's free services: Nominatim turns names and addresses into
coordinates and back, Overpass finds places by what they are (a pharmacy, a bus stop), FOSSGIS's routers give car,
foot and bike routes, and time zones are worked out on the computer. Volunteers run these for everyone, under rules
the script keeps. Good work makes sure it has the place the user meant before saying anything about it, says what each
number is (a straight line or the way by road, a router's estimate with no traffic), gives a link that opens on a
phone, and credits OpenStreetMap.

## Before you start

- **The script** runs in a shell as `python <skill folder>/scripts/maps_tool.py <command> …` (`py` on Windows if
  `python` isn't found), for example
  `python <skill folder>/scripts/maps_tool.py nearby 48.8584,2.2945 --category pharmacy --contact <their email>`.
  It needs only Python 3.10 or newer, except for `timezone`: a point or place needs the `timezonefinder` package
  (about 50 MB with its map data), and on Windows any time zone needs `tzdata`. Installing is the user's call: ask,
  then `python -m pip install timezonefinder tzdata`.
- **Contact.** The services want to know who is asking. Ask the user once whether you may send an email address of
  theirs with the requests, keep it in your memory, and pass it as `--contact` every time. If they'd rather not, leave
  it out. Never make one up or use anyone else's.
- **The rules.** Nominatim's usage policy asks an AI that uses or suggests it to point to the policy and explain its
  limits. So the first time you look something up for the user, add one line: it's OpenStreetMap's free Nominatim,
  for light use only (one request a second, no bulk lists, no lookups as you type), with its policy at
  operations.osmfoundation.org/policies/nominatim. The others' rules, and the addresses for a single lookup without a
  shell (through the dashboard's page fetching), are in `references/services.md`.

## Pick the command

| The question                                                 | Command                                                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| "Where is…", "coordinates of…", an address or a list of them | `geocode "Musée d'Orsay, Paris"`                                                              |
| "What's here?", coordinates with no name                     | `reverse 48.8600,2.3266`                                                                      |
| "A pharmacy, cafe or ATM near…"                              | `nearby 48.8584,2.2945 --category pharmacy` or `nearby "Gare de Lyon, Paris" --category cafe` |
| "How long to walk, drive or cycle", "directions from X to Y" | `route "Eiffel Tower, Paris" "Louvre, Paris" --mode foot --steps`                             |
| "What time is it in…", a time in another zone                | `timezone "Lima, Peru"`, `timezone --zone Asia/Tokyo --when 2026-12-01T09:00`                 |
| Which kinds of place `nearby` knows                          | `categories`                                                                                  |

A point is `LAT,LON`, latitude first, as on a map pin (`-33.8688,151.2093` works too); anything else is a place name,
looked up first. `nearby` also takes `--tag KEY=VALUE`, `--with KEY=VALUE` to narrow, `--name`, `--radius` (metres,
default 1000) and `--limit`; `route` takes `--via` for stops; `geocode` takes `--file` (one place per line), `--limit`
(results per place, default 3), `--out` and `--max-time`. All take `--contact`, `--lang en`, `--country fr`, `--wait`
and `--timeout`. `<command> --help` explains each. Results are JSON. Exit code 0 means done; 1 that something wasn't
found (a place, any places in the radius, a route) or a long list stopped early, which the JSON says; 2 that it
couldn't do the job, with the reason in one line on stderr.

## How to do it well

### The right place first

- A name has many matches: "Eiffel Tower" also finds a peak in Alberta. Read the first result's `display_name` and
  `kind`, add the city or `--country`, and ask the user when two places are equally likely. Say which one you used.
- Look a place up once and reuse its coordinates for the rest of the conversation. Nominatim asks for results to be
  kept, and blocks clients that send the same query again and again.
- A list of addresses goes through one `geocode --file` run, which sends one a second, skips repeats and stops before
  the shell's time limit, listing what's left in `not_sent` for the next run. Write the list, and the result
  (`--out`), in a `maps-work` folder in the workspace. Hundreds of addresses is bulk geocoding, which Nominatim
  discourages: ask the user first, and suggest their own Nominatim or a paid geocoder for more.

### Places nearby

- `--category` covers the usual kinds and handles the odd tags; `references/categories.md` has the list, other tags,
  the filters (`cuisine=italian`, `wheelchair=yes`, `diet:vegan=yes`) and how to read opening hours. Open it when the
  category isn't obvious or a search comes back empty.
- `straight_line_m` is as the crow flies. The walk can be much longer across a river or a railway, so for the two or
  three you'd suggest, run `route --mode foot` and give the walking time.
- Nothing found often means a small radius or thin mapping, not that none exist: widen it once and say so.
  `complete: false` means there were more matches than the script reads; make the radius smaller.
- Opening hours are what a volunteer last entered. Say "open until 21:00, according to OpenStreetMap", and when it
  matters (a pharmacy at night) suggest calling or checking its website. No hours means unknown, not closed. The
  reference says how to read them and judge "open now".

### Routes

- `--mode car`, `foot` or `bike`. Each goes to its own server, so walking and cycling times are real ones. There's no
  public transport: give the Google Maps link with `travelmode=transit` in place of the mode it has.
- `duration` is the router's estimate with no traffic, lights or waits: "about 50 minutes on foot". Copy `distance`
  and `duration` from the JSON, which gives kilometres and miles.
- Check `from` and `to`: a looked-up name shows what it `found`, and a large `snapped_m` means the point was far from
  any road or path the router knows, so the route starts somewhere else.
- With `--steps`, summarise long lists to the main turns and give the map link for the rest.

### Time zones

- `timezone` gives the zone, the UTC offset, its abbreviation, whether daylight saving is on, and the local time. For
  a meeting across zones, give `--when` as the local time at one place (`2026-03-30T09:00`) and read `utc_time`; then
  `--zone` for the other place with `--when` set to that UTC time ending in `Z`. It warns when a time is skipped or
  happens twice as the clocks change.
- Zones follow borders, not longitude. A point at sea gets a nautical zone (`at_sea`).

### Location pins

A Telegram pin reaches you as text, `📍 48.858370, 2.294481`: latitude, then longitude. Use it as the point and
`reverse` it if a name helps. A shared venue comes as `📍 Name, address` with no coordinates: look up the address. A
live location gives you only where it started, because the dashboard holds later edits for the user to review; ask
for a fresh pin if they may have moved. Someone's position is personal: use it for the question asked, and don't keep
it or pass it on.

### Showing the answer

Number the places, nearest first, with the distance, the hours if known and one link each (`links.google_maps` or
`links.openstreetmap`; routes have directions links). End with the credit "Data © OpenStreetMap contributors (ODbL),
openstreetmap.org/copyright", and for routes "Routes: FOSSGIS. Map wrong? openstreetmap.org/fixthemap".

## Done means

- The place is the one the user meant, checked by name and country, and the answer says which it is.
- Every figure is copied from the JSON; distances say whether straight or by road, times are called estimates.
  Each place has a link, and the credit line is there.
- `maps-work` is deleted before you reply, unless the user asked to keep the results file.

## Watch out for

- An app or site the user is building is a different matter: don't put the public Nominatim, Overpass or routers in
  its code. Point to the policies and to running their own servers or a paid provider; it's their decision.
- No grids of reverse lookups and no loops over the same places. One run at a time: parallel runs break the
  one-a-second rule. In a scheduled routine, add `--wait 15` (Nominatim allows those four requests a minute).
- HTTP 429 or a refusal: stop and tell the user. Don't retry in a loop; Overpass asks for 30 seconds before the next
  try, and a Nominatim 403 means the client is blocked.
- Longitude first is right only inside OSRM's own addresses; everything you write and pass to the script is
  latitude first.

## Files

- `scripts/maps_tool.py`: geocode, reverse, nearby, route, timezone and categories, as above; `--help` on each.
- `references/categories.md`: the categories and their tags, the odd ones, finding a tag, filters, reading opening
  hours. Open it for `nearby` beyond the obvious, or to judge "open now".
- `references/services.md`: each service's rules with their sources, addresses for one lookup without the script,
  map link formats, attribution, your own servers. Open it before calling a service any way but the script.
