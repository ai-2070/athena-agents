# Three-statement model

The income statement, balance sheet and cash flow statement forecast together, so that every change in a balance
sheet line is explained by the income statement or the cash flow statement, and cash comes out of the cash flow rather
than being typed or plugged. When it's built that way the balance sheet balances by itself; when it doesn't, the
difference points at the link that's missing. The formulas were checked in a test workbook recalculated with
LibreOffice (column C is the last actual year, D to F the forecast).

## Build order

1. Historicals, two or three years, typed as inputs with sources (`filings.md`). Check that the last historical balance
   sheet balances and that each year's cash flow ends at the balance sheet's cash.
2. Drivers on Inputs: growth, margins, working-capital days, capex and D&A, debt terms, payout, minimum cash, tax.
3. Income statement down to pre-tax income, with interest on opening balances.
4. Supporting schedules: working capital, PP&E, debt and revolver, equity, tax and losses.
5. Balance sheet, every line from a schedule or the cash flow; cash last.
6. Cash flow statement from the changes.
7. The Checks sheet, then scenarios.

## Working capital from days

```
Receivables      =D3*DSO/Days              revenue × days of sales outstanding / days in the period
Inventory        =D4*DIO/Days              cost of goods sold × days of inventory
Payables         =D4*DPO/Days              cost of goods sold × days payable
```

Work out the historical days the same way, from the same lines, before choosing forecast days; a forecast that jumps
away from history needs a reason. `Days` is a named input (365 for annual periods, the days in the quarter for
quarters). Some models drive payables from purchases rather than COGS; use one basis for history and forecast.

## Roll-forwards

Every balance moves from last period's by flows the model explains:

```
PP&E, net        =C25-D41-D9               prior + capex (D41 is negative on the cash flow) - D&A
Term debt        =C28+D43                  prior + repayments (negative)
Common stock and APIC   =C30+D7            prior + stock-based compensation (+ shares issued)
Retained earnings       =C31+D16+D44       prior + net income + dividends (negative)
```

- **Stock-based compensation goes to APIC**, not retained earnings: the expense lowers net income, which flows to
  retained earnings, and the matching credit is paid-in capital. Adding it to retained earnings as well counts it twice
  and the balance sheet won't balance.
- Buybacks reduce equity (treasury stock or APIC, as the company reports it) and are a financing outflow.

## Cash flow statement

Cash signs: inflows positive, outflows negative, balance sheet lines positive.

```
Net income                     =D16
D&A                            =D9
Stock-based compensation       =D7
(Increase) in receivables      =-(D23-C23)          an asset rising uses cash
(Increase) in inventory        =-(D24-C24)
Increase in payables           =D27-C27             a liability rising is a source
Cash from operations           =SUM(D34:D39)
Capex                          =-D3*CapexPct
Term debt repaid               =-MIN(C28,Repay)
Dividends                      =-MAX(0,D16)*DivPct
Revolver drawn (repaid)        =D52-D53
Net change in cash             =D40+D42+D46
Cash and restricted cash, closing   =D48+D47       D48 = last year's cash + restricted cash
Balance sheet cash             =D49-D22            the total less restricted cash
```

**Restricted cash.** Under US GAAP since ASU 2016-18 the cash flow statement explains the change in cash, cash
equivalents and restricted cash together, so a company with restricted cash shows a cash-flow total that is larger than
its balance sheet's "cash and cash equivalents". Reconcile the two: the cash flow total equals the sum of the balance
sheet lines that hold cash. In EDGAR's data the total is the concept
`CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents`.

## The revolver

The revolver keeps cash at its minimum without a typed plug, using the cash before any revolver flow:

```
Cash before revolver    =D48-C22+D40+D42+D43+D44           unrestricted cash after every other flow
Revolver draw           =MAX(0,MinCash-D51)
Revolver repay          =MIN(C29,MAX(0,D51-MinCash))
Revolver balance        =C29+D45
```

Its interest is on the opening balance, so there's no loop.

## Taxes and losses carried forward

```
NOL used           =MIN(D18,MAX(0,D12)*NOLCap)
Taxable income     =MAX(0,D12-D13)
Tax                =D14*TaxRate
NOL closing        =D18-D13+MAX(0,-D12)            opening - used + this year's loss
```

- **US federal rules** (26 U.S.C. § 172, checked November 2026): losses from tax years beginning after 2017 carry
  forward without expiry and offset at most 80% of taxable income (figured before the loss deduction and the § 199A
  and § 250 deductions); losses from earlier years have no 80% cap but expire after 20 years; carrybacks are generally
  gone (farming losses and those of property and casualty insurers excepted). A model with both vintages tracks them
  in separate rows, older losses first. States and other countries have their own rules; ask or look them up rather
  than reusing the federal ones.
- The rate is an input with its source. Effective rates from history include one-off items; say which rate you used.
- If the model carries a deferred tax asset for the losses, its change is a non-cash line on the cash flow.

## Scenarios

The same case selector as other models (`conventions.md`), driving growth, margins, days and capex. A one-year shock
(a recession year) can be a named input applied to one column. Every check holds in every case: flip the selector in a
copy and recalculate.

## Checks

One column per forecast period:

- The balance sheet balances: `=ABS(Model!D26-Model!D32)<Tol`.
- The cash flow ends at the balance sheet's cash plus restricted cash: `=ABS(Model!D49-Model!D21-Model!D22)<Tol`.
- Net income on the cash flow equals the income statement's.
- Retained earnings roll forward: `=ABS(Model!C31+Model!D16+Model!D44-Model!D31)<Tol`.
- APIC rolls forward with stock-based compensation.
- Cash at or above the minimum, the revolver never negative, losses carried forward never negative.
- The last historical balance sheet balances.

## When it doesn't balance

Look at the difference per period. If it's constant from the first forecast year, the opening balance sheet is off
(a typing error in the historicals, or a line left out). If it grows, a flow is missing: some balance sheet line
changes without a matching cash flow line (a new asset with no capex, an accrual with no working-capital line, equity
issued with no financing inflow), or a line appears in both. Cash carries the error forward, so compare how much the
difference grows each period with each line's change in that period: growth equal to a line's change, or twice it,
names the line (twice is usually a sign the wrong way round). Fix the link, never with a balancing figure, then
recalculate and see the difference fall to zero in every period and every case.

## A minimal layout

| Sheet | Rows |
|---|---|
| Inputs | drivers, debt terms, minimum cash, tax and losses, scenario blocks, tolerance |
| Model (or IS, BS, CF and Schedules) | income statement; losses carried forward; balance sheet; cash flow; revolver |
| Checks | one row per check, one column per period |

Show the user the historicals and drivers, then the income statement, then the balance sheet with its check, before the
cash flow and scenarios.
