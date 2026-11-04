---
name: Financial models
description: Use when asked to build, fix, check or audit a financial model in Excel (DCF, LBO, three-statement, comps, merger or accretion/dilution), to value a company, or when a model doesn't balance or gives wrong numbers. Builds or repairs live-formula workbooks with sourced inputs and a Checks sheet.
---

For valuation and deal models built as Excel workbooks with Python and openpyxl: discounted cash flow, leveraged buyout,
linked three-statement, comparable companies and merger (accretion/dilution); and for finding and fixing what's wrong
in a model someone already has. A good model is one someone else can audit and change. Every result is a live formula,
so changing an assumption changes the answer. Every typed number is a historical figure, an assumption or a market
price, coloured as an input and carrying a dated source. A Checks sheet of TRUE/FALSE ties proves the pieces agree.
The sensitivity grids really recalculate. And the file has been recalculated and scanned for errors before anyone
sees it.

## Before you start

- **Python with openpyxl 3.1 or newer.** Check with `python -c "import openpyxl; print(openpyxl.__version__)"` (on
  Windows the launcher may be `py`). If it's missing or older, ask before installing:
  `python -m pip install --upgrade openpyxl`.
- **LibreOffice, to recalculate.** openpyxl writes formulas but never calculates them, so the file holds no results
  until a spreadsheet program opens it. `python <skill folder>/scripts/soffice.py find` says where LibreOffice is, or
  how to install it. Installing is the user's call. Without it you can still build the model, but say plainly that it
  hasn't been calculated or checked; Excel calculates it when the user opens it.
- **The scripts** are in this skill's `scripts/` folder. Run them in a shell as
  `python <skill folder>/scripts/<name>.py` (the same in PowerShell and a POSIX shell; quote the path if it has
  spaces). "Recalculate and audit" below gives their commands, options and exit codes.
- **Where files go.** The user's folder ends with the model they asked for, plus a backup if you changed their file,
  and nothing else. Build scripts, fix scripts and recalculated copies go in a scratch folder inside the workspace
  (`model-work/` in the commands here), never beside the model, in a temp folder or outside the workspace, and you
  delete it before you report. The build script is scratch too, unless the user asks to keep it.
- **The brief.** Settle these before building, in one message or with the ask-the-user tool:
  - the question the model answers ("what is it worth?", "does the deal add to earnings?", "can it carry this debt?");
  - the company or deal, the currency and units, the last actual period and how many years to forecast;
  - whether the user has a template, house style or an existing model: if so, work in theirs, as "Fixing or checking"
    below describes (the xlsx skill covers restructuring a workbook);
  - which inputs the user will supply, and which you should look up.
- **The data.** The user's own figures come first. For US-listed companies, the SEC's EDGAR APIs give the filed numbers
  (`references/filings.md`); the pdf skill reads a filing or a deck the user hands you; a current share price can come
  from the user or the stocks skill. Consensus estimates and paid data sets come only from the user's own sources.
  A number you can't find stays blank and goes on the list of missing inputs: never invent one, and never fill a
  gap with a "typical" figure without saying so and getting the user's agreement.

## How to do it well

**Pick the model for the question.**

| Question | Model | Read |
|---|---|---|
| What is the business worth on its own cash flows? | DCF | `references/dcf.md` |
| What could a financial buyer pay, and what would it earn? | LBO | `references/lbo.md` |
| How do earnings, balance sheet and cash move together? Can it fund itself? | Three-statement | `references/three-statement.md` |
| What do similar companies trade at? | Comparable companies | `references/comps.md` |
| Does buying the target raise or lower the buyer's earnings per share? | Merger | `references/merger.md` |

They combine: a DCF often sits on a three-statement forecast, and comps give the exit multiple for a DCF or an LBO.
Read `references/conventions.md` before building or changing any of them; it holds the detail of the rules below.

**Write formulas, never results.** Python lays out the workbook; the spreadsheet's formulas do the arithmetic. Write
`ws["E12"] = "=D12*(1+E5)"`, not a number Python worked out. A computed value pasted in looks right today and silently
stops matching the moment an input changes.

**The shared conventions**, a line each here and in full in `conventions.md`:

- Blue font for inputs, black for formulas, green for links to other sheets, so a reader sees what they may change.
- Sheets, period columns and a row for every line item fixed before any formula, and formulas written from a map of
  names to rows: inserting rows after the formulas exist is how references end up on the wrong line.
- A defined name (`WACC`, `TaxRate`, `Case`) for any figure used on another sheet: readable, and it survives layout
  changes.
- One case selector and a "selected" row that everything downstream reads, so one cell switches bear, base and bull.
- A Checks sheet of labelled TRUE/FALSE ties. A FALSE means the model is wrong somewhere: find the break rather than
  loosen the check.
- Sensitivity grids of ordinary formulas around the base case, never Excel data tables, which LibreOffice doesn't
  calculate, so nothing here could check them.

**Check in on big models.** For a full DCF, LBO or three-statement model, show the user the inputs block before
forecasting, the forecast before valuing, and the valuation before the grids. A wrong margin found after the grids are
built costs the most to fix. A quick comps table can go straight through.

**Judgment the user should see.** A model is only as good as its assumptions, so say which few drive the answer (the
terminal value's share of a DCF, the exit multiple in an LBO, synergies in a merger) and show the grids for them.
Where a convention is a matter of taste (mid-year discounting, perpetuity versus exit multiple), say which you used
and why.

**Answer with a range, and test it against the market.** Report the spread the grids and cases give, not one figure to
the cent. A value far from the share price or from what peers trade at usually means an assumption is off; find which
before reading the gap as a mispricing. The market isn't always right, but the gap is the thing to explain.

## Steps to build one

1. Agree the brief and the list of inputs with the user.
2. Gather the inputs with their sources. Show the inputs block and the gaps; wait for the user on a big model.
3. Write the build script in the scratch folder (rerun it to rebuild) and save the workbook where the user wants it.
4. Recalculate it into the scratch folder and audit that copy (commands below). Fix the build script and repeat from
   step 3 until both pass.
5. Read the key results back from the recalculated copy and compare them with a rough estimate made another way: an
   EV/EBITDA multiple for a DCF, two-cash-flow IRR arithmetic for an LBO.
6. Flip the case selector (and any method switch) in a copy, recalculate, and confirm the results move the way the
   assumptions say they should. A result that doesn't move is reading a case block instead of the selected row.
7. Hand over the recalculated copy: it holds the computed values, so a preview or app that doesn't calculate shows
   numbers, not blanks. Check it kept the input colours, comments and names, then move it over the file you saved in
   step 3. Without LibreOffice, hand over the openpyxl file and say its numbers appear once it's opened in Excel,
   LibreOffice, Numbers or Google Sheets. (On someone else's model, keep their file as openpyxl saved it: a round trip
   through LibreOffice can drop Excel features their file uses.)

## Fixing or checking a model someone already has

Their workbook, their layout: keep its sheets, colours and style, read its formulas before changing any, and change
only what's broken. Prove the cause before you edit, because a change to the wrong cell can make a check pass and
leave the model wrong.

1. **Back up once, before the first change**, as a step of its own rather than inside a script you may run again: copy
   the file beside itself as `<name>-backup`, keeping its extension. If that name is taken, leave that file alone and
   pick another: it may hold the only original. A check that changes nothing needs no backup.
2. **Recalculate before you trust a number**, because a saved file can hold old results:
   `python <skill folder>/scripts/soffice.py recalc "Their model.xlsx" -o model-work/before.xlsx`, then read that copy.
   `check_model.py` on it finds error cells and failed checks; its findings on colours, sources and a missing Checks
   sheet only mean the model wasn't built to these conventions, so offer them as suggestions, not faults.
3. **Find the cause and show it.** Trace from the symptom to the first wrong cell (for a balance sheet that doesn't
   balance, `three-statement.md` says how). Tell the user the cell, its formula, what it should be and the numbers
   that prove it, before you edit. If they asked only for a check, stop here and report.
4. **Fix from the backup.** Load the backup with openpyxl (formulas, not `data_only`; `keep_vba=True` for an `.xlsm`),
   change only the broken cells, and save it as the user's file. Running the fix again then rebuilds the same file
   instead of applying the change twice. openpyxl drops drawn shapes: if the file has any, say so before saving over
   it.
5. **Recalculate and check the fixed file**, into the scratch folder: no error cells, and what was broken now holds in
   every period and every case. Take the corrected figures from that copy.
6. **Confirm the backup still differs**: open both and compare the cells you changed. If the backup already shows the
   fix, it was made after a change; tell the user the original is gone rather than call it a backup.

## Recalculate and audit

```
python <skill folder>/scripts/soffice.py recalc model.xlsx -o model-work/model-calc.xlsx
python <skill folder>/scripts/check_model.py model-work/model-calc.xlsx
```

Both print their result as JSON on stdout. Exit 0 means done and clean; 1 that the job ran and found problems, listed
in the JSON (error cells from recalc, `failures` from check_model); 2 that it couldn't run, with one line on stderr
saying why (no LibreOffice, with the ways to install it; a file open in Excel; a file that isn't a workbook).

- `soffice.py recalc <workbook> -o <copy.xlsx>` recalculates every formula in LibreOffice, saves the copy (never over
  the input) and lists its error cells with their formulas and a hint per kind of error; `--limit <n>` lists at most n
  (default 100; all are counted). `soffice.py find` says where LibreOffice is, and
  `soffice.py convert <file> --to pdf -o <file.pdf>` converts with it (`--to` takes an extension, or `ext:FilterName`).
  Each takes `--soffice <path>` (or the `SOFFICE` variable) for a LibreOffice outside the usual folders; convert and
  recalc take `--timeout <seconds>` (default 180).
- `check_model.py <workbook>` audits the recalculated copy: error cells, the Checks sheet, numbers typed into formulas,
  typed numbers not in the input colour, formulas in it, and inputs with no source; it warns on a source with no date
  and a link that isn't green. The JSON's `failures` name the cells and `how_to_fix` the remedy. `--structure-only`
  skips results, for a file nothing has calculated; `--checks-sheet <name>`, `--input-color <hex>` and
  `--link-color <hex>` (repeatable) fit a template's own; `--allow <number>` adds to the numbers allowed inside
  formulas (`conventions.md` lists them); `--ignore-sheet <name>` leaves out pasted raw data; `--limit <n>` caps the
  cells listed per finding (default 25).

## Done means

- On the final file, `soffice.py recalc` finds no error cells and `check_model.py` exits 0 (on someone else's model:
  no error cells, and what was broken now holds).
- Every Checks row is TRUE, in every scenario.
- Each sensitivity grid's centre equals the model's output, and its cells change across the grid.
- The scratch folder is gone: the user's folder holds the model, and the backup if you changed their file.
- Your note gives the answer as a range, the assumptions that drive it, the inputs still missing or estimated, and
  every assumption the user didn't give you (the currency, the units, a tax rate). Copy each figure from the
  recalculated copy (openpyxl with `data_only=True`), rounded as the sheet shows it, not from memory or your own
  arithmetic. When the user asks how the value moves, put the grid in the answer as a table; for a DCF, add how the
  enterprise value splits between the forecast years and the terminal value, and what the terminal value assumes
  about working capital (`dcf.md`).
- Where the model values a security, say once, plainly, that it's analysis built on the stated assumptions, not
  investment advice or a recommendation to buy or sell. Don't add a buy or sell call of your own.

## Watch out for

- **Net debt with the wrong sign.** Equity value is enterprise value minus net debt; when cash exceeds debt, net debt
  is negative and equity is worth more than the enterprise. Write it as a formula and let the sign work.
- **Mixing periods**: an LTM numerator over a calendar-year denominator, or peers with fiscal years ending in different
  months.
- **Basic shares where diluted belong.** Value per share and EPS use diluted shares: options, units and convertibles
  that are in the money.

## Files

- `references/conventions.md`: the shared rules in full: what may be typed in, colours and source comments, layout and
  units, openpyxl code for inputs, names and drop-downs, functions and lookups that fail quietly, scenarios, the
  Checks sheet, sensitivity grids, circular references, reading recalc's errors. Read it before building or changing
  any model.
- `references/dcf.md`: free cash flow, WACC, discounting and the mid-year convention, both terminal values and what
  the perpetuity carries forward, the bridge to value per share, scenario and sensitivity layout.
- `references/lbo.md`: sources and uses, the debt schedule with sweep, PIK and minimum cash, fees, exit, IRR and MOIC,
  a minimal layout.
- `references/three-statement.md`: how the statements link, working-capital drivers, roll-forwards, the revolver,
  taxes and losses carried forward, restricted cash, the checks, and finding why it doesn't balance.
- `references/comps.md`: choosing peers and metrics, LTM and calendar years, enterprise value consistency, statistics,
  implied value.
- `references/merger.md`: purchase price, exchange ratio and new shares, sources and uses, goodwill, the pro forma EPS
  bridge, breakeven synergies, grids.
- `references/filings.md`: SEC EDGAR's JSON APIs (finding a company, its filings, its reported figures), the rules for
  calling them, and what to take from a 10-K or 10-Q.
- `scripts/soffice.py`: finds LibreOffice, converts files, and recalculates a workbook into a copy, listing its error
  cells. Run it after every build and every fix.
- `scripts/check_model.py`: audits a recalculated model against the conventions.
