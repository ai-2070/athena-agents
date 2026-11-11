# PDF forms in depth

Everything here uses `scripts/pdf_forms.py` in this skill's folder: `python <skill folder>/scripts/pdf_forms.py
<command> --help` shows each command's options. Coordinates are PDF points (72 to the inch) measured from the page's
bottom-left corner, and a box is `[x0, y0, x1, y1]` with `x0 < x1` and `y0 < y1`.

## What each field type takes

| Type in `fields`      | Write in values.json                                                                             | Reads back as                   |
| --------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------- |
| `text`                | a string (numbers are turned into strings)                                                       | the string                      |
| `checkbox`            | `true` / `false`, or its `on_value` (`"/Yes"`, `"Yes"`)                                          | `/Yes` (its on-state) or `/Off` |
| `radio`               | one of `options`, with or without the slash (`"red"` or `"/red"`), or its label; `null` for none | `/red` or `/Off`                |
| `dropdown`            | one option's value or its label                                                                  | the option's value              |
| `listbox`             | one option, or a list when `multi_select` is true                                                | the value or list               |
| `signature`, `button` | can't be filled here                                                                             |                                 |

A checkbox's on-state isn't always `/Yes`: some forms use `/On`, `/1` or a word. `fields` shows the real one, and
`fill` accepts `true` for whichever it is. Some forms number their buttons' states (`/0`, `/1`…) and keep what each
stands for in a separate list; `fields` then adds `labels` (`{"/0": "Ms", "/1": "Mr"}`), and `fill` takes a radio
button's label as well as its state. When a value could be either, a label of one button and the state of another,
`fill` refuses it: write the state with its slash. A dropdown marked `editable` also takes text that isn't in its
list. `max_length` is the most characters a text field takes; longer values are stored but get a warning.

Names are exact, including case and dots: a field inside a group is listed as `group.name`, and that whole name is
what `fill` wants. `fill` only changes the names it's given, so filling in several passes is fine.

## Matching fields to the printed labels

Fields made by form tools often have names like `Text7` or `Check Box3`. Each entry from `fields` has its `page` and
`rect`, and `pdf_forms.py layout form.pdf --pages N` lists the printed text lines with their boxes in the same units.
The label for a field is usually the line just to its left at the same height, or just above it. When that leaves
doubt, render the page (`pdf_tool.py render form.pdf --pages N --dpi 100 --out-dir pdf-work/looks`) and look: a
point `(x, y)` is at pixel `(x × dpi / 72, (page height − y) × dpi / 72)`, counting pixels down from the top.

## How filling works

`fill` checks every name and value against the form before writing anything, and on any problem writes nothing and
says what fits instead (a near-miss name gets a "did you mean"). Then it:

- writes text and choice values and redraws those fields' appearance with the field's own font and size. pypdf
  doesn't wrap or shrink text in a field with a set font size, so a value wider or longer than its box shows only
  its start, there and in a flattened copy; the result warns about each one;
- stores each checkbox or radio choice as the PDF format expects, a name on the field with every button showing its
  own on-state or `/Off` (pypdf on its own stores the choice as a string, where the format expects a name);
- sets the form's NeedAppearances flag, which asks viewers to redraw fields themselves;
- opens the new file and compares every value with what was asked; any difference is listed in `mismatches` and the
  command exits 1.

**Fonts.** A field draws with the font named in its settings, often Helvetica, which has Western European letters
only. Values in other scripts are stored correctly (PDF text fields hold any Unicode), but the drawing made for them
shows `?` in place of the missing letters. A viewer that redraws fields itself may show the value with a font it
has; one that uses the stored drawing shows the `?`. So for such values: fill without flattening, tell the user which
fields are affected, and ask them to check in the viewer they'll use. A flattened copy keeps the `?`.

**XFA forms.** Forms made with Adobe's XFA designer carry a second, XML copy of the form that Acrobat shows instead
of the ordinary fields, and some have no ordinary fields at all. `fields` reports `"xfa": true`. Filling the ordinary
fields may not show up in Acrobat. Say so, and offer: the user fills it in Acrobat Reader, the sender provides a
version without XFA, or a flattened copy (flattening drops the XFA part along with the fields), checked by rendering.

**Signatures.** Signature fields are listed with `signed: true` or `false` and are never filled here. Signing with a
certificate is the user's act; Storytold's `pdfcraft` can do it in an installed app. These scripts write a new file,
so running any of them on a signed PDF (flattening included) leaves a copy whose signature no longer checks out;
`flatten` warns about it.

## Flattening

`flatten` (or `fill --flatten`) draws each visible field's current appearance into the page content, then removes the
fields, so the values can't be changed and look the same in every viewer. Before drawing, it redraws text fields from
their values if the form asks viewers to redraw (NeedAppearances), if a field has no drawing, or with `--redraw`;
otherwise it keeps the drawings already there, which may be better ones made by Acrobat. Hidden fields are dropped,
and so are buttons that don't print, such as a "Print form" or "Clear" button.

pypdf's own `update_page_form_field_values(..., flatten=True)` isn't used: in pypdf 6 (checked with 6.21) it leaves
the fields in place and draws every button of a radio group with the same appearance, so all of them look chosen.
Check any flattened copy anyway: `fields_left` should be 0, and a rendered page should show each value where it
belongs.

## Forms with no fields

When `fields` finds nothing, the form is printed lines and boxes. Two ways to fill it:

- **One or two values**: `pdf_tool.py stamp form.pdf --text "Ada Lovelace" --x 122 --y 701 --size 10 -o filled.pdf`.
- **A whole form**: give it fields, then fill as usual. This is the path below.

1. **Find where the writing goes.** `pdf_forms.py layout form.pdf --pages 1` lists `text_lines` (the printed labels),
   `boxes` (drawn rectangles: entry boxes, tick boxes), `rules` (underlines to write on) and `small_curves` (circles
   that may be round tick boxes), all as `[x0, y0, x1, y1]`. A scanned form has no text layer: render it and measure
   from the image with the formula above, or run step 3 with `"fields": []` in the spec to get the pages with a
   measuring grid.
2. **Write the spec** (below). Put a text box just above an underline (`y0` a point or two over the line, about the
   font size plus 4 pt tall), or 1 pt inside a printed box. Tick boxes take the printed square's own box. Leave out
   `label`: the page already prints them.
3. **Check it and look.** `pdf_forms.py check pdf-work/spec.json --on form.pdf --overlay pdf-work/check.png --grid 50`
   reports problems (exit 1 while there are errors) and draws every box over the real page: red for fields (thick
   when that field has an error), blue for labels and texts, grey grid lines every 50 pt with their values. Look at
   the image; fix boxes that miss their line or box, and run it again until it's clean. A form with several pages
   gives one image per page (`check_p1.png`, `check_p2.png`…).
4. **Build** `pdf_forms.py build pdf-work/spec.json --on form.pdf -o fillable.pdf`. It runs the same check, and on
   errors writes nothing and exits 1 (`--skip-check` builds anyway, for an error you've looked at and accept). Fields
   laid over a printed form are see-through, with no border, so the printed boxes show.
5. **Fill and flatten** as for any form, then render the page and look once more.

A page that's turned (it has a `/Rotate` setting) is refused by `check` and `build`, because positions measured on
what you see wouldn't match the page's own coordinates. Pages whose `layout` shows a rotation warning have the same
problem, and so do the rare pages whose corner isn't at (0, 0), which `check` also refuses.

## The form spec

`build` makes a new form from the same spec when it's run without `--on`; then `page_size` sets the pages and labels
are drawn from `label`.

```json
{
  "page_size": "A4",
  "pages": 1,
  "title": "Membership form",
  "font_size": 10,
  "texts": [{ "page": 1, "at": [72, 780], "text": "Membership form", "size": 18 }],
  "fields": [
    {
      "name": "full_name",
      "type": "text",
      "page": 1,
      "box": [160, 700, 420, 720],
      "label": "Full name",
      "required": true
    },
    { "name": "notes", "type": "text", "multiline": true, "box": [160, 600, 420, 680], "label": "Notes" },
    { "name": "member", "type": "checkbox", "box": [160, 570, 174, 584], "label": "Existing member" },
    {
      "name": "plan",
      "type": "radio",
      "label": "Plan",
      "value": "basic",
      "options": [
        { "value": "basic", "box": [160, 540, 174, 554], "label": "Basic" },
        { "value": "pro", "box": [240, 540, 254, 554], "label": "Pro" }
      ]
    },
    {
      "name": "country",
      "type": "dropdown",
      "box": [160, 500, 300, 518],
      "label": "Country",
      "options": ["UK", "Ireland"],
      "value": "UK"
    }
  ]
}
```

- Top level: `page_size` is `A4`, `letter`, `legal` or `[width, height]` (ignored with `--on`, which takes the
  pages of that PDF); `pages` is the page count and grows to the highest page a field uses; `title` and `author` go
  into the file's metadata; `font_size` (default 10) is for labels and field text; `font` is a `.ttf` for labels and
  `texts` with letters Helvetica lacks (the fields themselves always draw with Helvetica).
- `texts` are fixed lines such as headings and instructions: `at` is where the baseline starts.
- Every field has a unique `name`, a `type` (`text`, `checkbox`, `radio`, `dropdown`), a `page` (default 1) and,
  except radio groups, a `box`. Optional: `label`, `label_side` (`left`, `right` or `above`; checkboxes default to
  right, the rest to left), `required`, `tooltip` (defaults to the label), `font_size`.
- `text`: `value`, `multiline`, `max_length`. `checkbox`: `checked`. `dropdown`: `options`, `value`, `editable`.
- `radio`: `options`, each with its own `value` and `box` and an optional `label` (drawn to its right); the group's
  `label` sits left of the first button, and `value` picks the one chosen at the start. A group needs two options.

What `check` calls an error (and `build` refuses): a missing or repeated name, an unknown type, a page that doesn't
exist, a box that's malformed or runs off the page, two field boxes overlapping, a radio group with fewer than two
options or repeated values, a starting value that isn't one of the options, label letters the label font can't draw,
and a turned page underneath. Warnings, which don't stop `build`: a text box too short for its font size, a tick box
under 8 pt across (hard to click and to see), and labels or texts overlapping a field or each other.
