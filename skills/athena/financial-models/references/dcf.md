# Discounted cash flow (DCF)

A DCF values the business as the cash it will generate for all its investors, discounted at their blended required
return, then subtracts what belongs to lenders and other claimants to reach equity per share. The formulas below were
checked in a test workbook recalculated with LibreOffice; cell addresses are examples.

## Free cash flow

Unlevered free cash flow, year by year, from the selected case's drivers:

```
Revenue            =D10*(1+Inputs!E52)                  growth from the selected row
EBIT               =E10*Inputs!E53                      margin on revenue (costs scale with revenue, not gross profit)
Taxes on EBIT      =E11*TaxRate
NOPAT              =E11-E12
D&A                =E10*Inputs!E54
Capex              =E10*Inputs!E55
Change in NWC      =(E10-D10)*Inputs!E56                working capital tied to revenue growth
Unlevered FCF      =E13+E14-E15-E16
EBITDA             =E11+E14                             needed for an exit multiple
```

- Tax here is on EBIT, as if the company had no debt; the benefit of interest is in the WACC instead.
- Stock-based compensation is a real cost to shareholders. Either keep it as an expense in EBIT (don't add it back), or
  add it back and count the extra shares it will create. Say which.
- Check the drivers against history and peers. In the final year capex should be at least D&A: the terminal value
  repeats that year for ever, and D&A above capex shrinks the asset base while the formula assumes growth.
- Forecast long enough for the business to reach a steady state: five years is common, a fast grower needs more,
  because the terminal value assumes the last year repeats, growing steadily, for ever.

## WACC

```
Market cap               =Price*DilutedShares
Cost of equity           =Rf+Beta*ERP                   CAPM
After-tax cost of debt   =Kd*(1-TaxRate)
Equity weight            =E24/(E24+Debt)
Debt weight              =Debt/(E24+Debt)
WACC                     =E27*E25+E28*E26
```

- **Weights use gross debt** (market value where it trades, book value otherwise) and the market value of equity. The
  weights describe how the operating business is financed; cash isn't part of that and comes back in the bridge below.
  Net debt in the weights also breaks when cash exceeds debt, giving a negative debt weight.
- **The risk-free rate** is the government bond yield in the currency of the cash flows, of a maturity close to the
  forecast's horizon; a 10-year yield is the common choice. Date it.
- **Beta and the equity risk premium are judgment inputs.** Take beta from a named source (a data provider, or a
  regression the user agrees with; a peer median relevered to the company's own debt is steadier for a single company)
  and the premium from the user's house view or a published estimate, each with its source. No figure for either is
  "standard".
- **Cost of debt** is the yield the company would pay now (its bonds' yield, or a rate for its credit quality), not
  interest expense over old debt.
- If the company is far from its target capital structure, use the target weights and say so.

## Discounting

- **Mid-year convention.** Cash arrives through the year, so discount each year's flow from its midpoint: periods
  0.5, 1.5, 2.5… With a row of year fractions (1 for a full year), the period is `=SUM($E$7:E7)-E7/2` and the discount
  factor `=1/(1+WACC)^E19`. Year-end discounting (periods 1, 2, 3…) is the conservative alternative; say which you used.
- **A valuation date inside a year** (a stub period): the first fraction is `=YEARFRAC(ValDate, E6)` where E6 is the
  first period's end, later ones `=YEARFRAC(E6, F6)`, and only that fraction of the first year's cash counts:
  `PV =E17*E7*E20`.

## Terminal value, both ways

Build both and compare; pick one with a method switch (`=CHOOSE(TVMethod, PVperpetuity, PVexit)`).

```
TV, perpetuity growth     =I17*(1+TermGrowth)/(WACC-TermGrowth)
PV, perpetuity            =E32/(1+WACC)^I19                 I19 = the last year's mid-year period (N-0.5)
TV, exit multiple         =ExitMultiple*I18                 times final-year EBITDA
PV, exit multiple         =E34/(1+WACC)^E31                 E31 = SUM(E7:I7), the end of year N
```

- **The timing differs.** The growing perpetuity, with flows at mid-year, is worth its formula value half a year before
  the first flow, so it's discounted at N−0.5 under the mid-year convention. An exit multiple prices the business as of
  the end of year N, so it's discounted at N. Discounting both at the same period mis-states one of them.
- **Growth below WACC**, always: as growth approaches WACC the value runs to infinity. A long-run growth rate above the
  economy's nominal growth claims the company eventually outgrows the economy; justify it or lower it.
- **Cross-check each with the other.** The multiple implied by the perpetuity value, both valued at year N:
  `=PVperp*(1+WACC)^E31/I18`. The growth implied by the exit value, taking it back half a year to match the perpetuity's
  timing (V is the exit TV over `(1+WACC)^0.5`): `=(V*WACC-I17)/(V+I17)`. An implied multiple far from what peers trade
  at, or implied growth above the economy's, says one of the two assumptions is off.
- **The terminal value's share of enterprise value** (`=PVTV/EV`) is a smell test, not a pass mark: when it dominates,
  the answer rests mostly on the terminal assumptions and the grids on them matter most. Show it.

**What the perpetuity carries forward.** Growing the final year's FCF repeats that year's working-capital investment for
ever, and that investment was sized for the final year's growth, not the terminal rate. When working capital rises with
revenue and the final year grows faster than the terminal rate (the usual case), the perpetuity value comes out low,
before discounting, by the final year's working-capital ratio (`Inputs!I56`) × the revenue of the year before last ×
(final-year growth − terminal growth) ÷ (WACC − terminal growth). When the final year grows more slowly, or working
capital falls as revenue grows (customers who pay before the company pays its suppliers), it comes out high. To
normalise it, value the next year's flow with its working capital sized for the terminal rate:

```
Terminal-year FCF        =(I13+I14-I15)*(1+TermGrowth)-Inputs!I56*I10*TermGrowth     named TermFCF
TV, perpetuity growth    =TermFCF/(WACC-TermGrowth)                                  in place of the one above
```

In the WACC × growth grid below, `(($I$13+$I$14-$I$15)*(1+C$40)-Inputs!$I$56*$I$10*C$40)` takes the place of
`$I$17*(1+C$40)`. Either way, say in the answer which you used, which way the simple version leans and by how much.

## From enterprise value to value per share

```
Enterprise value        =SUM(PV of FCF)+PV of TV used
Net debt                =Debt-Cash                       negative when cash exceeds debt
Equity value            =EV-NetDebt-OtherClaims
Value per share         =EquityValue/DilutedShares
Upside to price         =ValuePerShare/Price-1
```

- **Other claims** sit between the enterprise and the shareholders: preferred stock, non-controlling interests (when the
  cash flows are consolidated), and debt-like items such as unfunded pensions or lease liabilities, the latter only when
  the cash flows exclude lease payments. Each item belongs in the bridge if, and only if, the cash flow excluded it;
  investments not in the cash flows (stakes in associates) are added.
- **Diluted shares**: basic shares plus in-the-money options by the treasury-stock method (options × (1 − strike /
  price)), restricted stock units, and convertibles that would convert. Using the implied price in the treasury-stock
  method makes a loop; use the current price, and say so.
- **Cash** that can't be used (held abroad with tax to pay on bringing it home, or needed to run the business) is worth
  less than its face value; adjust it or say why not.

## Scenarios and grids

Bear, base and bull blocks for growth, margin, D&A, capex and working capital by year, with the selected row
(`conventions.md`). Discount rate and terminal growth are usually varied in the grids rather than the cases.

The WACC × terminal-growth grid needs one formula per cell, because changing them doesn't change the forecast. With
FCF in E17:I17, year fractions in E7:I7, mid-year periods in E19:I19, WACC down column B and growth across row 40:

```
=IF($B41<=C$40,"n/m",(SUMPRODUCT($E$17:$I$17*$E$7:$I$7,(1+$B41)^-$E$19:$I$19)
   +$I$17*(1+C$40)/($B41-C$40)/(1+$B41)^$I$19-NetDebt-OtherClaims)/DilutedShares)
```

A WACC × exit-multiple grid replaces the terminal term with `C$40*$I$18/(1+$B41)^$E$31`. A grid on growth or margins
changes the forecast, so it needs helper columns (`conventions.md`). Beta or the risk-free rate only change WACC:
compute the WACC inside the cell from the two axis values and reuse the formula above.

## Checks

- Each grid's centre equals the model's value per share for that method.
- Terminal growth is below WACC: `=TermGrowth<WACC`.
- Equity and debt weights add to one.
- Every input filled in.
- The bridge ties: `=ABS(EV-NetDebt-OtherClaims-EquityValue)<Tol` when equity value is built from separate pieces.

## A minimal layout

| Sheet  | Rows                                                                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inputs | case selector, method switch, market data (price, diluted shares, debt, cash, other claims), tax rate, WACC inputs, terminal growth and multiple, valuation date, grid steps, tolerance; bear, base, bull blocks; selected rows |
| DCF    | period ends and year fractions; revenue to unlevered FCF; EBITDA; discount periods and factors; PV of FCF; WACC block; terminal values; bridge; value per share; implied multiple and growth; grids                             |
| Checks | the rows above                                                                                                                                                                                                                  |

Show the user the inputs block, then the FCF schedule, then the WACC and the bridge, before building the grids.
