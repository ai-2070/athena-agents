<!-- A PR body for a bug fix, for repos with no template of their own. Fill it in a copy in gh-work, then delete these
comments. Write only what you did and saw; a line you can't fill truthfully goes. -->

## The problem

<!-- The symptom as someone meets it, in a sentence or two. -->

Fixes #<!-- issue number; only closes it when this PR goes into the default branch -->

## The cause

<!-- Why it happened, plainly. If a past change introduced it, name the commit or PR. -->

## The fix

- <!-- the change, made where the problem starts -->
- <!-- other places with the same mistake: fixed here, or left out and why -->

## How it was checked

- New test `<test name>`: fails without this change, passes with it.
- `<the repo's check command>` passed on <!-- system -->.
- By hand: <!-- the steps you followed and what you saw -->
- Not checked: <!-- anything you couldn't run, e.g. another system -->

## Risk

<!-- What could now behave differently, and for whom. Anything deliberately left for another PR. -->
