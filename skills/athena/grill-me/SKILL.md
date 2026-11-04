---
name: Grill the plan
description: Use when the user says "grill me", asks you to poke holes in a plan, stress-test a design or idea, or find what they're missing before they build it. Questions the plan in rounds, each question with a recommended answer, until every decision is made; builds nothing until they say go.
---

A plan is a tree of decisions: each choice opens the ones that hang off it, and one answer can close a whole branch.
This skill walks that tree with the user before anything gets built, a round of questions at a time, until every
branch ends in a decision they made, a question they chose to leave open, or something they ruled out. Your part is to
look for trouble: the assumption nobody checked, the failure the plan doesn't mention, the person it forgets. Good work
ends with a short record of what was decided and why, what's open and what's out, and no code until the user says go.

## Before you start

- Read the whole plan, wherever it is: their message, a document or issue, a file in the workspace. A one-line idea is
  enough to begin; the first round will be about what it's for.
- Read what the plan touches before asking anything: the code it would change, the docs and settings, and how the
  project already handles something similar. That's where the facts come from, and it makes the questions sharper.
- If the work is already built and they want it checked, that's a review (`requesting-code-review`). A small task with
  one obvious way to do it needs a question or two, not rounds.
- While you grill, nothing in the project changes. Reading and running commands that only look are fine; code, edits,
  installs and "a quick prototype" wait for the go-ahead.

## How to do it well

### Ask the frontier, one round at a time

The frontier is every decision you can put to the user now, because all the ones it rests on are settled. Ask all of
them in one round, numbered, then stop and wait. A question that depends on
something still open in this round goes to a later one, because asking it now means assuming the answer to its parent.
When the answers come back, update the tree: a settled choice opens the questions that hung on it, a "no" prunes a
branch with everything under it, and sometimes an answer raises a branch nobody saw. Work out the new frontier and ask
the next round. The first round is usually small and about the goal and scope, since nearly everything hangs on them;
a first round full of technical questions skipped the root.

Every question carries the answer you'd pick and why, in one line. It gives the user something to push against, makes
agreeing cheap, and shows you thought it through. Give the options when there are a few; when you have no basis for a
pick, say what would decide it. "I don't know" from the user doesn't end a branch: lay out the options and what each
costs, recommend one, and if it still stays open, list it as open rather than assume an answer.

```text
I read src/reports/: the sales report loads one page of rows at a time, and nothing exports yet.

1. Who is the export for: your own team, or your customers too?
   Recommended: your team for now; customers would also need a check that they see only their own rows.
2. Should it export the rows on screen, or every row that matches the filters?
   Recommended: every matching row. An export of one page looks complete and isn't.

Waiting on 1: if customers get it too, which rows each may see and where their button goes.
```

### Facts are yours, decisions are theirs

A fact is something the project or the world can tell you: what the code does now, which version is installed, whether
a library can stream, how the project already names things. Look it up, say where you found it, and don't ask the user.
A decision is a choice with trade-offs that turns on what they want: who it's for, how much downtime is acceptable,
build or buy. Those are theirs, and so are facts only they hold (a deadline, a budget, what a customer was promised).
Don't hold a round for one lookup: ask what doesn't depend on it now and the rest next round (a helper agent, if you
can start one, can search while the user answers). When only trying will tell (is it fast enough, does the service
allow it), offer a short experiment as one of the choices; `spike` covers running one once they agree.

Their call doesn't mean your silence. When an answer contradicts an earlier one, a fact you found or the goal, say so
once, plainly, with the evidence; then note the risk they accepted and move on, and don't reopen it without something
new. A plan that looks fine at first reading hasn't been read hard enough yet.

### What to cover

Weigh the branches by what a wrong choice would cost to undo: a script one person runs once doesn't need a question
about load. Across the rounds, make sure these get asked where they matter:

- **The goal.** The problem it solves and for whom, how they'll know it worked, what's in and what's explicitly out,
  and the limits: time, money, people, tools they must or can't use.
- **Each big choice.** Why this and not the obvious alternative; what happens when the part it leans on fails; the
  worst case; how it's undone if it goes wrong, including the data it has already changed.
- **The edges.** Empty, wrong and hostile input; far more use than expected; two people at once; who may do what, and
  whose data goes where.
- **What's already there.** A pattern, library or convention the project already uses for this. Point to it by path;
  doing it another way needs a reason.

### Asking in the chat or through the Outbox

When the user is talking with you in the chat, a whole round goes in one message, so they can answer "1 yes, 2 the
second, 3 see below". When they're away (a routine, a teammate's task, or they said they'd be gone), the dashboard's way
of asking the user takes one question at a time, with a few short choices as buttons, and lands in their Outbox. Ask
one decision per question there, starting with the one most others hang on; put your recommended choice first and the
reason in the details. Either way, ask in the language the user writes in. When a decision belongs to someone else (a
client, a manager, a teammate), `decisions` turns it into a questionnaire for them to fill in, or a brief with one
problem, three options and one pick.

## Steps

1. Read the plan and what it touches; sketch the decisions and what each depends on.
2. Ask round after round until every branch is decided, left open on purpose, or out of scope.
3. Write the summary: the decisions, each with its reason; what's still open and what would settle it; what's out of
   scope; the risks they accepted. It goes in the chat, or in a file if they ask for one.
4. Ask whether to start or change something, and wait for a clear go-ahead. Answering the last round isn't one.

If the user wants to stop early, write the summary anyway and name the open decisions you'd take your recommended
answer for, so none is assumed silently.

## Done means

- Every branch ends in a decision, an open question on the list, or something ruled out, and the summary says which.
- No question asked the user for something the project could have told you.
- Nothing in the project changed during the grilling, and you have the user's go-ahead or their changes.

## Watch out for

- Questions that hide the trade-off ("Should it be fast?"). Ask them to choose between two things they'd both want.
- Reading "fine" as agreement to the whole round. When a reply is vague or skips a question, say at the top of the
  next round what you took it to mean, and ask the skipped one again.
- A summary that decides something the rounds didn't. Anything new in it goes back to the user as a question.
