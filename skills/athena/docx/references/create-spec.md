# Making a document, and writing your own python-docx code

`python <skill folder>/scripts/docx_create.py spec.json -o out.docx` builds a document from a JSON spec; its `--help`
prints a complete example. This page explains the choices behind each part, then what to know before writing your own
python-docx code. Checked in November 2026 against python-docx 1.2.0 and LibreOffice 24.8.

## The spec

Top level, all optional except `blocks`:

| Key                                      | What it does                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `template`                               | a `.docx` or `.dotx` to start from (path relative to the spec): its styles, theme, page setup, headers and footers. Its body is removed unless `"keep_body": true` |
| `page_size`, `landscape`                 | `A4`, `letter`, `legal`, `A3`, `A5` or `[width_mm, height_mm]`. Default A4, or the template's own                                                                  |
| `margins_mm`                             | one number for all four sides, or `{"top", "bottom", "left", "right"}`. Default 25.4, Word's "Normal" margins                                                      |
| `font`, `font_size`                      | the Normal style's font (for every script: Latin, East Asian, Arabic and Hebrew) and size in points                                                                |
| `title`, `author`, `subject`, `keywords` | the file's properties, shown in File › Info                                                                                                                        |
| `header`, `footer`                       | one line of text each; they replace a template's own header or footer, logo included                                                                               |
| `page_numbers`                           | `true` for "Page N of M" in the footer, or a pattern such as `"Seite {PAGE} von {NUMPAGES}"`                                                                       |
| `styles`                                 | paragraph styles of your own: `name`, `base`, `font`, `size`, `bold`, `italic`, `color`, `space_before`, `space_after` (points), `align`                           |

Blocks:

| `type`                | Takes                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `heading`             | `text` or `runs`, `level` 1 to 9 (0 is the Title style)                                                           |
| `paragraph`           | `text` (a `\n` is a line break) or `runs`; `style`, `align` (`left`, `center`, `right`, `justify`)                |
| `bullets`, `numbered` | `items`: text, or `{"text": .., "level": 2}` (or `runs` instead of `text`)                                        |
| `table`               | `rows` (lists of cells), `header` (default true), `style` (default `Table Grid`), `widths_mm`, `align` per column |
| `image`               | `path`, `width_mm` (height keeps the proportions), `align` (default center), `caption`                            |
| `toc`                 | `levels` (default 3), `title`                                                                                     |
| `page_break`          | nothing                                                                                                           |

A run is `{"text": ..}` with any of `bold`, `italic`, `underline`, `strike`, `superscript`, `subscript`, `color` (six
hex digits), `size`, `font`, and `link` (http, https or mailto; drawn in Word's link blue and underlined unless the
run says otherwise). Text goes in as written: `&`, `<` and quotes need no escaping.

Every problem in a spec is reported at once (exit code 1, nothing written), each with the block it's in.

## Choices worth knowing

- **Paper.** A4 is the default; the US and Canada use letter. Ask, or follow the user's other documents.
- **Real styles, not bold paragraphs.** Headings made with `heading` show in Word's navigation pane, feed the table of
  contents and take the template's look. A Word-made template stores only the styles it uses, so a built-in style it
  lacks (headings, Title, List Paragraph, Table Grid, Caption, Quote, TOC Heading) is copied in from python-docx's own
  set. Those use the theme's fonts and accent colour, so they follow the template's theme.
- **Lists.** Each `bullets` or `numbered` block gets a list definition of its own: every numbered list starts at 1, and
  deeper levels indent and count again under each item (1., a., i.). Without that, Word's "List Number" style carries
  on counting from the previous list. Bullets are •, ◦ and ▪ by level.
- **Tables.** The header row is bold and repeats at the top of each page. Cells that hold a number are aligned right
  unless `align` says otherwise. `widths_mm` sets both the table's grid, which LibreOffice follows, and each cell's
  width, which Word follows. `"style": ""` leaves the table unstyled (and without borders).
- **Pictures.** PNG, JPEG, GIF, BMP and TIFF. Turn SVG or WebP into PNG first (the media tools' ImageMagick, or
  Pillow). A caption is a plain paragraph in the Caption style, not a numbered caption field.
- **Fields.** Page numbers and the table of contents are fields: instructions Word and LibreOffice carry out while
  laying out pages. Page numbers come out right in both, and in a PDF from `soffice.py`. A table of contents stays a
  one-line placeholder until fields are updated: the file asks Word to update them on opening (Word asks the user
  first), and in LibreOffice Writer it's Tools › Update › Update All. A PDF made straight from the file shows the
  placeholder. For a PDF with a real contents list, have the user open the file in Word, update fields (select all,
  then F9) and save as PDF, or update it in LibreOffice Writer and export; for a short document, leave the contents
  out.

## Your own python-docx code

For what the scripts don't do (moving pictures, section breaks, columns, repeating table rows), write a short script
in `docx-work`, run it on a copy, save to a new file and read the result back with `docx_tool.py text` and `check`.
What trips people up in python-docx 1.2:

- `Paragraph.text` reads only the paragraph's own runs and links: text in tracked insertions and in content controls
  is missing. `Document.paragraphs` and `Document.tables` skip whatever sits inside a content control. Read with
  `docx_tool.py text` instead.
- Setting `paragraph.text` or `cell.text` replaces every run, so bold, italic and fonts are gone; setting `run.text`
  removes pictures, fields or breaks in that run. Change the text of a run you've found, or use `docx_tool.py edit`.
- `docx.Document()` opens only `.docx`. A `.dotx` or `.docm` raises `ValueError: file '...' is not a Word file`;
  `docx_tool.py` and `docx_create.py` open them.
- `doc.styles["Heading 1"]` raises `KeyError` in a document that never used that style.
- Lengths: `Pt`, `Mm`, `Cm` and `Inches` from `docx.shared` convert for you. In the XML, page sizes and indents are
  twentieths of a point (1440 to the inch), font sizes half-points, and pictures EMUs (914,400 to the inch).

Repeating a table row for each item, keeping the row's formatting (a template row of `{{tokens}}` filled per item):

```python
import copy
import docx
from docx.table import _Row

items = [["Widget", "2", "£10.00"], ["Gadget", "1", "£4.50"]]

doc = docx.Document("docx-work/filled.docx")
table = doc.tables[0]                 # python-docx counts from 0
template = table.rows[1]._tr          # the row to repeat, formatting and all
for values in items:
    tr = copy.deepcopy(template)
    template.addprevious(tr)          # copies go in order, before the template row
    for cell, value in zip(_Row(tr, table).cells, values):
        runs = cell.paragraphs[0].runs
        if runs:
            runs[0].text = value      # keeps the first run's formatting
            for extra in runs[1:]:
                extra.text = ""
        else:
            cell.paragraphs[0].add_run(value)
template.getparent().remove(template)  # the template row itself goes
doc.save("docx-work/with-rows.docx")
```
