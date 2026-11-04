---
name: Test-driven development
description: Use when asked to write tests first or use TDD, to add a feature or change behaviour with tests, to fix a bug and add a regression test, or to put tests around old code before changing it. One failing test at a time, seen to fail for the right reason, then the least code that passes.
---

Test-driven development grows code in small steps: a test for the next thing the code should do, run and seen to fail
for the reason you expect, then the least code that makes it pass, then tidying while every test stays green. The
failure you watched is what gives the test its worth: it shows the test reaches the code and can tell the behaviour
is missing. Good work ends with each new behaviour pinned by a test that was red before its code and green after,
code no bigger than those tests ask for, the wider suite passing, and a plain account of what was left untested and why.

## Before you start

- **Find how the project tests.** The command is in its scripts or config (`package.json`, `pyproject.toml`, a
  Makefile, the CI workflow) or its README. Read a few neighbouring tests and follow their location, naming, helpers
  and fixtures rather than starting a style of your own.
- **Run the relevant tests once before changing anything.** Failures that were already there go in your report; they
  aren't fixed quietly or blamed on your change later. If the whole suite takes minutes, run the tests near the change
  during the cycle and the whole suite at the end, raising the shell's time limit for that one call.
- **Know what the code should do.** Every test needs an expected value. Where the request leaves one open (what an
  empty cart totals, whether a name match ignores case), ask the user. If they aren't around, take the plainest
  reading, say it in the test's name or a comment, and list it in your report as an assumption to confirm.
- **No test setup at all?** The language's own runner needs nothing installed (Python's `unittest`, `node --test`).
  Adding pytest, Vitest or another framework is an install: ask first.

## The cycle

1. **List the behaviours** the change needs, as short notes rather than tests: the plain case, the edges, the errors.
   Start with the simplest real case; it teaches you the most about the interface.
2. **Write one test** for one behaviour, calling the code the way its callers will.
3. **Run just that test and read why it failed.** The red you want is an assertion saying the behaviour is missing:
   a value that doesn't match, an error that wasn't raised. An import error, a misspelt name, a wrong argument or a
   broken fixture is red for the wrong reason, and it turns green for that reason too. The exit code doesn't separate
   them (pytest counts a `TypeError` as a failed test, exit 1, like a real one), so read the failure line. For a new
   function, add a stub first with the real signature and an empty or wrong result, so the red comes from the
   assertion. `witness-discipline` goes further into tests that prove what they claim.
4. **Write the least code that passes**: no options, logging or cases that no test asks for yet. A hardcoded answer
   is fine for a moment; the next test on your list forces the general one.
5. **Run it, then the tests around it**, and see them pass. A failure there is fixed in the code.
6. **Tidy while green**: names, duplication, structure, one small step at a time with a test run after each. A step
   that turns them red is undone and taken again smaller, not debugged. Undo your own edit by hand: `git checkout` or
   `git restore` on the file would also throw away the user's uncommitted changes in it.
7. Take the next behaviour from the list.

Running one test by name looks like this (in Windows PowerShell, `npx.cmd` where running scripts is disabled):

```
python -m pytest tests/test_slug.py::test_keeps_digits -q
npx vitest run tests/slug.test.ts -t "keeps digits"
```

A test that passes the first time it runs is testing something that already works. Either the behaviour exists (tell
the user; there may be less to build) or the test never reaches the new code: a file the runner doesn't collect, the
wrong function imported, an assertion too loose to fail. Put a wrong expected value in for one run: if it still
passes, the test isn't running what you think.

## How to do it well

**One test, then its code.** Writing every test up front locks in guesses about an interface nobody has used yet, and
a wall of reds can't show which change fixed which. Each pair is a thin slice through the whole path, like a tracer
bullet, and what it teaches shapes the next test.

**A good test** checks one behaviour and is named for it (`rejects an expired coupon`, not `test_coupon_3`), so a
failure reads like a bug report. It checks outcomes (what comes back, what's stored or sent), not which private
helpers ran, so tidying doesn't break it. It uses real code wherever that's cheap: a temp folder, an in-memory
database, the real parser. Fake only what is slow, costly, random or outside the program (the network, the clock, a
paid API, email). A test that checks a mock was called with what the code handed it proves only that the code calls
the mock. Edges and errors get tests of their own: empty input, the boundary, a bad value, a dependency that fails.

**Hard to test is a design signal.** A test that needs a pile of mocks, a long setup or a peek at private state is
saying the code does too much or is knotted into its inputs and outputs. Pull the decision into a function that takes
plain values and returns plain values, and keep the file, network and database calls thin around it. If that reshaping
reaches beyond the task, put it to the user before doing it.

**Fixing a bug** starts with a test that reproduces it and fails, before any edit to the code. `systematic-debugging`
finds the cause, and its "Fixing it" steps take that test from red to green and then prove it against the old code.

**Old code with no tests: pin it first.** Before changing it, write characterization tests that record what it does
today, right or wrong. Call it with realistic inputs, assert a placeholder, let the failure print the real value, read
it, and put it in. Pin oddities as they are, with a comment, and tell the user: fixing them is a separate decision, not
a side effect of a refactor. These tests pass from the start, so show they can catch a change: break the code on
purpose (flip a comparison), watch one go red, and restore it exactly (`witness-discipline`'s inverse rule). Then make
the change test-first.

**Code that came before its test**, the user's or yours, stays. Deleting work to redo it test-first throws away what
it knows, and it isn't yours to throw away. Write tests for it, and have each prove itself by failing without the code
it covers. Such a test reaches the code through the interface it has today, so it also runs on the version before the
change: freeze the clock or patch the dependency from outside rather than add a parameter (`now=`) the old code
rejects with an argument error. To see it fail, undo your own edit, rerun and put it back. For the user's uncommitted
work, copy the committed version into a scratch folder in the workspace
(`git archive -o <scratch>/old.tar HEAD <path>`, then `tar -xf <scratch>/old.tar -C <scratch>`), copy the new test in
at its own path, run it there and delete the folder. For code already committed, break it on purpose as above. Never
`git stash`: every worktree shares it, and it can take the user's work.

**Test-first is the default, not a rule for every function.** Where it fits badly, use the check that fits, and tell
the user what wasn't tested first and how you checked it instead:

- Layout and look: no assertion says "this looks right". Look at it in a browser or a screenshot, and drive the logic
  behind it (formatting, state, validation) test-first.
- Finding out whether or how something can work at all: that's a `spike`. Its code is thrown away or rebuilt
  test-first, and what it found becomes the first tests.
- Throwaway prototypes and one-off scripts: a run on real input is the check.
- Generated code, config files and thin glue: test them through the code that uses them.

## Done means

- Each new behaviour has a test you saw fail for the right reason, then pass, and you can quote the failure line.
- The wider suite passes, or any failure is shown to happen on the unchanged code too.
- No `.only`, skip marker, scratch copy, probe or stray debug output is left: read the whole diff.
- Your report names the tests added and what each failed with before its code, what wasn't tested first and why, and
  any assumption about behaviour the user should confirm. Commit only if asked, staging the files by name.

## Watch out for

- A name filter that matches nothing. A runner can mark every test skipped and exit 0 (Vitest's `-t` does), while
  pytest's `-k` exits 5. Check how many tests actually ran.
- Turning a red test green by changing the test: the expected value, the assertion, or snapshots accepted with `-u`
  without reading what changed. If the old expectation was wrong, say so in your report.
- An existing test that breaks under your change. It's a regression or a change in behaviour the user should hear
  about; it isn't deleted or loosened to get through.
- Tests that pass alone and fail together, or the reverse: shared state, the real clock, the order they run in. Each
  test builds the world it needs; `systematic-debugging` covers chasing one down.
