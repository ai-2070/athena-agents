# Leveraged buyout (LBO)

An LBO asks what a financial buyer earns if it buys the company mostly with debt, uses the cash flow to pay the debt
down, and sells after a few years. The outputs are the sponsor's IRR and multiple of money (MOIC), and from them the
most it could pay. No template is needed; the layout at the end builds one from scratch. The formulas were checked in a
test workbook recalculated with LibreOffice (column C is closing, D to H are years 1 to 5).

## Sources and uses

```
Uses
  Purchase enterprise value     =EntryEBITDA*EntryMultiple
  Deal fees                     =C4*DealFees
  Financing fees                =(C10+C11)*FinFees
  Cash to the balance sheet     =MinCash
  Total uses                    =SUM(C4:C7)
Sources
  Senior debt                   =EntryEBITDA*SeniorX
  PIK notes                     =EntryEBITDA*PIKX
  Sponsor equity (the plug)     =C8-C10-C11
  Total sources                 =SUM(C10:C12)
```

One item balances the table, normally the sponsor's equity; everything else comes from an input. When the target's
existing debt is repaid at closing, it's a use; when the price is quoted as equity value, add the debt refinanced.
Rollover equity from management is a source and dilutes the sponsor's share of the exit.

## Operating forecast and free cash flow

Revenue, EBITDA, D&A and EBIT as in any forecast, then:

```
Senior interest          =D30*SeniorRate                 on the opening balance: no loop
PIK interest             =D35*PIKRate                    accrues to the notes, paid at exit
Fee amortisation         =IF(YEARFRAC($C$15,D15)<=FeeYears,$C$6/FeeYears,0)
Pre-tax income           =D19-D20-D21-D22
Tax                      =MAX(0,D23*TaxRate)
Net income               =D23-D24
Free cash flow           =D25+D18+D21+D22-D26-D27        add back D&A, PIK and fee amortisation (non-cash)
```

- **Interest on opening balances** avoids the circular reference that average balances create; the alternative is in
  `conventions.md`.
- **PIK** (pay-in-kind) interest isn't paid in cash: it's an expense that's added back to cash flow and added to the
  notes' balance, so the debt grows.
- **Financing fees** are paid at closing and spread over the debt's life as a non-cash charge. Deal fees are spent at
  closing and lower the equity's value from day one. How either is taxed depends on the jurisdiction; say what you
  assumed.
- `MAX(0, …)` on tax ignores the value of losses; a model with losses in early years needs the carry-forward from
  `three-statement.md`.

## Debt schedule and cash sweep

```
Senior opening            =C33                           last year's closing
Mandatory repayment       =MIN(D30,$C$10*Amort)          never more than is owed
Cash available for sweep  =D38+D28-D31-MinCash           opening cash + FCF - mandatory - minimum cash
Cash sweep                =MAX(0,MIN(D39,D30-D31))       never negative, never more than what's left
Senior closing            =D30-D31-D32
PIK opening / closing     =C36  /  =D35+D21
Cash closing              =D38+D28-D31-D32
```

- With several tranches, take every tranche's mandatory repayment out of the cash available, then sweep in order of
  seniority: each tranche's sweep is `MAX(0, MIN(cash left after the tranches above it, its opening balance less its
mandatory repayment))`.
- A revolver covers years when cash falls short: draw `=MAX(0,MinCash-cash before revolver)`, repay first when cash
  returns (the revolver in `three-statement.md` works the same).
- Repayment terms (amortisation, sweep share, call premiums) come from the term sheet the user has; don't assume them.

## Exit and returns

```
Exit enterprise value     =ExitMultiple*H17               exit-year EBITDA
Net debt at exit          =H33+H36-H40                    all debt, including PIK accrued, less cash
Exit equity               =C44-C45
Sponsor cash flows        C42 =-C12; D42:H42 =IF(YEARFRAC($C$15,D15)=HoldYears,ExitEquity,0)
IRR                       =IRR(C42:H42)                   evenly spaced annual flows
IRR on dates              =XIRR(C42:H42,C15:H15)          real dates; differs slightly from IRR
MOIC                      =SUMIF(C42:H42,">0")/-SUMIF(C42:H42,"<0")
```

- **Signs**: money in is negative, money out positive, and the range covers every period from closing to exit. A
  missing year or a positive entry flow gives a wrong or `#NUM!` IRR.
- **Interim dividends or recapitalisations** go in the same row in their year.
- **Management's share**: when management holds options or a sweet equity pool, the sponsor gets exit equity times its
  ownership; model it as an input, not a guess.
- An exit multiple above the entry multiple ("multiple expansion") is a bet on the market, not on the business; show
  returns with the exit multiple equal to entry as well.

## Grids

IRR by entry multiple (down) and exit multiple (across). With only two cash flows the IRR has a closed form,
`(out/in)^(1/years)-1`, so each cell is one formula. This holds when debt is sized on EBITDA and the deal fees don't
change the later cash flows:

```
=((C$53*$H$17-$C$45)/($B54*EntryEBITDA*(1+DealFees)+$C$6+$C$7-$C$10-$C$11))^(1/HoldYears)-1
```

With interim flows, or when the varied input changes the debt (a leverage multiple, an interest rate), use helper
columns that repeat the schedule per grid point (`conventions.md`). Useful grids: entry × exit multiple, leverage ×
interest rate, and exit year × exit multiple.

## Checks

- Sources equal uses.
- No debt balance below zero: `=MIN(D33:H33)>=0` per tranche.
- Cash never below the minimum: `=MIN(D40:H40)>=MinCash-Tol`.
- The IRR grid's centre equals the model's IRR.
- Exactly one exit cash flow: `=COUNTIF(D42:H42,">0")=1` (adjust when there are interim dividends).

## A minimal layout

| Sheet  | Rows                                                                                                                                                                                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inputs | entry EBITDA and multiple, exit multiple, leverage per tranche and rates, amortisation, fees, minimum cash, tax rate, operating drivers, closing date, years to exit, grid steps, tolerance |
| Model  | sources and uses (closing column); dates; revenue to free cash flow; one block per tranche (opening, mandatory, sweep, closing); cash; sponsor cash flows; exit; IRR, XIRR, MOIC; grids     |
| Checks | the rows above                                                                                                                                                                              |

Show the user sources and uses, then the operating forecast, then the debt schedule, then returns, before the grids.
