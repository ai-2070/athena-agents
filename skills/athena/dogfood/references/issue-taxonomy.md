# Ranking issues

How to give each issue a severity and a category, what evidence each category needs, which accessibility criteria to
cite, and when two findings are one issue. Severity says how much a problem hurts; the category says what kind of
problem it is, so it reaches the person who can fix it.

## Severity

Three questions decide it: what happens to someone who hits the problem, how many people hit it (the main path or a
corner few reach), and whether they can get round it.

| Severity | What it means | For example |
|---|---|---|
| Critical | Most people can't finish a core flow; data is lost, wrong or exposed; money or messages go out wrongly | the page loads blank; no account can sign in; a form saves nothing and says nothing; the card is charged but no order exists; one customer sees another's details; markup typed into a field runs |
| High | A core flow fails for some people, or only an awkward workaround gets through; something important is wrong | the main button works only after a reload; search finds nothing for a word that's on the site; a valid postcode is refused; a menu link leads to a not-found page; the checkout button can't be reached by keyboard |
| Medium | Plain to see, but off the main path or with an easy way round | a wrong entry gets no message; a layout breaks at phone width but can still be used; pictures missing on a secondary page; a measured figure well past the "good" thresholds in SKILL.md |
| Low | Polish: nothing stops anyone | a typo; uneven spacing; a "TODO" left on a help page; a console warning that changes nothing; no icon in the browser tab |

Rules of thumb:

- Judge by the effect, not by how alarming it looks. A red console error that changes nothing on screen is Low; a form
  that quietly saves nothing, with a clean console, is Critical.
- An uncaught error ranks by what it breaks. If you looked and found nothing it breaks, it's Low, and the issue says
  you looked.
- Move one level up for the flow under test and the ones the business runs on (sign-in, checkout, payment), and one
  down when it takes an unusual setup to hit.
- A barrier for keyboard or screen-reader users on a core flow is High or Critical. For them it's a locked door, not a
  blemish.
- Give every Critical and High a sentence on why: it's the ranking a reader will question.

## Categories

One per issue: the one that tells whoever picks it up what kind of fix it needs.

| Category | What it covers | The evidence it needs |
|---|---|---|
| Functional | Doesn't do what it should: controls with no effect, wrong results, flows that can't be finished, data not saved | Steps, expected and actual, screenshots before and after the action |
| Console and network | Errors with nothing visible yet: uncaught exceptions, rejected promises, failed or doubled requests, CORS and mixed-content refusals | The exact message and the top of its stack; method, address, status and part of the response; the action that set it off |
| Visual | Layout and drawing: overlap, cut-off text, broken images, things hidden behind other things, a page that falls apart when narrow | A screenshot, the window size and the browser |
| Accessibility | Barriers for people using a keyboard, a screen reader, zoom or weaker eyesight | What you pressed and where focus went; the criterion it fails (below) |
| Usability | It works, but people will struggle: no feedback after an action, no sign of loading, errors that don't help, no confirmation before deleting, controls that act differently from page to page | What a user would expect and why, with a screenshot |
| Content | The words and media: typos, placeholder text, outdated or wrong facts, dead links to other sites, labels that mislead | The exact text and where it is |
| Performance | Slow loading, slow answers to clicks and typing, the layout jumping as things load | What was measured, with what, how many runs, and that it's a lab figure |
| Security and privacy | Tokens or personal data in pages, the console or addresses; markup that runs; pages reached without signing in | Only as much as shows it, with secrets blanked out |

When a console error explains a functional failure, the issue is Functional and the console text is part of its
evidence. Console and network is for errors that don't yet show on screen.

## Accessibility criteria to cite

WCAG 2.2 at level AA is the usual bar. Naming the criterion lets the reader look up exactly what's required (checked
against W3C's WCAG 2.2 in November 2026):

| Criterion | Level | What fails it |
|---|---|---|
| 1.1.1 Non-text Content | A | An image or icon button that carries meaning has no text alternative |
| 1.3.1 Info and Relationships | A | Headings, lists, tables or field labels that only look like it, without the markup |
| 1.4.3 Contrast (Minimum) | AA | Text under 4.5:1 against its background, or large text (18 pt, or 14 pt bold) under 3:1 |
| 1.4.10 Reflow | AA | Sideways scrolling or lost content at a narrow width |
| 1.4.11 Non-text Contrast | AA | Control borders, focus rings or meaningful icons under 3:1 against what's next to them |
| 2.1.1 Keyboard | A | Something done with the mouse can't be done with the keyboard |
| 2.1.2 No Keyboard Trap | A | Focus goes into a widget and can't get out with the keyboard |
| 2.4.3 Focus Order | A | Tab jumps around in an order that breaks the meaning |
| 2.4.7 Focus Visible | AA | No visible sign of which control has focus |
| 2.4.11 Focus Not Obscured (Minimum) | AA | The focused control is hidden entirely, say behind a sticky header or a cookie banner |
| 2.5.8 Target Size (Minimum) | AA | Small click or tap targets packed too close together |
| 3.3.1 Error Identification | A | A wrong entry isn't pointed out, or is shown by colour alone |
| 3.3.2 Labels or Instructions | A | A field with no visible label or instructions, so people can't tell what goes in it |
| 4.1.2 Name, Role, Value | A | A custom control that doesn't tell a screen reader what it is or whether it's on |

## One issue or several

- **One cause, several places**: one issue, with every place listed (the same broken date picker on five forms).
- **One cause, several symptoms**: one issue, the symptoms in its description (a failed request that leaves a spinner
  turning and the list empty).
- **One symptom, different causes**: separate issues. Two buttons that do nothing, with different console errors, are
  two bugs.
- **Not sure**: keep them separate and note that they may be related. Merging can hide a bug; splitting costs a line.

Sort by severity, and within a level by the flow's rank in your plan.

## What isn't an issue

- **Suggestions**: it works as intended but could be better. They get their own list and aren't counted.
- **Questions**: behaviour you can't judge without knowing what was meant ("should a guest see prices?"). List them for
  the user rather than guessing whether they're bugs.
