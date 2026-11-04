# Plans for pptx_deck.py

`pptx_deck.py` makes a deck (`new`) or changes one (`edit`) by running the steps of a JSON plan in order. Write the
plan with your file tools into `pptx-work/`, as UTF-8 (files Windows PowerShell saved as UTF-16 or ANSI are read too;
the result notes an ANSI one). Paths inside the plan are relative to the plan's folder.

```
python <skill folder>/scripts/pptx_deck.py new pptx-work/plan.json -o "Q3 review.pptx"
python <skill folder>/scripts/pptx_deck.py new pptx-work/plan.json -o "Q3 review.pptx" --template brand.potx
python <skill folder>/scripts/pptx_deck.py edit deck.pptx pptx-work/plan.json -o "deck v2.pptx"
```

`new` without `--template` starts from python-pptx's plain design (Calibri, white) at 16:9; `--template` takes a
`.potx` or `.pptx`, keeps its design and layouts and leaves its own slides and sections out. `edit` keeps everything
in the deck that no step touches. The output is a `.pptx` (a `.pptm` for a deck with macros), and it can't be the
input, the template or a file the plan uses unless `--overwrite` is given.

The result lists each step with what it did, then `"ok"` and `"problems"`. Exit code 0: done. 1: the deck was
written, but a step found a problem (a `replace` that matched nothing, `{{tokens}}` with no value, values with no
token, slides whose layout has no footer placeholder). 2: a step couldn't run (a slide past the end, a shape that
isn't there, a chart value that isn't a number, a key the step doesn't take); stderr says which step and why, and
nothing was written.

## The plan

```json
{
  "size": "16:9",
  "properties": {"title": "Q3 review", "author": "Finance", "subject": "", "keywords": ""},
  "steps": [{"do": "add", "layout": "Title Slide", "title": "Q3 review"}]
}
```

- `size`: only for `new` without a template: `"16:9"` (13.33 x 7.5 in, the default), `"4:3"` (10 x 7.5 in), or
  `[width, height]` in inches. The plain design's layouts are stretched to fit.
- `properties`: what File > Info shows. Optional.
- `steps`: the steps, in order. A plan can also be the list of steps on its own.

Slide numbers count from 1 and mean the deck as it stands when the step runs, so a step after a delete sees the new
numbers. `"slides"` takes `"1-3,7,10-"`, a number or a list of numbers; left out, it means every slide.
`"shape"` is a shape's id (a number) or its name, as `pptx_tool.py outline` lists them; when two shapes share a name,
use the id. Positions and sizes are inches from the slide's top-left corner, or text with a unit: `"2.5cm"`, `"30mm"`,
`"72pt"`.

## Steps

| `do` | Keys | What it does |
|---|---|---|
| `add` | `layout`, `master`, `title`, `subtitle`, `body`, `placeholders`, `shapes`, `notes`, `hidden`, `at`, `keep_empty` | A slide from a layout |
| `text` | `slide`, `shape`, `text`, `cell` | A shape's text (or a table cell's), keeping its look |
| `table` | `slide`, `shape`, `rows` | Every cell of a table; rows are added or removed at the end |
| `replace` | `find`, `with`, `slides`, `notes`, `layouts`, `match_case` | Text wherever it is |
| `fill` | `values`, `slides`, `notes`, `layouts` | `{{name}}` markers replaced by values |
| `notes` | `slide` or `slides`, `text`, `append` | Speaker notes (`"text": ""` with `"slides": "1-"` empties them all) |
| `chart` | `slide`, `shape`, `categories`, `series`, `set`, `add`, `remove`, `rename`, `title`, `colors` | A chart's data |
| `picture` | `slide`, `shape`, `path`, `alt` | A new picture in a picture's frame, or in an empty placeholder |
| `add_shapes` | `slide`, `shapes` | Shapes added to a slide |
| `delete_shape` | `slide`, `shape` | A shape taken off |
| `delete` | `slides` | Slides taken out |
| `move` | `slides`, `to` | Slides moved; `to` is the number the first has afterwards |
| `duplicate` | `slide`, `to` | A copy, right after the slide unless `to` says where |
| `hide` | `slides`, `hidden` | Hidden in the slide show (`"hidden": false` shows them again) |
| `footer` | `slides`, `text`, `number`, `date` | Footer text, slide number and date from the layout |

### add

- `layout`: a layout's name (not case-sensitive) or its number, as `pptx_tool.py info` lists them. `master` picks
  the master when two masters have a layout of that name.
- `title`, `subtitle`: the title placeholder (title, centred title or vertical title) and the subtitle placeholder.
- `body`: the first body or content placeholder by idx. Other placeholders go in `placeholders`, keyed by idx:
  `{"2": ["Right column point"], "13": {"picture": "team.jpg", "alt": "The team"}}`.
- `shapes`: shapes added on top (below).
- `notes`: the speaker notes. `hidden`: true hides the slide. `at`: its number afterwards (default: the last).
- Placeholders that get nothing are deleted, unless `"keep_empty": true`.

A step fails, listing what the layout has, when the layout has no placeholder for a key.

### Content

`title`, `subtitle`, `body`, a placeholder, `text`, `notes`, a text shape and a table cell take:

- a string; `"\n"` starts a new paragraph;
- a list of paragraphs, each a string (where `"\n"` breaks the line) or an object:
  `{"text": "Two new stores", "level": 1, "bold": true, "italic": false, "underline": false, "size": 20,
  "color": "#1F4E79", "font": "Georgia", "link": "https://example.com", "align": "center"}`; `level` runs from 0 to
  8, `size` is points, `link` starts with `https://`, `http://` or `mailto:`, `align` is `left`, `center`, `right` or
  `justify`. All keys but `text` are optional;
- a paragraph of differently formatted parts: `{"runs": [{"text": "Revenue "}, {"text": "up 18%", "bold": true}],
  "level": 0}`.

A placeholder also takes `{"picture": "file.png", "alt": "..."}`, `{"chart": chart}` or `{"table": table}`. A
picture fills a picture placeholder, cropped to its shape, as PowerPoint does; in a content placeholder it fits inside,
uncropped. Pictures are PNG, JPEG, GIF, BMP or TIFF.

New text takes the look of the paragraph it replaces: in an `add` step the layout's, in a `text` step the old
paragraph in its place (or the first old one at the same level). Formatting in the plan is only for what should
differ from that.

### Shapes

Every shape has `x`, `y` and may have `name` (later steps can then find it by that name).

| `type` | Keys |
|---|---|
| `text` | `w`, `h`, `text`, `size`, `bold`, `italic`, `color`, `font`, `align` (for every paragraph) |
| `picture` | `path`, `alt`, `w` and/or `h`: with one, the other follows the picture's proportions; with both, it fits inside |
| `chart` | `w`, `h`, `chart` |
| `table` | `w`, `table`, `h` (optional: 0.4 in a row) |
| `box` | `w`, `h`, `shape` (`rectangle`, `rounded`, `oval`), `fill` and `line` (`"#hex"` or `"none"`), `text` and the text keys |

### Charts

```json
{"type": "column", "categories": ["Q1", "Q2", "Q3"], "series": {"North": [10, 12, 15], "South": [9, 9, null]},
 "title": "North grew, South stayed flat", "number_format": "#,##0", "legend": "bottom", "labels": true,
 "font_size": 14, "colors": ["#1F4E79", "#A6A6A6"]}
```

`type`: `column`, `column_stacked`, `column_stacked_100`, `bar` (horizontal), `bar_stacked`, `bar_stacked_100`,
`line`, `line_markers`, `pie`, `doughnut`, `area`, `area_stacked`, `scatter`. Each series has one value per
category (`null` for none). A `scatter` chart has no categories; its series are lists of `[x, y]` points.
`number_format` is Excel's (`"0%"`, `"#,##0.0"`, `"€#,##0"`) and shows on the axis and, with `labels`, on the values.
`legend` is `bottom`, `right`, `top`, `left` or `false`; by default it's at the bottom for pie and doughnut charts
and charts with several series, and a chart with one series has none. `colors` is one per series, or one per slice
for pie and doughnut; without it the theme's colours are used. Without `title` the chart has none.

### Tables

```json
{"rows": [["Region", "Units"], ["North", "1,250"], ["South", "980"]], "header": true, "widths": [2, 1], "font_size": 14}
```

The first row is styled as a header unless `"header": false`. `widths` are shares of the table's width. Cells that
are numbers (or read like one: `1,250`, `-4%`, `(300)`) are right-aligned.

### replace and fill

`replace` changes `find` to `with` on the slides asked (default all), in their tables, groups, chart titles and
SmartArt, and in the speaker notes unless `"notes": false`. `"layouts": true` also changes masters and layouts.
`"match_case": false` ignores case. A match can't cross a line break, and `with` can't hold one (use a `text` step).

`fill` replaces each `{{name}}` (spaces inside the braces are allowed) by its value in `values`. A marker with no
value stays and is a problem; so is a value whose marker isn't in the deck.

### chart (in edit)

Name the chart with `shape` when the slide has more than one. Then either replace the whole data, with `categories`
and `series` as above (an x-y chart: `series` only), or name changes:

- `"set": {"North": [11, 12, 16]}` or `"set": {"North": {"Q2": 12.5}}` (only those categories);
- `"add": {"East": [3, 4, 5]}`: a new series, coloured by the theme;
- `"remove": ["South"]`: the series and its formatting go; the others keep theirs;
- `"rename": {"Q3": "Q3 2026"}`: category labels (not on charts whose categories are dates or numbers);
- `"title": "New title"` (`""` removes it), `"colors": {"East": "#548235"}`.

Number formats and the chart's look stay. Bubble charts, charts with categories in several levels (for small
changes) and the newer chart kinds (waterfall, funnel, treemap...) can't be changed here.

### footer

`"text"` sets the footer, `"number": true` shows the slide number, `"date"` sets the date's text; `""` or `false`
takes each off. The placeholders come from each slide's layout; slides whose layout has none are listed as a problem.

## Examples

A new deck in a brand template (layout names from `pptx_tool.py info brand.potx`):

```json
{
  "properties": {"title": "Q3 review", "author": "Finance"},
  "steps": [
    {"do": "add", "layout": "Title Slide", "title": "Q3 review", "subtitle": "Sales team, 4 November 2026",
     "notes": "Open with the headline: every region grew."},
    {"do": "add", "layout": "Title and Content", "title": "North grew fastest in Q3",
     "body": ["North up 18%, its best quarter", {"text": "Two new stores opened in May", "level": 1},
              "South flat for the third quarter"]},
    {"do": "add", "layout": "Title Only", "title": "Only North beat its target",
     "shapes": [{"type": "chart", "x": 0.8, "y": 1.6, "w": 11.7, "h": 5.4, "name": "Sales chart",
                 "chart": {"type": "column", "categories": ["Q1", "Q2", "Q3"],
                           "series": {"North": [10, 12, 15], "South": [9, 9, 9]},
                           "number_format": "#,##0", "labels": true}}]},
    {"do": "add", "layout": "Picture with Caption", "title": "The new Leeds store", "body": "Opened 12 May",
     "placeholders": {"1": {"picture": "store.jpg", "alt": "Front of the Leeds store"}}},
    {"do": "add", "layout": "Title and Content", "title": "Next steps",
     "body": ["Open two stores in the South by {{Q1 date}}", "Review pricing in March"]},
    {"do": "footer", "slides": "2-", "text": "Sales team · Internal", "number": true}
  ]
}
```

Filling in a deck made from a template with markers, then changing a chart and the order:

```json
[
  {"do": "fill", "values": {"client": "Globex", "date": "4 November 2026"}},
  {"do": "replace", "find": "Acme", "with": "Globex", "layouts": true},
  {"do": "text", "slide": 2, "shape": "Title 1", "text": "Globex grew in every region"},
  {"do": "chart", "slide": 4, "set": {"North": {"Q3": 0.32}}, "add": {"East": [0.1, 0.12, 0.15]}},
  {"do": "notes", "slide": 4, "text": "East is new this quarter.", "append": true},
  {"do": "delete", "slides": "6"},
  {"do": "move", "slides": "5", "to": 2}
]
```
