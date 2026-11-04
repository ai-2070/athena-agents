# Building the loop

How to build each kind of loop in SKILL.md, make it give the same answer every run, handle flaky bugs and slowdowns,
run a test on the old code, and bisect. Where commands differ, they're given for PowerShell (the dashboard's shell)
and a POSIX shell.

## Kinds of loop

- **A failing test** at the level that reaches the bug: a unit test when the cause is inside one function, an
  integration test when it needs a database or a second part. Start wherever you can make it fail, then move it lower
  once you know where the cause is: lower tests run faster and point closer.
- **An HTTP request**: start the server in the background (the programs tools, or `Start-Process`), keep the body in a
  file and send it with `curl.exe --data-binary '@body.json'` (in PowerShell `curl` is `Invoke-WebRequest`; elsewhere
  it's plain `curl`). Check the status and the wrong field, not just that it answered; `rest-graphql-debug` has more.
- **The program on a saved input**, its output compared with the expected. `git diff --no-index expected.txt out.txt`
  works on every OS and exits 1 when they differ (add `--ignore-cr-at-eol` unless line endings are the bug). Windows
  PowerShell 5.1's `>` writes UTF-16, which differs from a UTF-8 file on every line: let the program write its output
  file itself, or compare inside a short script.
- **A headless browser script** for a bug in a page: Playwright doing the steps and checking the page, the console or
  the network. Clicking through with a browser tool (the MCP page can add one) finds the steps; the script reruns them.
- **A replay** of a captured request (a HAR file saved from the browser's developer tools), a webhook body, a queue
  message or a logged value, fed back into the part that mishandled it. Captures can hold tokens and personal data:
  keep them in the workspace, and take the secrets out before one becomes a test fixture.
- **A throwaway harness**: a short script that starts just the failing slice and gives it the bad input. Keep it in the
  workspace (not the skill's folder or `/tmp`), and at the end turn it into a test or delete it.
- **Fuzz or property tests** when wrong output turns up for inputs you can't guess: Hypothesis (Python) and fast-check
  (JavaScript) generate inputs and shrink a failing one to a small case. Pin that case in an ordinary test; the random
  run itself is no regression test.
- **A differential run**: the same input through old and new versions, two configs or two providers, outputs compared.
  Useful when "correct" is hard to write down but "the same as before" isn't.
- **Steps a person runs**, last, when only the user can see the symptom (their account, their hardware): exact steps,
  exactly what to report back (the message shown, a value, a screenshot), and one change per round.

## Making it repeatable

- **Clock**: freeze it from outside the code: `setSystemTime` with Vitest's or Jest's fake timers, freezegun or
  time-machine in Python. Bugs at midnight, month ends and daylight saving changes show only on a fixed date, and a
  time zone bug only in the hours when the local date and the UTC date differ, so pick an instant inside them.
- **Randomness**: seed it, and print the seed when a run fails so that run can be replayed.
- **Files**: a fresh folder for each run, in the workspace, so one run's leftovers can't pass or fail the next.
- **Network**: a local stub or saved responses. A live service changes under you, and calling it in a loop may cost.
- **Order**: run the test alone, in its file, in the suite, then shuffled (`go test -shuffle on`,
  `vitest run --sequence.shuffle`; both print a seed that repeats the order). Failing only in parallel: try one worker.

## Flaky bugs

- Repeating inside the runner (`go test -run TestName -count=500`, the pytest-repeat plugin's `--count`, Playwright's
  `--repeat-each`) is quick but reuses a process or worker; the shell loops in SKILL.md start fresh each time. They
  catch different flakes, so try both. Go's `-race` flag reports data races directly.
- Load brings races out: more parallel workers, another heavy job running. A sleep at the suspected spot widens the
  window; if the failure rate jumps, that's evidence for the race. Tag it and take it out afterwards.
- How many clean runs prove the fix: by the rule of three, zero failures in n runs still allows a failure rate of up
  to about 3/n (at 95% confidence). So if it used to fail about once in k runs, aim for 3k clean runs; fewer is weak
  evidence, and the report should say so rather than calling it fixed.

## Slower than it was

- Time the same work on the same machine, after a warm-up run, several times on each version, and compare the middle
  values. One run against one run is mostly noise.
- Profile before changing anything: `python -m cProfile -s cumtime script.py`, `node --cpu-prof script.js` (it writes a
  `.cpuprofile` file, which Chrome's developer tools can load), or the browser's Performance panel for a page.
- To bisect it, the check times the work and exits 1 above a threshold set between the good and bad times, far enough
  from both that noise can't flip it. `git bisect start --term-old=fast --term-new=slow` makes the log read that way.

## The old code beside the new

`git show HEAD:<file>` prints the committed version of a file (the old code, when your fix is the only change to it),
but Windows PowerShell 5.1's `>` saves it as UTF-16, and the old code then fails for that reason instead of the bug.
This copies files or whole folders byte for byte on every OS (`tar` comes with Windows 10 and later) and leaves the
working copy alone:

```
git archive -o <scratch>/old.tar HEAD <file-or-folder>
tar -xf <scratch>/old.tar -C <scratch>
```

They land under `<scratch>` at their paths in the repo. Take the whole package folder when the file imports its
neighbours, copy the new test in at its own path, and run it from `<scratch>` so the old files are the ones imported.
Delete the folder afterwards.

## Running git bisect

Bisect checks out old commits in the folder it runs in, so give it its own worktree (a new folder outside the repo)
rather than the user's working copy. The worktree and bisect's markers are written into the repo, so ask the user
first. One command per line, the same in PowerShell and a POSIX shell:

```
git worktree add --detach <folder> HEAD
cd <folder>
git bisect start HEAD <good-commit>
git bisect run python <path-to>/check.py
git bisect reset
cd <back-to-the-repo>
git worktree remove <folder>
```

- The check exits 0 when the commit is good, 1 when it's bad, and 125 when it can't be tested (it doesn't build), which
  skips that commit; a code above 127 stops the bisect. Write it in Python or Node so it behaves the same on every OS,
  and keep it outside the repo so every old commit can run it. If dependencies changed over the range, it installs or
  builds first and exits 125 when that fails.
- Bisect ends with "<sha> is the first bad commit". Read that diff before calling it the cause: a commit can expose a
  bug that was already there. `git bisect log` keeps the steps, for showing the user.
