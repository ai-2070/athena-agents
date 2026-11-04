# Inserting and deleting rows and columns

`xlsx_tool.py restructure` does one insert or one delete of whole rows or columns on one sheet, then moves everything
in the workbook that points at the cells that moved. openpyxl's own `insert_rows`, `delete_rows`, `insert_cols` and
`delete_cols` only move cells: every formula, name, merged range and table outside them keeps its old address, which
is how a total quietly stops counting its last row. Checked in November 2026 against openpyxl 3.1.5 and LibreOffice
24.8.

```
python <skill folder>/scripts/xlsx_tool.py restructure budget.xlsx --sheet Data --insert-rows 5 --count 2 -o xlsx-work/step1.xlsx
python <skill folder>/scripts/xlsx_tool.py restructure xlsx-work/step1.xlsx --sheet Data --delete-cols F -o xlsx-work/step2.xlsx
```

`--insert-rows ROW` inserts before that row; `--delete-rows ROW` deletes from it; `--insert-cols` and `--delete-cols`
take a letter (`F`) or a number (`6`). `--count` says how many (default 1). `--sheet` is needed when the workbook has
more than one sheet. Run several operations as separate steps, in the order the user described them, because each
one changes the addresses the next one means: "insert a row above row 5, then delete row 9" means row 9 as it was, so
delete row 10 after the insert, or delete first.

## What moves

| What | Where | How |
|---|---|---|
| Cell formulas, array formulas | every sheet | references into the changed sheet move; text in quotes and table references don't need to |
| Defined names | workbook and sheet scope | as formulas |
| Data validations | every sheet | their list sources move; their ranges on the changed sheet move |
| Conditional formats | every sheet | their rule formulas move; their ranges on the changed sheet move |
| Merged ranges | changed sheet | move, grow, shrink; a range cut to one cell is unmerged |
| Tables | changed sheet | range, filter and sort move; a column inserted inside one becomes a table column named Column1, Column2… |
| Filter, sort, frozen panes, print area, print titles, page breaks | changed sheet | move with their rows or columns |
| Row heights, column widths, hidden rows and columns, outline levels | changed sheet | move |
| Notes and links | changed sheet | move with their cells; links to a place in the workbook point at the moved cell |

## How a reference moves

The rules are Excel's own.

- **Insert N at position P**: every row (or column) at P or after moves down (or right) by N. A range that starts
  before P and ends at or after it grows by N. A range that ends just above P doesn't grow: inserting at row 5 leaves
  `SUM(D2:D4)` alone, and inserting at row 3 makes it `SUM(D2:D6)` (with N = 2).
- **Delete N from P**: rows after the deleted block move up by N. A range that loses part of itself shrinks. A single
  cell that was deleted, or a range that was deleted whole, becomes `#REF!`.
- `$` signs don't matter: absolute and relative references both move, and keep their `$`.
- Whole columns (`B:B`) don't change when rows move; whole rows (`3:5`) don't change when columns move.
- A reference stops at the sheet's edge (row 1,048,576, column XFD). An insert that would push filled cells past it
  is refused.
- A table can't lose its header row or all of its rows: such a delete is refused. Delete all of the table's rows to
  remove it, or delete rows inside it.

## Reading the result

| Key | What it says |
|---|---|
| `did` | the operation, in words |
| `formulas`, `formulas_changed` | up to 100 changed formulas with before and after, and the total |
| `names`, `validations`, `conditional_formats`, `merges`, `tables`, `other` | each range or formula that changed, `to: null` when it went |
| `filter`, `freeze`, `print_area`, `print_titles` | before and after, when they changed |
| `cells_deleted` | filled cells a delete removed |
| `ref_errors` | formulas and names that now hold `#REF!` because what they pointed at was deleted |
| `not_shifted` | what the script didn't move (below) |
| `lost_on_save` | what openpyxl left out when it saved (shapes, slicers…), as `info` warned |

Exit code 1 means at least one of `ref_errors`, `not_shifted` or `lost_on_save` has something in it. Fix it, or tell the
user in plain words what still points at the old place.

`ref_errors` after a delete are usually right: the user deleted what the formula needed. Name the cells in your reply,
and ask whether they should point somewhere else. Excel would leave the same `#REF!`.

## Fixing what wasn't moved

**Charts.** Their data ranges and their position stay as they were. The result gives each chart's `data` as `now` and
`should_be`, and `position` when the chart sat at or after the change. Fix them in a step of your own:

```python
from openpyxl import load_workbook

FIXES = {"'Data'!$D$2:$D$4": "'Data'!$D$4:$D$6"}  # "now": "should_be", from the result
ROWS_MOVED = 2                                    # for a chart below an insert on its own sheet

wb = load_workbook("xlsx-work/step1.xlsx", rich_text=True)  # keep_vba=True as well for an .xlsm
for ws in wb.worksheets:
    for chart in ws._charts:  # openpyxl keeps a sheet's charts here; there is no public list
        for s in chart.series:
            for source in (s.val, s.cat, s.xVal, s.yVal, s.tx):
                for ref in (getattr(source, "numRef", None), getattr(source, "strRef", None)):
                    if ref is not None and ref.f in FIXES:
                        ref.f = FIXES[ref.f]
        if ws.title == "Data":
            chart.anchor._from.row += ROWS_MOVED  # counted from 0
            if getattr(chart.anchor, "to", None) is not None:
                chart.anchor.to.row += ROWS_MOVED
wb.save("xlsx-work/step2.xlsx")
```

For columns, change `.col` instead of `.row`. Pictures are in `ws._images`, with the same kind of anchor. Run `info` on
the result afterwards and check the chart count hasn't changed.

**INDIRECT.** `INDIRECT("Data!D3")` builds its reference from text, which no insert changes, in Excel or here. Read
each listed formula and decide with the user whether the text should change.

**3-D references** (`SUM(Jan:Dec!B5)`) span several sheets and aren't moved: the other sheets in the span didn't
change. Ask the user whether those sheets should get the same insert or delete, and run it on each.

**Pivot tables** keep their source range and their place. If the source range moved or grew, the user changes it in
Excel (PivotTable Analyze, Change Data Source) and refreshes. If the pivot table sits below or right of the change, it
didn't move with the cells around it.

**Excel data tables** (What-If Analysis) keep their input cells; rebuild them in Excel.

**Formulas the script couldn't read** are left as they were. Read them and fix them by hand.

## What it doesn't do that Excel does

- New rows and columns are empty and unformatted. Excel gives them the format of the row above or the column to the
  left; if that matters, copy it in an `edit` step (`format`, or `set` with style keys).
- Formulas in other workbooks that point into this one aren't changed: they live in those files. If the user has
  linked workbooks, say so.
- It doesn't recalculate. Run `soffice.py recalc` on the last step and check its error cells against the original's.
