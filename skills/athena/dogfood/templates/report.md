# QA report: [app or site name]

- **Address tested:** [URL]
- **Build:** [version, commit or date shown in the app]
- **Environment:** [local, staging or production]; [browser and version]; window [width × height], narrow check at
  [width] CSS pixels
- **Date:** [YYYY-MM-DD]
- **Tested by:** [agent name], using [browser tool]
- **Scope:** [flows and areas agreed with the user]; off-limits: [what was left alone]

## Summary

[Two or three sentences in plain words: how the app held up, and the one issue that matters most.]

| Severity | Issues |
|---|---|
| Critical | [n] |
| High | [n] |
| Medium | [n] |
| Low | [n] |
| Total | [n] |

| # | Issue | Severity | Category | Where |
|---|---|---|---|---|
| 1 | [short title] | [severity] | [category] | [page or URL] |

## Issues

<!-- One section per issue, Critical first. Delete this comment and any line that doesn't apply. -->

### 1. [Short title that says what goes wrong]

- **Severity:** [Critical, High, Medium or Low]. [For Critical and High, one sentence on why.]
- **Category:** [category]
- **Where:** [URL; every place, if it shows up in several]
- **How often:** [every time / n of m tries / seen once]

Steps:

1. [Starting point: signed in as …, on …]
2. [Action]
3. [Action]

Expected: [what should happen]

Actual: [what happens instead]

![What the screenshot shows](screenshots/01-short-name.png)

Console and network:

```text
[the exact message, or the request's method, address and status, and the part of the response that matters]
```

## Suggestions

- [Works as intended but could be better: what, and why it would help]

## Questions

- [Behaviour that depends on what was meant, for the user to answer]

## Coverage

Tested:

- [flow or page]: [what was tried]

Not tested:

- [area]: [why: out of scope, no time, needs an account we didn't have]

Blockers:

- [what stopped testing, and where]

Load-time errors not captured on: [pages where the console was read only after loading; otherwise delete this line]

## Test data left behind

- [accounts, items and uploads you created, and where they are, so they can be removed]
