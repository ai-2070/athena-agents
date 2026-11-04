# Merger model (accretion/dilution)

A merger model asks whether the buyer's earnings per share go up (accretion) or down (dilution) after a deal, and what
would have to be true (synergies, price, the cash/stock mix) for it to break even. EPS accretion isn't value creation: a
deal can add to EPS and still overpay. Say so when presenting it, next to a value view (a DCF or comps of the target).
The formulas were checked in a test workbook recalculated with LibreOffice; names stand for input cells.

## Inputs

- **Buyer**: share price, diluted shares, net income for the forecast years (from its own model or estimates, with the
  source), marginal tax rate, rate it would pay on new debt, rate it earns on cash.
- **Target**: share price, diluted shares, net income for the same years (calendarise if the fiscal years differ, as in
  `comps.md`), debt to be refinanced and its rate, book equity and existing goodwill.
- **Deal**: premium or offer price, share of the price paid in stock, buyer's cash used, run-rate synergies and how much
  is reached each year, advisory fees, financing fees, the intangible assets written up and their life.

## Price, exchange ratio and new shares

```
Offer price per share     =TgtPrice*(1+Premium)
Equity purchase price     =OfferPrice*TgtShares               target diluted shares at the offer price
Exchange ratio            =OfferPrice*StockPct/AcqPrice       buyer shares per target share
New shares issued         =TgtShares*ExchRatio
```

- A fixed exchange ratio moves the deal's value with the buyer's share price; a fixed price moves the number of
  shares. Use what the terms say. The target's holders end up owning `NewShares/(AcqShares+NewShares)` of the combined
  company.
- Target diluted shares rise with the offer price (more options are in the money), so use the treasury-stock method at
  the offer price.

## Sources and uses

```
Uses       =EquityPrice+TgtDebt+Advisory+FinFees
Sources    =NewShares*AcqPrice+CashUsed+NewDebt
New debt   =(EquityPrice*(1-StockPct)+TgtDebt+Advisory-CashUsed)/(1-FinFeePct)
```

Financing fees are a share of the new debt, which also pays for them; solving for the debt as above removes the loop.
Advisory fees are a one-off cost at closing and stay out of the recurring EPS; show them in the closing balance sheet
and say so.

## Goodwill

```
Goodwill   =EquityPrice-(TgtBook-TgtGoodwill+WriteUp-WriteUp*TaxRate)
```

The price minus the fair value of the identifiable net assets: book equity without the target's old goodwill, plus
the write-ups (intangibles, PP&E), less the deferred tax liability on the write-ups. That liability arises when the tax
basis carries over (a share purchase); in an asset purchase, or with an election that steps up the tax basis, there's
no such liability and the write-up's amortisation is tax-deductible. Ask which applies. Under US GAAP and IFRS, goodwill
isn't amortised for public companies (it's tested for impairment); the written-up intangibles are amortised over their
lives, which is what lowers GAAP EPS.

## Pro forma earnings

```
Pro forma net income, before synergies
  =AcqNI+TgtNI
   -NewDebt*DebtRate*(1-TaxRate)            interest on new debt
   -CashUsed*CashRate*(1-TaxRate)           interest no longer earned on cash used
   +TgtDebt*TgtDebtRate*(1-TaxRate)         target interest no longer paid, once refinanced
   -WriteUp/IntLife*(1-TaxRate)             amortisation of the new intangibles
   -FinFees/DebtTerm*(1-TaxRate)            financing fees spread over the debt's term
Pro forma net income     =PFNIex+Synergies*Phase1*(1-TaxRate)
Pro forma shares         =AcqShares+NewShares
Pro forma EPS            =PFNI/PFShares
Accretion (dilution)     =PFEPS/(AcqNI/AcqShares)-1
Adjusted EPS             =(PFNI+WriteUp/IntLife*(1-TaxRate))/PFShares
```

- Every adjustment is after tax at the buyer's marginal rate, unless the user's tax view says otherwise.
- **Phase synergies in.** Run-rate synergies arrive over time, and the costs to achieve them come first; model the
  share reached each year as inputs, and the one-off costs separately. Revenue synergies are less certain than cost
  synergies; show them separately so the user can turn them off.
- **GAAP and adjusted EPS.** Adjusted (cash) EPS adds back the amortisation of the new intangibles; show both, labelled.
- Year 1 is rarely a full year after closing; use a stub or say that the year is treated as full.

## Breakeven synergies

The year-1 pre-tax synergies at which pro forma EPS equals the buyer's standalone EPS:

```
=(AcqNI/AcqShares*PFShares-PFNIex)/(1-TaxRate)
```

Compare it with the synergies the user expects and the share reached in year 1. A negative answer means the deal is
accretive with no synergies.

## Grids

Accretion by premium (down) and the share paid in stock (across). Both change the new debt, the new shares and the
fees, so each grid point needs its own small chain: a helper sheet with one column per point holding premium, stock
share, offer price, equity price, new shares, new debt, fees, pro forma net income and accretion, and the grid cells
reading the last row. Build it with a loop. Other useful grids: synergies × premium, and the buyer's share price ×
stock share.

## Checks

- Sources equal uses: `=ABS(Sources-Uses)<Tol`.
- The grid's centre equals the model's accretion.
- Goodwill isn't negative (a negative figure, a bargain purchase, is rare; check the inputs first).
- New debt isn't negative: `=NewDebt>=0`. It goes negative when the cash used is more than the part the stock doesn't
  pay for; lower the cash used.
- New shares are zero when the stock share is zero (test by flipping the input in a copy).

## A minimal layout

| Sheet | Rows |
|---|---|
| Inputs | buyer, target and deal inputs with sources; synergy phasing by year; grid steps; tolerance |
| Merger | offer price, equity price, exchange ratio, new shares; sources and uses; goodwill; pro forma net income by year; shares; EPS GAAP and adjusted; accretion; breakeven synergies; grids |
| SensCalc | one column per grid point |
| Checks | the rows above |

Show the user the purchase price and sources and uses, then the year-1 bridge, before the grids.
