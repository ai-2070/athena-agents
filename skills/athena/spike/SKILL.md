---
name: Spikes
description: Use when the user asks for a spike, asks if something is feasible, wants to try out X before building it, wants a prototype or proof of concept to see if it works, or asks which approach works. Breaks the idea into throwaway experiments, riskiest first, each ending in a verdict.
---

A spike is a small, throwaway experiment that answers one question before anyone builds the real thing: can this work
under the conditions it will meet, and which way works best? It produces knowledge, not code. Good work turns a vague
idea into a few questions with results someone can see, runs the one most likely to kill the idea first, builds the
least that answers honestly, pushes past the easy case, and closes each spike with a verdict and a short record for the
real build. Finding out that an idea fails is a good result, learned at the cheapest moment.

Not every question needs one. If the docs or the code would settle it, read them. How something should look or feel is
a job for `sketch` (throwaway design mockups), and when the doubt is what to build rather than whether it can work,
`grill-me` questions the plan first.

## Before you start

- **Where the code goes.** Ask before writing any: a `spikes` folder in your workspace, apart from the project's code,
  or one the user names (not `/tmp` or this skill's folder), with a folder per spike (`1-offline-transcript`). In a git
  repository, give it a `.gitignore` holding the line `*`, written with your file tools (PowerShell's `>` saves UTF-16,
  which git can't read), so git ignores the folder and no tracked file changes. Commit spikes only if asked.
- **Their own dependencies**, out of the project's lock files, set up from inside the spike's folder. Python:
  `python -m venv .venv`, then `.\.venv\Scripts\python -m pip install …` in PowerShell or
  `.venv/bin/python -m pip install …` elsewhere. Node: `npm init -y` before any install, since without a
  `package.json` there npm walks up to the nearest folder with one, perhaps the project's, and installs into it.
  Installing is the user's call: ask first.
- **Copies, not real systems**: sample data copied into the spike folder, a test account, a sandbox key. Ask before
  anything that sends, posts, charges or writes to a real system, or loops over paid calls. Keys come from environment
  variables, never from the spike's files.
- **The targets** (how fast, how big, which systems and data) come from the user. Ask, or write a marked placeholder
  ("[longest wait you'd accept]"); don't choose the number yourself.

## How to do it well

### Turn the idea into questions

Split the idea into a few independent questions about whether something can work, each with a result someone can see,
written as Given / When / Then: the setup, the action, what you'll observe if the answer is yes. "Can we use library
X?" is too vague, and "read up on X" is research. "Given the user's largest real export, when X parses it on their
laptop, then every row comes through within [target]" is a spike. When two approaches could answer one question, make
it a comparison: one number, a letter per approach (2a, 2b), the same inputs and the same measurement.

An illustration, for making voice memos searchable offline (in a real list, the sizes and targets are the user's):

| # | Given / When / Then | Why it's risky |
|---|---|---|
| 1 | Given a 40-minute memo from their phone, when it's transcribed on their laptop offline, then the text is readable and done within [wait they accept] | Too slow without a graphics card would end the idea |
| 2a | Given 200 transcripts, when they search for a phrase they half remember, then the right memo is in the top three, using keyword search | Half-remembered phrases may need search by meaning |
| 2b | The same, using embeddings | Heavier to set up and run |
| 3 | Given a memo that switches language halfway, when it's transcribed, then both parts come out right | Their memos mix two languages |

**Riskiest first**: order the list by how likely each question is to kill the idea. If that one fails, nothing else
needs building; starting with the easy parts feels like progress and teaches nothing. **Agree the list** before you
build: show it in that order, with roughly how much effort each spike gets, and let the user drop, reorder or reword.
If they've already named one precise question, that's the list.

### Research just enough

Before each spike's code, say in two or three sentences what it tests and why it matters. Where there's a real choice
of library or service, weigh the credible ones (recent releases and answered issues, licence, support for the user's
system, cost) from their own docs or source. Check what's installed (`python -m pip show <package>`, `npm ls <package>`)
and the latest release (`python -m pip index versions <package>`, `npm view <package> version`). Pick one and say why;
if two stay credible, compare them. Pure logic needs no research.

### Build the least that answers

- Hardcode inputs, paths, settings and the one user (keys aside), and skip what the question doesn't touch: containers,
  config files, bundlers, sign-in, error handling, tidy structure, unless the question is about one of them.
- Give the user something to try, not a log line saying it worked. In order of preference: a small command-line program
  that takes their input and prints the result; one HTML page with its script inline, which opens straight from disk;
  a local server with one endpoint; a test whose assertions read like the question.
- Start servers in the background (the programs tools, `Start-Process` in PowerShell, `&` in a POSIX shell) on
  `127.0.0.1` only, and stop them after; `python -m http.server` listens on every interface without `--bind 127.0.0.1`.
- Run it where the risk lives: the user's operating system, real sizes, their network. A small sample says nothing
  about their largest file, and a mocked API says nothing about the API.
- If you can start helper agents, run independent spikes in parallel, each given its question, folder, the shared
  inputs and the measurement. Rerun the deciding measurement yourself before writing up a comparison.

### Try to break it

One run on friendly input proves little. Feed it what the real thing will meet: empty, huge and malformed input,
non-English text, Windows paths with spaces, a slow or dropped connection, two at once, a second run after the first.
Time things over several runs, cold and warm, on a named machine. Follow surprises: they're often the best finding. If
a spike runs well past its agreed effort, stop and report; being hard to make work is a finding too.

### Verdicts

- **validated**: the answer is yes, and a run shows it;
- **partial**: yes, under named conditions (below some size, on one system, on a paid tier);
- **invalidated**: no, and why. A successful spike: it cost hours, not the build.

A verdict rests on a run, not on reading: "the docs say it supports X" is research. Don't shift the question to one
that passes; "yes, if…" is partial, with the "if" written down. Record it in the spike's `README.md`, and keep a line
per spike (number, name, verdict) in the spikes folder's own `README.md` so a later session sees where things stand.

```markdown
Spike 2a: keyword search over transcripts
Question: Given …, when …, then …
Approach: what was built, and why this way
Try it: python search.py "invoice from Marta"
Results: what happened, with the measured figures and the machine they came from
Edge cases tried: …   Not tried: …
Verdict: validated | partial | invalidated.   Worked: …   Didn't: …   Surprises: …
For the real build: …
```

**Comparisons** are built back to back on identical inputs and end with a head-to-head table: a row per thing the user
cares about (how well it answers, setup, speed, edge cases handled, running cost, how active the project is), each cell
from a run, not an impression. Name the winner for this case, and when the other would win.

### Picking the next spike

After a round, or when the user asks what to try next, look across the verdicts for integration risks (two validated
spikes that share a file, a port, a graphics card or a rate limit but were tested apart), hand-offs nobody tried (spike
1's output assumed to fit spike 2's input), gaps (something the idea relies on that no spike touched), and other angles
on a partial or invalidated spike. Propose a few as Given / When / Then and let the user choose.

## Done means

- Every agreed spike has a verdict backed by a run the user can repeat from its README, with figures copied from that
  run. The user has tried it, or has the exact command.
- Nothing from the spikes is in the project's code, lock files or settings: `git status` shows what it showed before,
  apart from a spike folder the user chose to keep visible. Servers you started are stopped.
- Your summary gives each verdict, the recommendation for the real build, what to spike next if anything, and where the
  folder is. It stays until the user decides; offer to delete it rather than deleting it.

## Watch out for

- A spike growing into the product ("it works, let's just tidy it up"): its shortcuts are what made it quick. The real
  build starts fresh from the recommendation, with tests (`test-driven-development`), and uses the spike as a reference.
- Building around the question: a settings page, a nicer layout, a second feature. Time there isn't spent on the risk.
- An unfair comparison: one variant tuned, warmed up or run on easier inputs than the other.
