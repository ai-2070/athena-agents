# The workbook spec and the change list

Two JSON files drive the scripts: a **spec** for `xlsx_create.py`, which makes a new workbook, and a **change list**
for `xlsx_tool.py edit`, which changes one. Both describe cells the same way. Write them with your file tools into
`xlsx-work`, then run:

```
python <skill folder>/scripts/xlsx_create.py xlsx-work/spec.json -o report.xlsx
python <skill folder>/scripts/xlsx_tool.py edit budget-backup.xlsx --changes xlsx-work/changes.json -o budget.xlsx
```

Both check the whole file before writing anything and list every problem at once on stderr (exit code 2), so fix them
all and run again. Exit code 1 means the workbook was written but a formula needs attention (`formula_problems`), or
for `edit`, that something wasn't kept or updated (`lost_on_save`, `not_updated`).

## A cell

| Write                                                        | Becomes                                                                                       |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `42`, `9.5`, `true`, `null`                                  | a number, true/false, an empty cell                                                           |
| `"North"`                                                    | text                                                                                          |
| `"=B2*C2"`                                                   | a formula                                                                                     |
| `{"text": "=not a formula"}`                                 | text, even though it starts with `=`                                                          |
| `{"formula": "SUM(B2:B9)"}`                                  | a formula (the `=` is added if missing)                                                       |
| `{"date": "2026-01-31"}`, `{"datetime": "2026-01-31 14:30"}` | a real date, shown as `yyyy-mm-dd` (`yyyy-mm-dd hh:mm`) unless `number_format` says otherwise |
| `{"value": 0.25, "number_format": "0%"}`                     | a value with a look                                                                           |

A number in quotes (`"42"`) is text: Excel won't add it up. `edit` lists any it wrote as `text_that_looks_like_numbers`.

An object takes one of `value`, `formula`, `text`, `date`, `datetime` (or none, to change only the look), plus any of:

| Key                      | Takes                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `number_format`          | an Excel format: `"#,##0.00"`, `"0.0%"`, `"yyyy-mm-dd"`, `"#,##0;(#,##0)"`, `"@"` for text |
| `bold`, `italic`, `wrap` | `true` or `false`                                                                          |
| `size`                   | font size in points, 1 to 409                                                              |
| `font_color`, `fill`     | a hex colour, `"1F4E79"` or `"#1F4E79"`; `"fill": null` removes a fill                     |
| `align`                  | `"left"`, `"center"` or `"right"`                                                          |
| `border`                 | `"thin"`, `"medium"`, `"thick"` on all four sides, or `"none"`                             |
| `note`                   | a note's text, or `{"text": "...", "author": "..."}` (the author defaults to Athena)       |
| `link`                   | a web address, or `"#Sheet2!A1"` for a place in the workbook                               |

Formulas use English function names and commas, whatever the user's Excel shows: `=SUMIFS(D:D,A:A,"North")`, not
`=SUMMEWENNS(D:D;A:A;"North")`. Functions newer than Excel 2007 take the `_xlfn.` prefix (`=_xlfn.XLOOKUP(...)`).

## The spec

```json
{
  "properties": { "title": "Q3 sales", "creator": "Finance" },
  "names": { "TaxRate": "Inputs!$B$1" },
  "sheets": [
    {
      "name": "Inputs",
      "rows": [["Tax rate", 0.25]],
      "formats": { "B1": { "number_format": "0%", "font_color": "0000FF" } }
    },
    {
      "name": "Sales",
      "header": true,
      "rows": [
        ["Region", "Units", "Price", "Revenue", "Status"],
        ["North", 120, 9.5, "=B2*C2", "Open"],
        ["South", 80, 11, "=B3*C3", "Done"]
      ],
      "cells": {
        "G1": "Total",
        "G2": { "formula": "=SUM(D2:D3)", "number_format": "#,##0.00", "bold": true },
        "G3": "=G2*(1-TaxRate)"
      },
      "formats": { "C2:D3": { "number_format": "#,##0.00" } },
      "validations": [{ "range": "E2:E50", "list": ["Open", "Done"], "prompt": "Pick one" }],
      "conditional": [{ "range": "D2:D50", "when": ">", "value": 1000, "fill": "C6EFCE" }],
      "charts": [{ "type": "column", "data": "D1:D3", "categories": "A2:A3", "at": "I2", "title": "Revenue" }],
      "print": { "landscape": true, "fit_width": true, "title_rows": "1:1" }
    }
  ]
}
```

Top level: `sheets` (a list, at least one), and optionally `names` (name to what it refers to: a reference such as
`Inputs!$B$1` or a formula) and `properties` (`title`, `subject`, `creator`, `keywords`).

Each sheet takes:

| Key           | Takes                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`        | up to 31 characters, none of `\ / ? * [ ] :`, unique (default Sheet1, Sheet2…)                                                                         |
| `rows`        | a list of rows, each a list of cells, written from `start` (default `"A1"`)                                                                            |
| `header`      | `true`: the first row is bold with a line under it, the sheet freezes below it and gets a filter over the rows (left to a table where one covers them) |
| `cells`       | cell address to cell, for anything outside `rows`                                                                                                      |
| `formats`     | range to style keys: `{"C2:D9": {"number_format": "#,##0.00"}}`                                                                                        |
| `widths`      | `"auto"` (default, from the longest entry in each column) or `{"A": 18}`, at most 255                                                                  |
| `freeze`      | the first cell that scrolls: `"A2"` keeps row 1 in view, `"B2"` row 1 and column A                                                                     |
| `filter`      | a range for the sheet's filter buttons (not over a table, which has its own)                                                                           |
| `merge`       | ranges to merge; put the value in the top-left cell                                                                                                    |
| `tables`      | `[{"name": "Sales", "range": "A1:D9", "style": "TableStyleMedium2", "striped": true}]`                                                                 |
| `validations` | drop-downs and limits, below                                                                                                                           |
| `conditional` | conditional formats, below                                                                                                                             |
| `charts`      | charts, below                                                                                                                                          |
| `print`       | `landscape`, `fit_width` (one page wide), `paper` (`A4`, `A3`, `letter`, `legal`), `title_rows` (`"1:1"` repeats row 1 on every page), `area`          |
| `protect`     | `true`, or `{"password_file": "pw.txt", "unlocked": ["B2:B9"]}`: the sheet is locked except the unlocked ranges                                        |
| `tab_color`   | a hex colour                                                                                                                                           |
| `hidden`      | `true` hides the sheet (one at least must show)                                                                                                        |

**Tables.** A table's first row holds its headings: text, none empty, none repeated. It needs a row under them, a name
that starts with a letter or `_` with no spaces and isn't like a cell address (`Q3` isn't allowed, `Q3_Sales` is),
unique in the workbook, and it can't overlap another table or merged cells. Formulas can then use `Sales[Revenue]`.

**Validations.** Each has a `range` and one rule:

| Rule                                      | Allows                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| `"list": ["Open", "Done"]`                | a drop-down of these choices (together at most 255 characters, no commas inside a choice) |
| `"source": "Lists!$A$2:$A$40"`            | a drop-down of the values in a range, for long or changing lists                          |
| `"whole": [0, 1000]`, `"decimal": [0, 1]` | numbers between the two                                                                   |
| `"date": ["2026-01-01", "2026-12-31"]`    | dates between the two                                                                     |

Options: `allow_blank` (default `true`), `prompt` (shown when the cell is picked), `error` (shown when a wrong value is
refused; anything that breaks the rule is refused).

**Conditional formats.** Each has a `range`, one test, and how to mark the cells (`fill`, `font_color`, `bold`):

| Test                                      | Marks                                                                                           |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `"when": ">", "value": 1000`              | cells compared with a value: `>`, `>=`, `<`, `<=`, `=`, `!=`, or `"between"` with `[low, high]` |
| `"formula": "$E2=\"Done\""`               | cells where the formula is true, written for the range's first row (`$` fixes the column)       |
| `"scale": ["F8696B", "FFEB84", "63BE7B"]` | a colour scale, lowest to highest (two or three colours; no marks needed)                       |

**Charts.** Each has `type` (`column`, the default, `bar`, `line`, `area`, `pie`, `scatter`), `data` and `at` (the
cell for its top-left corner).

- `data` is one column per series with the series' name in its first row: `"D1:D9"`, or `"B1:D9"` for three series.
  It may name another sheet: `"Data!B1:D9"`.
- `categories` is the labels along the axis without a heading (`"A2:A9"`); for `scatter`, give `x` instead, the x
  values (`"B2:B9"`).
- `title`, `x_title`, `y_title`; `width` and `height` in centimetres (default 15 by 7.5); `stacked: true` for column,
  bar and area.

**Passwords.** `protect` reads a password from `password_file` (its first line; the path is relative to the spec) or
from the environment variable named in `password_env`, never from the spec, and never prints it. It stops slips, not
people (see SKILL.md).

## The change list

```json
{
  "changes": [
    { "do": "set", "sheet": "Data", "cells": { "C2": 2.75, "E1": "Note", "H2": "=SUM(D2:D9)" } },
    { "do": "append", "table": "Sales", "rows": [["West", 40, 5, "=B10*C10"]] },
    { "do": "format", "sheet": "Data", "range": "C2:C9", "number_format": "#,##0.00" },
    { "do": "rename_sheet", "sheet": "Data", "to": "Sales data" }
  ]
}
```

Changes run in order, each on the workbook as the ones before it left it. `sheet` can be left out when the workbook
has one sheet.

| `do`           | Keys                         | What it does                                                                                                                                                                                                  |
| -------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `set`          | `sheet`, `cells`             | writes cells; setting a table's header cell renames that table column (it must be text); only a merged range's top-left cell can be set                                                                       |
| `append`       | `sheet`, `rows`              | writes rows under the last filled row, from column A                                                                                                                                                          |
| `append`       | `table`, `rows`              | writes rows under a table, styled like its last row, and grows the table; refused when the table has a totals row or the rows under it aren't empty (insert rows with `restructure`, then `set` them)         |
| `format`       | `sheet`, `range`, style keys | restyles every cell in a range like `C2:C9` (give corners, not whole columns)                                                                                                                                 |
| `widths`       | `sheet`, `columns`           | `{"A": 20, "B": 12}`, at most 255                                                                                                                                                                             |
| `freeze`       | `sheet`, `at`                | `"A2"`, or `null` to unfreeze                                                                                                                                                                                 |
| `rename_sheet` | `sheet`, `to`                | renames it and every reference to it: formulas, names, validations, conditional formats, table formulas, chart data, links. Text inside INDIRECT isn't changed: the result lists those cells as `not_updated` |
| `add_sheet`    | `sheet`, `position`          | a new empty sheet; `position` counts from 1 (default: last)                                                                                                                                                   |
| `name`         | `name`, `refers_to`, `sheet` | a defined name for the whole workbook, or for one sheet when `sheet` is given                                                                                                                                 |

`edit` loads the workbook keeping rich text and, for an .xlsm, its macros, and saves with Excel told to recalculate on
opening. Inserting or deleting rows and columns is `restructure`'s job, not `edit`'s.
