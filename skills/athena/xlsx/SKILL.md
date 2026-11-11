---
name: Excel workbooks
description: Use for work on an Excel file or a CSV, such as "read this .xlsx", "edit this spreadsheet", "insert a row without breaking formulas", "convert CSV to Excel" (or back), "make a workbook", "recalculate", or totals showing #REF!. Looks first, writes a new file, recalculates and reads it back.
---

An .xlsx file is a zip of XML: cell values, formulas stored as text, styles, and the tables, charts and names Excel
keeps around them. Python's openpyxl reads and writes that XML but never calculates, and when it saves a file it
rebuilds it from what it understands, so anything it doesn't understand is left out. Good work looks inside before
choosing a route, writes a new file and leaves the user's workbook alone, moves every reference when rows or columns
move, recalculates and reads the numbers back before quoting them, and says plainly what didn't survive.

## Before you start

- **Python 3.10 or newer with openpyxl 3.1 or newer**, and Pillow when the workbook has pictures (without it openpyxl
  drops them). Check with `python -c "import openpyxl; print(openpyxl.__version__)"` (`py` instead of `python` on
  Windows if `python` isn't found). Installing is the user's call: ask, then `python -m pip install openpyxl pillow`.
- **LibreOffice, to recalculate.** `python <skill folder>/scripts/soffice.py find` says where it is, or how to install
  it (ask first). Without it you can still build and edit, but say that no result was calculated or checked.
- **The scripts** are in this skill's folder (its path comes with the skill): `python <skill folder>/scripts/<name>.py`.
  Every command has `--help` and prints JSON. Exit code 0 means done; 1 that it ran and found problems, which the JSON
  lists; 2 that it couldn't do the job, with the reason in one line on stderr. A command that writes needs `-o`, and
  `-o` is never its input.
- **JSON inputs** (a change list, a spec) go in files you write with your file tools, not in an `echo`: Windows
  PowerShell 5.1 strips the quotes.
- **Where files go.** Specs, change lists, intermediate steps and recalculated copies go in an `xlsx-work` folder in
  the workspace, deleted before you reply. The user's folder ends with what they asked for, plus a backup if you
  replaced their file: no build scripts, CSV leftovers or `-calc` copies. Look for a file the user names in the
  workspace; if it isn't there, ask rather than search their home folder.
- **Neighbours.** Valuation and deal models (DCF, LBO, three statements) follow the `financial-models` skill, which
  builds on this one. When the user has Storytold's `gridcraft` app, it is the better route for what needs a live
  spreadsheet engine: pivot tables, formulas that spill, goal seek, .xls or .xlsb files, or seeing a sheet as Excel
  draws it.

## Look first

```
python <skill folder>/scripts/xlsx_tool.py info budget.xlsx
```

- `results`: `saved` means formulas carry the results a spreadsheet program last saved; `missing` or `partly saved`
  means the file was written by a program that doesn't calculate, and every unsaved result reads as empty.
- `would_lose_on_save`: what openpyxl would leave out if it saved this file (drawn shapes and text boxes, slicers,
  form controls, threaded comments, sparklines, chart styles). Charts, tables, names, notes and validations survive.
- `macros`, hidden sheets and rows, `merged`, `tables`, `names`, `protected`, `saved_errors`.

| The job                                                               | Route                                                                  |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Read values or formulas                                               | `xlsx_tool.py read`; recalculate a copy first when results are missing |
| Change cells, append rows, rename a sheet, set formats, names, widths | `xlsx_tool.py edit` with a change list                                 |
| Insert or delete rows or columns                                      | `xlsx_tool.py restructure`, one operation per run                      |
| CSV to workbook, or back                                              | `xlsx_tool.py from-csv`, `to-csv`                                      |
| A new workbook                                                        | `xlsx_create.py` with a JSON spec                                      |
| Check formulas, get current results                                   | `soffice.py recalc` into `xlsx-work`, then `read` the copy             |
| Compare two versions                                                  | `xlsx_tool.py diff`                                                    |

`references/create-spec.md` has the spec and the change list; `references/restructuring.md` has the rules of moving.

## How to do it well

### Formulas and their results

- Write formulas, not numbers Python worked out (`=B2*C2`, not `25`), so the sheet stays right when an input changes.
- A result exists only when a spreadsheet program saved it. A file saved by openpyxl, these scripts included, holds
  none; the scripts set the flag that has Excel recalculate on opening, but previews and other programs see blanks.
- Never save a workbook loaded with `data_only=True`: every formula becomes its last value, or nothing.
- Functions newer than Excel 2007 are stored with an `_xlfn.` prefix (`=_xlfn.XLOOKUP(...)`, `_xlfn.IFS`,
  `_xlfn.TEXTJOIN`); without it Excel and LibreOffice show `#NAME?`. `edit` and `xlsx_create.py` list any unknown
  function. openpyxl can't write the cell metadata Excel keeps for formulas that spill, so leave out FILTER, SORT,
  UNIQUE and SEQUENCE, or use `gridcraft`.

### Changing a workbook someone already has

Keep their layout and look; change only what was asked. An .xlsm stays .xlsm, with its macros carried over. `edit`
covers most changes and avoids openpyxl's traps. For a bigger job write your own script in `xlsx-work`: load with
`load_workbook(path, rich_text=True)` (plus `keep_vba=True` for .xlsm) or bold and coloured words inside a cell are
flattened. In your own code, text starting with `=` becomes a formula unless you then set `cell.data_type = "s"`;
`ws.title = "New"` renames without fixing a single reference (use `edit`'s `rename_sheet`); only a merged range's
top-left cell takes a value; a table's header cells must match its column names; and `insert_rows` or `delete_cols`
move cells and nothing that points at them.

### Inserting and deleting rows or columns

Use `restructure`. It moves the cells, then every formula on every sheet, defined names, merged ranges, tables (a
column inserted inside a table becomes a table column), validations and their lists, conditional formats, filters,
frozen panes, print areas and titles, row heights and column widths. It does one operation per run; chain several
through files in `xlsx-work`. Read its result:

- `ref_errors`: formulas that pointed at deleted cells and now hold `#REF!`, as Excel would leave them.
- `not_shifted`: chart data ranges (with what each should now be), charts and pictures still anchored at their old
  cell, INDIRECT text, 3-D references and pivot tables. Each needs a fix or a word to the user;
  `references/restructuring.md` says how.
- `cells_deleted`: how many filled cells a delete removed. Say the number when you report.

### CSV

- Excel saves "CSV UTF-8" with a byte-order mark, plain "CSV" in the computer's ANSI code page (cp1252 in Western
  Europe), and "Unicode text" as UTF-16 with tabs. `from-csv` reads each by its mark and falls back to the ANSI code
  page; `--encoding cp1250` (or another) names the right one when accents come out wrong.
- Where the decimal mark is a comma, Excel writes `;` between fields and numbers like `1.234,5`. `from-csv` guesses
  both and says so (`decimal: comma (guessed)`); check a number in the result, and set `--delimiter` and `--decimal`
  when the guess is wrong. `ragged_rows` usually means the wrong delimiter.
- It keeps as text what would be damaged as a number: leading zeros (postcodes, IDs), whole numbers over 15 digits
  (Excel keeps 15 significant digits, so card and account numbers lose their tail), and text starting with `=`.
  Dates like 03/04/2026 stay text until `--dates dmy` or `--dates mdy` gives the order; ask the user if the file
  doesn't settle it. `--text-columns "ID,Phone"` keeps whole columns as text.
- `to-csv` writes one sheet's saved results, as stored rather than as displayed (12.5% is `0.125`, dates are ISO).
  It exits 1 when formulas have no saved result: recalculate first. For a CSV someone will open in Excel, use
  `--encoding utf-8-sig`, and in comma-decimal countries `--delimiter ";" --decimal comma`.

### Recalculating and reading back

```
python <skill folder>/scripts/soffice.py recalc budget.xlsx -o xlsx-work/budget-calc.xlsx
python <skill folder>/scripts/xlsx_tool.py read xlsx-work/budget-calc.xlsx --sheet Summary --range A1:F30
```

`recalc` lists error cells with their formulas and a hint for each kind of error; it doesn't calculate Excel data
tables (What-If Analysis), and warns when it meets one. Quote figures from the recalculated copy, never from memory
or your own arithmetic. Hand back openpyxl's file for a workbook the user gave you, since LibreOffice's copy rewrites
formulas and can drop Excel features; for a workbook you built, the recalculated copy is fine to hand over (previews
then show numbers) once `info` shows its formats and names intact.

### Protection

Sheet protection guards against slips, not people: openpyxl stores its password as a short legacy hash, and other
tools ignore it. A password to open a file is set by the user in Excel (File, Info, Protect Workbook, Encrypt with
Password); a workbook that has one can't be read here, so ask for an unprotected copy.

## Steps for changing the user's workbook

1. Run `info`. If `would_lose_on_save` holds something the user cares about, say so before writing and offer another
   route (they make the change in Excel, or `gridcraft`). If this is a fix, show the wrong cell, its formula and why
   it's wrong before changing anything.
2. Back up once, as a step of its own: copy the file beside itself as `<name>-backup.xlsx` (keeping `.xlsm` for a
   macro workbook). If that name is taken, leave that file alone and pick another; it may be the only original.
3. Work from the backup: each step writes into `xlsx-work`, and the last writes to the user's original name. Running
   the steps again rebuilds the same result instead of applying them twice.
4. Recalculate the result into `xlsx-work` and read back the cells you changed and the totals that depend on them.
5. `xlsx_tool.py diff <backup> <result>`: the changes asked for are there, nothing else changed, and the backup
   still differs. If the backup already shows the change, it was made too late; say the original is gone.
6. Delete `xlsx-work`.

## Done means

- `recalc` shows no error cells the original didn't have, and the figures in your reply come from that copy.
- Every exit code 1 item (`ref_errors`, `not_shifted`, `lost_on_save`, `formula_problems`, `ragged_rows`) is fixed or
  told to the user in plain words.
- When the user stressed something ("every sheet", "all the totals"), all of it was checked, not a sample.
- The reply says where the new file is, that the original is unchanged or where its backup is, what changed, and
  what wasn't checked (no LibreOffice) or couldn't be kept.

## Watch out for

- Hidden sheets, rows and columns, and filtered-out rows: still data, and `read` and `to-csv` include them. A date
  is a number with a date format: 45322 in a date column is a date that lost its format, not a count.
- A CSV opened in Excel runs any field starting with `=`, `+`, `-` or `@` as a formula; warn before passing on a CSV
  built from outside data.
- Sending, uploading or sharing a workbook is the user's call. Ask first.

## Files

- `scripts/xlsx_tool.py`: `info`, `read`, `diff`, `to-csv`, `from-csv`, `edit` (a JSON change list) and
  `restructure`. `xlsx_tool.py <command> --help` explains each one.
- `scripts/xlsx_create.py`: a new workbook from a JSON spec; `--help` shows the spec.
- `scripts/soffice.py`: finds LibreOffice, recalculates a workbook into a copy and lists its error cells
  (`recalc`), and converts files (`convert old.xls --to xlsx -o new.xlsx`, or `--to pdf` to look at a sheet).
  `--soffice <path>` points at a LibreOffice outside the usual folders; `convert` and `recalc` take `--timeout
<seconds>` (default 180), and `recalc` takes `--limit <n>` error cells to list (default 100).
- `references/create-spec.md`: every key of the spec and of `edit`'s change list. Open it before writing either.
- `references/restructuring.md`: how references move on insert and delete, and how to fix what a restructure lists
  as not moved. Open it whenever its result lists anything.
