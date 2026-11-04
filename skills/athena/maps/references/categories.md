What `nearby --category` searches for, the tags behind the odd ones, how to find a tag for anything else, the
filters that narrow a search, and how to read opening hours. OpenStreetMap describes a place with `key=value` tags;
a category is one or more sets of tags, and a place counts when it has every tag of one set. Usage counts below are
from taginfo.openstreetmap.org, checked in November 2026.

## The categories

`maps_tool.py categories` prints the same list as JSON, with a few spellings it also accepts (`gas_station`,
`doctors`, `bookstore`, `pool`, `chemist`).

| Category | Tags |
|---|---|
| `restaurant` | `amenity=restaurant` |
| `fast_food` | `amenity=fast_food` |
| `cafe` | `amenity=cafe` |
| `bar` | `amenity=bar` |
| `pub` | `amenity=pub` |
| `bakery` | `shop=bakery` or `amenity=bakery` |
| `ice_cream` | `amenity=ice_cream` or `shop=ice_cream` |
| `supermarket` | `shop=supermarket` |
| `convenience` | `shop=convenience` |
| `marketplace` | `amenity=marketplace` |
| `pharmacy` | `amenity=pharmacy` or `healthcare=pharmacy` |
| `hospital` | `amenity=hospital` |
| `clinic` | `amenity=clinic` |
| `doctor` | `amenity=doctors` |
| `dentist` | `amenity=dentist` |
| `veterinary` | `amenity=veterinary` |
| `atm` | `amenity=atm` |
| `bank` | `amenity=bank` |
| `bureau_de_change` | `amenity=bureau_de_change` |
| `fuel` | `amenity=fuel` |
| `charging_station` | `amenity=charging_station` |
| `parking` | `amenity=parking` |
| `bicycle_rental` | `amenity=bicycle_rental` |
| `car_rental` | `amenity=car_rental` |
| `taxi` | `amenity=taxi` |
| `bus_stop` | `highway=bus_stop` |
| `train_station` | `railway=station` |
| `ferry_terminal` | `amenity=ferry_terminal` |
| `airport` | `aeroway=aerodrome` |
| `hotel` | `tourism=hotel` |
| `hostel` | `tourism=hostel` |
| `guest_house` | `tourism=guest_house` |
| `camp_site` | `tourism=camp_site` |
| `museum` | `tourism=museum` |
| `attraction` | `tourism=attraction` |
| `viewpoint` | `tourism=viewpoint` |
| `zoo` | `tourism=zoo` |
| `park` | `leisure=park` |
| `playground` | `leisure=playground` |
| `cinema` | `amenity=cinema` |
| `theatre` | `amenity=theatre` |
| `nightclub` | `amenity=nightclub` |
| `gym` | `leisure=fitness_centre` |
| `swimming` | `leisure=sports_centre` + `sport=swimming` or `leisure=swimming_pool` + `access=yes` or `leisure=swimming_pool` + `access=customers` |
| `post_office` | `amenity=post_office` |
| `post_box` | `amenity=post_box` |
| `police` | `amenity=police` |
| `fire_station` | `amenity=fire_station` |
| `toilets` | `amenity=toilets` |
| `drinking_water` | `amenity=drinking_water` |
| `library` | `amenity=library` |
| `laundry` | `shop=laundry` |
| `hairdresser` | `shop=hairdresser` |
| `bookshop` | `shop=books` |
| `place_of_worship` | `amenity=place_of_worship` |
| `church` | `amenity=place_of_worship` + `religion=christian` |
| `mosque` | `amenity=place_of_worship` + `religion=muslim` |
| `synagogue` | `amenity=place_of_worship` + `religion=jewish` |
| `hindu_temple` | `amenity=place_of_worship` + `religion=hindu` |
| `buddhist_temple` | `amenity=place_of_worship` + `religion=buddhist` |
| `school` | `amenity=school` |
| `university` | `amenity=university` |
| `kindergarten` | `amenity=kindergarten` |

## The odd ones

- **Doctors** are `amenity=doctors`, plural (about 210,000 uses; the singular has almost none). A hospital is
  `amenity=hospital`, a walk-in or group practice often `amenity=clinic`: for "a doctor near me" search `doctor` and
  `clinic` together.
- **Bakeries** are `shop=bakery` (about 257,000). `amenity=bakery` is a rare mistake, searched as well because it
  costs nothing.
- **Pharmacies** carry `amenity=pharmacy`, often with `healthcare=pharmacy`; a few have only the second, so both are
  searched. `dispensing=yes` marks one that fills prescriptions: add `--with dispensing=yes` when that's the point.
  A shop selling toiletries without a pharmacist is `shop=chemist`.
- **Churches, mosques, synagogues and temples** are all `amenity=place_of_worship`; the faith is in `religion=*`, and
  `denomination=*` narrows it (`--with denomination=catholic`). A place with no `religion` tag only turns up under
  `place_of_worship`.
- **Swimming:** `leisure=swimming_pool` alone has about three million uses, most of them private garden pools, so the
  category takes pools marked open to the public or to customers, and sports centres for swimming. A public pool
  without an `access` tag can be missed: try `--tag leisure=swimming_pool --name <its name>`.
- **Train stations** are `railway=station`, which includes metro stations (`station=subway`). `public_transport=station`
  also covers bus stations, so it isn't used.
- **Airports** (`aeroway=aerodrome`) include small airfields; check the name or `iata=*` before calling one an airport.
- **Ice cream** is mostly `amenity=ice_cream`; `shop=ice_cream` is the rarer form, searched too.

## Anything else

`--tag key=value` searches any tag, `--tag key=*` any value of a key (`--tag shop=*` for every shop). To find the tag
for a kind of place, look it up on the OpenStreetMap wiki's Map features page (wiki.openstreetmap.org/wiki/Map_features)
or search taginfo.openstreetmap.org, which shows how often each tag is used: prefer the common one. Some that come up:
`shop=bicycle` (bike shop), `amenity=bicycle_parking`, `shop=hardware`, `shop=optician`, `amenity=recycling`,
`amenity=vending_machine`, `tourism=information`, `amenity=shelter`, `leisure=dog_park`, `amenity=childcare`.

Chains: `--name` matches part of the name in any case (`--name "starbucks"`); `--with brand=Lidl` matches the brand
tag, which is more reliable where it's set.

## Filters

`--with key=value` keeps places that also have that tag; the value may be one of a list (`cuisine=italian` matches
`italian;pizza`), any case. `--with key` keeps places that have the key at all. Repeat for more; all must match.

| To find | Add |
|---|---|
| A kind of food | `--with cuisine=italian` (also `pizza`, `sushi`, `indian`, `chinese`, `burger`…) |
| Vegan or vegetarian food | `--with diet:vegan=yes` (or `only`), `--with diet:vegetarian=yes` |
| Step-free access | `--with wheelchair=yes` (`limited` means partly) |
| Places that say when they open | `--with opening_hours` |
| Free toilets, baby changing | `--with fee=no`, `--with changing_table=yes` |
| Takeaway, drive-through, seats outside, wifi | `--with takeaway=yes`, `--with drive_through=yes`, `--with outdoor_seating=yes`, `--with internet_access=wlan` |
| Prescriptions filled | `--with dispensing=yes` |

A filter keeps only places where someone entered the tag, so it drops places that would qualify but aren't tagged.
Say so when a filtered search comes back thin, and offer the unfiltered list.

## Reading opening hours

`opening_hours` uses a compact syntax that volunteers keep up to date as best they can:

- `Mo-Fr 08:00-18:00; Sa 09:00-13:00`: rules separated by `;`, days `Mo Tu We Th Fr Sa Su`, ranges with `-`, lists
  with `,`.
- `PH` is public holidays, `SH` school holidays; `off` or `closed` means shut (`Su off`).
- `24/7` is always open; `sunrise-sunset` follows the daylight; `12:00-02:00` runs past midnight into the next day.
- Later rules override earlier ones for the same days (`Mo-Su 10:00-20:00; Su off` is shut on Sundays).
- Text in quotes is a comment ("by appointment").

To say whether a place is open now, take the current time in the place's own zone (`maps_tool.py timezone` with its
coordinates), read the rule for that day, and say it comes from OpenStreetMap. `checked_on` in the result (from the
`check_date:opening_hours` or `check_date` tag) is when a mapper last confirmed it; hours checked years ago are worth
a warning.
