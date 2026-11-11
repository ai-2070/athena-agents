# Conventions every model shares

The rules here hold for all five model types. Each model's own reference adds its layout and checks.

## What may be typed in

Three kinds of number are typed; everything else is a formula.

- **Historicals**: reported figures (revenue, the last balance sheet). Source: the filing, the page or table, the date
  you took it.
  `Source: 10-K FY2025, Consolidated Balance Sheets, p. 52; accession 0000000000-26-000000; taken 2026-11-04`.
- **Assumptions**: growth, margins, the exit multiple, the tax rate. Say why and who agreed:
  `Assumption: base case growth, user's guidance in chat, 2026-11-04`.
- **Market data**: share price, bond yields, beta. Say where and as of when:
  `Source: price from the user, close 2026-11-03`.

The date matters because every one of these goes stale. An input with no source is a guess nobody can check, so add the
comment when you write the cell, not at the end. A missing input stays blank (not zero, which looks like data), and a
check counts the blanks so the model can't pass while something is missing.

Numbers that are conventions rather than data (12 months, 365 days, a half-year for mid-year discounting, 100 to turn
a fraction into a percent) may sit inside formulas. `check_model.py` allows 0, 0.5, 1, 2, 4, 12, 100, 360, 365, 1000
and 1,000,000, and any number that is a whole argument of a function such as INDEX, MATCH, ROUND or QUARTILE (a row, a
decimal place, a quartile). Anything else typed into a formula (`=B5*1.05`) belongs in an input cell; `--allow` adds a
number the user's house style treats as a convention.

## Colours

| Cell                                                                                                           | Font colour | Hex      |
| -------------------------------------------------------------------------------------------------------------- | ----------- | -------- |
| Input: a typed historical, assumption or market figure                                                         | Blue        | `0000FF` |
| Formula                                                                                                        | Black       | `000000` |
| Link: a formula that only fetches one cell or range from another sheet (`=Inputs!C5`, or a name defined there) | Green       | `008000` |

Use one scheme throughout, the user's template's if it has its own (then pass its colours to `check_model.py` with
`--input-color` and `--link-color`). Font colour says what a cell is; fills are optional and quiet (a pale grey behind
inputs, bold for key outputs). Fonts coloured from the theme palette can't be checked by the script, so set explicit
colours.

## Layout

- **Sheets**: Inputs (every typed assumption and market figure, scenario blocks), then the model sheets in calculation
  order, then grids, then Checks. Historicals can sit on the model sheets in their own columns, styled as inputs.
- **Time runs across, line items down.** One timeline: the same column is the same period on every sheet. Historical
  and forecast columns are marked in the header ("FY2025A", "FY2026E") as text, not as numbers.
- **Labels in column B, units stated** in the header or a units column ("USD m", "x", "%", "per share").
  One unit per sheet for amounts; per-share and percentage rows say so, and are never summed with totals. Figures that
  arrive in other units (a filing in units, a peer in thousands) are converted once, in a formula, by a labelled input.
- **Fix the rows before writing formulas.** Keep a map of names to rows in the build script and write every formula
  from it. Adding a line later means changing the map and rerunning the script, not inserting a row by hand.

```python
from openpyxl.utils import get_column_letter as letter

ROW = {"revenue": 10, "ebit": 11, "taxes": 12}      # fixed before any formula is written
for c in range(5, 10):                              # forecast years in columns E to I
    this, prev = letter(c), letter(c - 1)
    ws[f"{this}{ROW['revenue']}"] = f"={prev}{ROW['revenue']}*(1+Inputs!{this}52)"
    ws[f"{this}{ROW['ebit']}"] = f"={this}{ROW['revenue']}*Inputs!{this}53"
    ws[f"{this}{ROW['taxes']}"] = f"={this}{ROW['ebit']}*TaxRate"
```

- **Number formats**: `#,##0;(#,##0);"-"` for amounts, `0.0%` for rates, `0.0"x"` for multiples, `0.00` for per-share
  values. Negatives in brackets is the usual reading in finance; follow the user's template if it differs.

## openpyxl patterns

```python
from openpyxl import Workbook
from openpyxl.comments import Comment
from openpyxl.styles import Font
from openpyxl.workbook.defined_name import DefinedName
from openpyxl.worksheet.datavalidation import DataValidation

INPUT, FORMULA, LINK = Font(color="0000FF"), Font(color="000000"), Font(color="008000")

def put_input(ws, ref, value, source):
    ws[ref] = value
    ws[ref].font = INPUT
    ws[ref].comment = Comment(source, "Athena")

def put_formula(ws, ref, formula, link=False):
    ws[ref] = formula                      # a string starting with "="
    ws[ref].font = LINK if link else FORMULA

wb = Workbook()
inputs = wb.active
inputs.title = "Inputs"
put_input(inputs, "C8", 0.25, "Assumption: statutory rate the user gave, 2026-11-04")
wb.defined_names["TaxRate"] = DefinedName("TaxRate", attr_text="Inputs!$C$8")

put_input(inputs, "C4", 2, "Case selector: 1 bear, 2 base, 3 bull; base chosen by the user, 2026-11-04")
pick = DataValidation(type="list", formula1='"1,2,3"', allow_blank=False)
inputs.add_data_validation(pick)
pick.add("C4")
wb.defined_names["Case"] = DefinedName("Case", attr_text="Inputs!$C$4")
wb.save("model.xlsx")
```

- **Functions.** openpyxl writes the formula text as given. Functions added after Excel 2007 are stored with an `_xlfn.`
  prefix (Microsoft's MS-XLSX "future functions" list: XLOOKUP, IFS, QUARTILE.INC, STDEV.S, TEXTJOIN, LET and more);
  written without it they show `#NAME?` in Excel and LibreOffice alike. Prefer the older equivalents (INDEX/MATCH,
  QUARTILE, STDEV, nested IF), or write `=_xlfn.XLOOKUP(...)`. Leave out the dynamic-array functions (FILTER, SORT,
  UNIQUE, SEQUENCE).
- **Lookups** take an exact match: `MATCH(x, range, 0)` or `VLOOKUP(x, table, col, FALSE)`. The default approximate
  match returns the wrong row in unsorted data and raises no error.
- **Dates** for XIRR, EDATE and YEARFRAC are real dates (`datetime.date`) typed as inputs, or formulas from one input
  date: `=EDATE(C6,12)`.
- **Merged header cells**: set the value on the top-left cell, then merge.

## Scenarios

Put each case's assumptions in its own block on Inputs, years across, the same rows in the same order. A selected row
pulls the active case, and the model reads only that row:

```
Inputs!E52   =CHOOSE(Case, E31, E38, E45)        bear block row 31, base 38, bull 45
DCF!E12      =D12*(1+Inputs!E52)
```

When the cases sit side by side in columns instead, `=INDEX(C31:E31, 1, Case)` does the same. Show the active case's
name at the top of each sheet (`=CHOOSE(Case,"Bear","Base","Bull")`). A case number outside the choices makes CHOOSE
return `#VALUE!`, which the error scan catches; a drop-down on the selector prevents it.

## The Checks sheet

One labelled row per check, one column per period where the check is per period, each cell a TRUE/FALSE formula.
Compare amounts with a tolerance input, not an exact `=`, because floating-point sums rarely match to the last digit:

```
Checks!C3   =ABS(BS!E40-BS!E62)<Tol                assets equal liabilities plus equity
Checks!C4   =COUNTBLANK(Inputs!C5:C30)=0           every input filled in (a range with no label gaps)
Checks!C12  =AND(C3:H11)                           all checks
```

`Tol` is a named input, a small amount in the model's unit, labelled as a convention. What to check for each model is in
its reference. `check_model.py` fails when any formula on the Checks sheet gives FALSE or an error, or when none gives
TRUE/FALSE at all.

## Sensitivity grids

- **Odd size**, 5×5 or 7×7, so there's a true centre, and the base case is the centre.
- **Axes are formulas.** The centre header links to the model's own assumption and the others step from it with a
  step input: `E40 =TermGrowth`, `D40 =E40-GrowthStep`, `F40 =E40+GrowthStep`. Typed axis values drift from the model
  as soon as an assumption changes.
- **Each cell recomputes.** Use mixed references, row value from `$B41`, column value from `C$40`, and write the whole
  chain from those two values to the output. When the chain is short (WACC and growth only touch the discounting) one
  formula per cell does it; `dcf.md` and `lbo.md` show them. When the varied input changes the forecast itself (growth,
  margins, the cash/stock mix), give each grid point its own column on a helper sheet that repeats the few rows that
  change, and have the grid cell read the result (`merger.md` does this).
- **A check that the centre equals the model**: `=ABS(DCF!E43-DCF!D42)<Tol`.
- **Guard the impossible corners**: `=IF($B41<=C$40,"n/m",...)` where a discount rate would fall to or below growth.
- **Not Excel data tables.** openpyxl can write them (`DataTableFormula`) and Excel calculates them, but LibreOffice
  (tested with 24.8) reads them without calculating, and its recalculated copy saves them broken, so nothing here can
  check them. `soffice.py recalc` warns when it meets one.

## Circular references

Most loops come from interest on the average balance (interest → cash → repayment → balance → interest) or a fee sized
on the debt that pays for it. Prefer, in order:

1. Interest on the opening balance. No loop, and the difference is small for annual periods.
2. Solve the loop algebraically: debt that also funds its own fee `f` is `=Need/(1-f)`.
3. Iterative calculation, when the user wants average balances: `wb.calculation.iterate = True`,
   `wb.calculation.iterateCount = 100`, `wb.calculation.iterateDelta = 0.0001`, plus a named switch
   `=IF(AvgInterest=1, Rate*(D30+D33)/2, Rate*D30)`. If an error ever gets trapped in the loop, set the switch to 0,
   let it recalculate, then set it back to 1. LibreOffice honours the iterate setting from the file.

## Reading recalc's errors

`soffice.py recalc` runs LibreOffice headless with a throwaway profile set to recalculate everything on load, so every
result is worked out afresh rather than taken from the file. Fix the first cause of an error chain; the cells downstream
usually clear with it. `#VALUE!` on cells that refer to each other is usually an unintended loop (above).
