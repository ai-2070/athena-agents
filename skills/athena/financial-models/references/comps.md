# Comparable companies (comps)

Comps value a company by what the market pays for similar ones: a few multiples per peer, their spread, and the value
the target would have at the same multiples. The work is mostly judgment about which companies and which numbers are
truly comparable; the arithmetic is short. The formulas were checked in a test workbook (invented peers) recalculated
with LibreOffice.

## Peers

- **Comparable means the same economics**: business model, end markets, growth and margin profile, size within reason,
  and geography where it changes the multiple. A conglomerate with one matching division is not a peer.
- Fewer good peers beat many forced ones. When a company is a poor fit, leave it out and say why, rather than keep it
  and explain it away. Show the user the peer list, with a line on each, before collecting data.
- Every peer's data is as of the same date (one price date for all), from named sources, with the date in each comment.

## Metrics for the question

| Question or industry                                                    | Usual metrics                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------ |
| Value of the whole business, across capital structures                  | EV/Revenue, EV/EBITDA, EV/EBIT                               |
| Value to shareholders, profitable companies                             | P/E, and P/E against growth (PEG)                            |
| Unprofitable or early growth                                            | EV/Revenue, with growth beside it                            |
| Banks and insurers (debt is their raw material, so EV isn't meaningful) | P/E, price to book, price to tangible book, return on equity |
| REITs                                                                   | price to FFO or AFFO (funds from operations), dividend yield |

Pick three to five that answer the user's question, plus the operating figures that explain the differences (growth,
margins). More columns make the table harder to read, not more right.

## Enterprise value, consistently

```
Market cap       =Price*DilutedShares
EV               =L4+Debt-Cash+NCI                       plus preferred stock, where there is any
EV/EBITDA        =IF(I4<=0,"n/m",M4/I4)
P/E              =IF(J4<=0,"n/m",L4/J4)
PEG              =IF(OR(NOT(ISNUMBER(P4)),K4<=0),"n/m",P4/(K4*100))     growth stored as a fraction (0.12)
```

- **Numerator and denominator cover the same claims.** EBITDA includes all of a subsidiary's earnings, so EV adds the
  non-controlling interest. Earnings from associates are below EBITDA, so their value comes out of EV (or is ignored in
  both).
- **Leases.** Under IFRS 16 nearly all lease costs sit below EBITDA and the lease liabilities are debt; under US GAAP
  operating lease costs stay in operating expenses. Comparing EV/EBITDA across the two mixes bases: adjust one group,
  or include lease liabilities in EV only where the lease costs are outside EBITDA.
- **PEG** divides P/E by growth in percent, so growth stored as a fraction is multiplied by 100. Say which growth (next
  year's EPS growth, or a multi-year rate).
- **Diluted shares** by the treasury-stock method, as in `dcf.md`.

## Periods

- **LTM** (last twelve months) = the last full fiscal year + the latest year-to-date − the same year-to-date a year
  earlier. 10-Q income and cash-flow figures are year-to-date, so this is how quarterly filings become LTM.
- **NTM** (next twelve months) and forward years come from estimates; their source and date go in the comment, and
  they come only from the user's own data sources.
- **Align fiscal years** to calendar years when peers' years end in different months. For a fiscal year ending in month
  m, the calendar year is `=m/12*FY_ending_this_year+(12-m)/12*FY_ending_next_year`: with a March year end, a quarter of
  the fiscal year ending in March and three quarters of the one ending the following March.
- Every multiple in a column uses the same period. Mixing LTM and calendar-year figures makes the column meaningless.

## Statistics

```
Maximum            =MAX(N$4:N$8)
75th percentile    =QUARTILE(N$4:N$8,3)
Median             =MEDIAN(N$4:N$8)
25th percentile    =QUARTILE(N$4:N$8,1)
Minimum            =MIN(N$4:N$8)
Count              =COUNT(N$4:N$8)
```

- **Only on ratios** (multiples, margins, growth). The median of revenues or market caps describes the sample's size,
  not anything the target should match.
- **Leave meaningless values as text.** MEDIAN, QUARTILE and the rest skip text, so a peer with negative earnings shows
  "n/m" and drops out of the P/E statistics. `IFERROR(x,0)` instead puts a zero into the set, which pulls the median
  and the low quartile down and makes the minimum zero. Show the count of values behind each statistic.
- Prefer the median and quartiles to the mean, which one outlier can move a long way.
- QUARTILE is the inclusive method; `_xlfn.QUARTILE.INC` gives the same results.

## Implied value

```
Implied value per share at the median   =(O12*TargetEBITDA-TargetNetDebt)/TargetShares
```

Apply the 25th percentile, median and 75th percentile multiples to the target's own figure for the same period, bridge
from EV to equity the same way as the peers, and show a range per metric. The range that several metrics agree on says
more than any single number.

To pull one peer's figure elsewhere, use an exact match: `=INDEX(O4:O8,MATCH("Peer D",B4:B8,0))`.

## Checks

- Every peer is on the same price date and the same period basis: a column of dates and a check such as
  `=COUNTIF(PriceDates,"<>"&AsOf)=0`.
- Enough values behind each statistic: `=COUNT(N4:N8)>=MinPeers`, with `MinPeers` a named input the user agreed.
- EV ties for each peer when it's built from pieces: market cap + debt − cash + NCI.
- Every input filled in.

## A minimal layout

| Sheet           | Rows                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Inputs or Peers | one row per peer: name, price, price date, diluted shares, debt, cash, NCI, the period's revenue, EBITDA, net income, growth; each with a source |
| Peers           | market cap, EV and the multiples beside the inputs; a blank row; the statistics                                                                  |
| Valuation       | the target's figures, the implied values at the quartiles, the range per metric                                                                  |
| Checks          | the rows above                                                                                                                                   |

Write in the header the date the prices are as of, the currency and the units. Use no figures from memory: every
number comes from a filing, the user or a source the user named.
