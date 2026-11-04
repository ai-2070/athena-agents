---
name: Systematic debugging
description: Use when something is broken and the cause isn't known yet, such as a bug, crash or error, a failing or flaky test, wrong output, a slowdown, or "it worked yesterday". Builds a check that shows the problem, finds the cause, then fixes it there and proves the fix.
---

The quickest way to fix a bug looks like the slow one: first a check that shows the problem whenever you run it, then
evidence about where it starts, then one change at the cause. **Before you change any code, run something that shows
the bug**, if only four lines that call the suspect function at a fixed time and print the wrong date. A cause read off
a diff is still a theory, and a fix on a theory that seems to work leaves you not knowing whether it did, or what else
it changed. Good work ends with the cause stated in a sentence or two, a fix where the problem starts rather than where
it shows, a test or check that failed before the fix and passes after it, and what the bug means beyond the case
reported.

## Before you start

- **Get the symptom exactly.** The full error and stack trace, the steps or input that cause it, what should have
  happened, and where (OS, version, branch, which machine). If something's missing and the user is around, ask: a wrong
  idea of the symptom sends the whole search the wrong way.
- **Check you're running the code you're reading.** The right folder and branch, a fresh build, the server restarted,
  no stale cache or older install earlier on the PATH. Many "impossible" bugs are this.
- **Ask before a reproduction that has effects**: one that sends, posts, charges, writes to a real database or calls a
  paid API in a loop. Prefer a copy of the data, a test account or a saved response.

## How to do it well

### Build the loop first

Before reading code to form a theory, get one command that fails on the user's exact symptom and will pass once it's
fixed. Every hypothesis after that is tested by running it, and at the end it's the proof. When the bug is hard to
reproduce, this is where the effort goes. A good loop is:

- **exact**: it checks for the symptom the user reported, not "doesn't crash" or some failure nearby;
- **fast**: seconds, so you'll run it after every change. Narrow it to the failing case and skip unrelated setup;
- **deterministic**: the same result every run. Fake the clock, seed the randomness, give each run a fresh folder,
  and stub or replay the network.

Kinds of loop, roughly in the order to try them: a failing test at the level that reaches the bug; a script that makes
the HTTP request; the program run on a saved input, its output compared with what's expected; a headless browser
script; a captured request or message replayed; a throwaway harness that starts only the failing slice; a fuzz or
property test when the bad inputs are hard to guess; `git bisect run` when it worked at a known commit; a differential
run (old version against new, one config against another); and last, exact steps the user runs by hand and reports
back on. `references/repro-loops.md` has how to build each.

For a slowdown the loop is a measurement: the same work on the same machine, timed several times on the good version
and the bad. Profile before changing anything; a profiler shows where the time goes better than reading code does.

### When a test isn't the right loop

Some bugs live outside the code: a setting, an environment variable, a path, a permission, a certificate, a DNS entry,
the image a build machine runs. A test that mocks the environment proves nothing about those. Use a check you can
repeat: one command that shows the state as the program meets it (the setting it ends up with, the response header,
the resolved path, which version comes first on the PATH). Run it before the fix and after, and show both outputs.

### Flaky bugs: raise the rate first

A bug that turns up one run in many can't be studied one run at a time. Make it turn up more often before explaining
it: run it many times in fresh processes, in parallel, under load, in shuffled test order, or with a sleep added at the
spot you suspect to widen the window. These loops stop at the first failure and print only that run's output, so it
isn't lost among the passing runs (put your own command in place of this Python test):

```powershell
foreach ($i in 1..200) { $out = python -m pytest tests/test_queue.py -q 2>&1; if ($LASTEXITCODE -ne 0) { "failed on run $i"; $out; break } }; "stopped at run $i"
```

```sh
i=0; while [ "$i" -lt 200 ]; do i=$((i+1)); out=$(python -m pytest tests/test_queue.py -q 2>&1) || { echo "failed on run $i"; echo "$out"; break; }; done; echo "stopped at run $i"
```

Shell tools stop long commands (the dashboard's after 300 seconds unless you raise it), so fit the count to the limit or
put the loop in a script that runs in the background and writes a log. A test that passes alone but fails in the suite,
or the other way round, is usually sharing state with another test: run it alone, with its neighbours, then shuffled.

### Shrink the reproduction

Once the loop is red, cut it down: remove one input, step, setting, caller or row of data at a time and rerun. Keep a
cut if it stays red, put it back if it turns green, and stop when every piece left is needed. What's left often points
straight at the cause, and it becomes the regression test.

### Look before you theorise

- Read the whole error and stack trace, starting from the first error: later ones are often fallout. Search the code
  for the exact message text to find where it's raised.
- For "it worked yesterday", list what changed: the code (`git log --since`, `git diff`), the dependencies (the lock
  file's diff), runtime and tool versions, settings and environment variables, the data (a new kind of input), and the
  world outside (an API that changed, an expired token or certificate, the date: month ends, time zones, daylight
  saving). With a commit you know was good, `git bisect run` finds the change without guessing.
- Compare with something that works: a similar code path, the last good version, another machine or config. List every
  difference, including the ones that can't matter, and rule them out by running, not by reasoning.
- Say so when evidence doesn't fit: a commit dated today doesn't explain a complaint about last week. There may be a
  second cause, or the report is off; find out which, or tell the user you couldn't, rather than fix the half that fits.
- Make sure the code you're reading runs at all. A tagged print or a deliberate failure there settles it in one run.

### Hypotheses that can be proven wrong

Write down the likely causes, ranked by how likely each is and how cheap it is to test, each with the prediction it
makes: "if the cache is stale, clearing it makes the loop pass; if it isn't, the loop stays red". Sharpen or drop one
that predicts nothing you can check. If the user is around, show them the list first; they often know something that
reorders it at once.

Test the top one with the smallest probe that could disprove it, one change at a time, and undo a probe that didn't pan
out before the next. In a non-interactive shell, a short script that calls the suspect function with the bad input and
prints what comes back does a debugger's job. Tag every temporary log line with one marker (`DBG-7f3a`, say) so one
search finds them all.

### Bugs that cross several parts

When data passes through several parts (page, API, service, database; or CI, build, deploy), log what goes in and out
at each boundary, run the loop once, and see where good input turns into bad output. Then trace the bad value back to
where it's made and fix it there; a guard where it finally crashes (a null check, a catch, a retry) only moves the
symptom. For a bad HTTP call between parts, `rest-graphql-debug` goes into requests, headers and auth.

### Beyond the case reported

The reported case is one instance. Once you know the cause, work out who else it reaches and what has already happened.
A date taken in UTC is a day early east of Greenwich in the hours after local midnight (London in summer time, not
only Sydney) and a day late west of it in the evening, and invoices already sent keep their wrong date whatever the
code does now. A default list that one test fills and the next one sees is shared by every call in the running
program too: a real bug, not a test-ordering quirk. Back claims such as "only these customers" or "nothing else calls
it" with a search of the code or the data. When the fix turns on a business choice (whose time zone an invoice is
dated in, whether to reissue the wrong ones), put the options to the user rather than picking one quietly.

### When fixes keep breaking something else

If each fix moves the failure somewhere new, or the fix keeps growing, the problem is probably in the design (shared
state, two sources of truth, an assumption that never held), not in the line you're editing. Stop patching, tell the
user what each fix uncovered, and decide with them whether to rework that part.

When you're stuck, say what you don't understand rather than offering a guess as the cause. More evidence (another
boundary logged, another comparison) or a question to the user beats another attempt at a fix.

## Fixing it

1. **See the bug before you edit anything.** Run the loop and watch it show the user's symptom (the wrong date, the
   failing assertion, the message they quoted). Until then a fix is a guess, however plain the cause looks in the diff.
2. Turn the shrunk reproduction into a regression test that fails now, for the reason you found
   (`test-driven-development` covers writing it). It reaches the code the way the program does, so the same test runs
   on the old code and the new: freeze the clock or patch the dependency, rather than add a parameter such as `now=`
   that the old code rejects with an argument error instead of showing the wrong date. Aim it at the cause, so it
   fails alone and in any order (for leaked state, it makes the earlier call itself), not only after one neighbour.
   For a bug outside the code, the repeatable check takes its place.
3. Make one change, at the cause. Leave refactoring and tidying for another change: mixed in, they hide what fixed it.
4. Run the loop and the regression test and see them pass. Then see the test fail on the old code, so you know it
   tests this fix and not something nearby, without touching the user's work: undo the fix in the file, rerun and put
   it back, or copy the old file out of git (`git show HEAD:<file>`) into a scratch folder in the workspace and test
   that (`references/repro-loops.md` has a copy that's safe in PowerShell). Never `git stash`: every worktree shares
   the stash, and it can carry off the user's own changes. A refused command isn't retried in pieces: find another
   way, or ask.
5. Run the wider tests for whatever the change touches. Commit only if the user asked, staging the files by name.

## Done means

- The loop that was red on the user's symptom is green, and you watched the regression test (or check) fail without
  the fix and pass with it. A test you never saw fail is reported as unproven, not as a reproduction.
- A flaky bug has passed many more runs than it used to take to fail (`references/repro-loops.md` says how many).
- The wider tests pass, or any failure is shown to happen on the unchanged code too.
- No temporary logging, probes, harnesses or scratch copies are left: search for the marker and read the whole diff.
- You can state the cause with the evidence for it, and you've told the user what it means beyond the reported case,
  what you suspect but didn't prove, and anything nearby you noticed but didn't fix.

## Watch out for

- A loop that's red for another reason (a missing import, a wrong path, the test's own setup): it goes green for that
  reason too. `witness-discipline` has more on a test being red for the right reason.
- "Fixing" a flaky bug with a longer timeout or a retry, which mostly makes the race rarer (`witness-discipline` on
  waiting for a precondition instead of a longer window).
- Changing the test, the expected output or the assertion until it passes.

## Files

- `references/repro-loops.md`: how to build each kind of loop, make it repeatable, push a flaky bug's rate up, measure
  a slowdown, copy old files out of git to test against, and run `git bisect run` in its own worktree. Open it when
  the right loop isn't obvious or you need the old code beside the new.
