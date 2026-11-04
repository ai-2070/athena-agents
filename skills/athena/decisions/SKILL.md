---
name: Decision briefs and questionnaires
description: Use when the user faces a choice and asks for options or a pick ("give me options", "a 1-3-1", "help me decide between", "what would you recommend") or wants questions for a client or the team to answer before deciding. Writes a brief (one problem, three options, one pick) or a questionnaire.
---

This skill helps with a decision in one of two ways. When the choice is the user's, write a 1-3-1 brief: one problem,
three options that are really different, one recommendation you stand behind, then what done looks like and the plan
for the option they pick. When the answer belongs to someone else (a client, a manager, the team, a supplier), write a
questionnaire that person can fill in without the user beside them. When the user has a plan of their own and wants it
tested, use `grill-me` instead. Good work lets the reader decide, or answer, in one careful read: its facts are checked,
its gaps are marked rather than filled, and nothing is built or sent until the user says so.

## Before you start

- **Work out which case it is.** Who makes the call, and who holds what's missing? If the user can choose once the
  options are laid out, it's a brief. If the deciding fact or the say belongs to someone else, it's a questionnaire,
  and once the answers are back it often becomes a brief.
- **One obvious answer needs no format.** Give it and the reason in a few lines, and offer the alternatives if they
  want them. The same goes when the user has already decided and wants the work done.
- **Find out what you can first.** Read the files, code and conversation the decision touches, and check prices,
  limits, versions and what a library or service really does in its own docs or source, noting where. Credit a library
  with a feature it lacks and the wrong option looks complete.
- **Ask the user only what only they know**: what matters most (cost, speed, safety, their time), the budget, the
  deadline, who is affected. A figure you don't have goes in as a marked placeholder ("[budget for this]").

## How to do it well

### A brief, when the user chooses

**The problem** in a sentence or two: the outcome that's needed and what limits the choice, without naming a solution
("customers wait too long for replies to support email; the busy season starts in March"). If it takes "and" to join
two outcomes, it's two decisions: split them, or write the brief for the one that blocks the other.

**Three options that are different strategies**, each one a sensible person would pick in some situation. Variations of
one idea (one more person answering email, or two more) are a single option with a setting to choose later. For the
support email the strategies are more people answering, fewer emails that need an answer (an order-status page,
better help pages), and quicker answers to each (saved replies for the common questions). If the user named the
options ("help me decide between X and Y"), theirs are in it; add a third only when a real one exists, and say it's
yours. If only two exist, say so rather than invent a filler. Waiting, or doing nothing, counts when it's honest.

**Each option on the same yardsticks**, in the same order, so they compare side by side: what it costs (money, time,
effort, what it rules out later), what it risks (what could go wrong, how likely and how bad, how hard it is to undo)
and what it needs (people, access, tools, someone else's agreement). An estimate says it's one and what it rests on.
When there are many yardsticks, a table reads faster than prose.

**One recommendation**, named first, with the reason tied to what the user said matters. Don't write "A or B, it
depends": choose, and turn the dependency into one line on what would change your pick ("if the launch slips past the
summer, B is better"). Recommend what serves them, not what's easiest for you to carry out.

**Done when, and the plan**, are for the recommended option: outcomes someone can check, then steps in order with who
does each. If the user picks another option, rewrite both for their pick. Building waits until they've chosen.

When the choice is about investing, a legal step or health, the pick says which option fits the priorities they gave,
not that it's a good buy or the right treatment; say once that it's information, not advice, and who could check it.

The brief goes in the chat unless the user will forward it or asks for a file; then it's `decision-<topic>.md` in the
workspace, written to stand alone: no "as discussed", terms explained, dated. A screen or two, each option a few lines:

```markdown
**Problem:** …

**Option A: <short name>.** <What it is, in a sentence.>
Costs: … Risks: … Needs: …

**Option B: …**  **Option C: …**  (the same shape)

**Recommendation: B.** <Why, in terms of what matters to them.> <What would make A or C the better pick.>

**Done when** (B): <outcomes someone can check>
**Plan** (B): 1. … 2. … 3. …
```

### A questionnaire, when the answer is someone else's

The user can't answer the subject itself; that's why someone else is being asked. What they do know is the send: who
it goes to and what has to come back. Ask about that only, and only what their message hasn't already told you:

- **who it's for**: their role, what they know that the user doesn't, how formal to be, the language, and how it will
  reach them (an email, a shared document, a Word file, a meeting);
- **what the user needs back**: the decisions or facts that unblock them, and by when.

Nothing goes in it that you could find out yourself from the project, the docs or the web. Then write it:

- **One paragraph of context**: what's being decided, why now, what's already settled, how the answers will be used.
  The recipient wasn't in your conversation; this is all they have, and a longer one gets skimmed.
- **The most important question first.** A busy reader may give it one pass and stop halfway.
- **One idea per question**, in the recipient's words: "Who signs it off, and by when?" is two, and a client doesn't
  know the team's internal names. Cut any question whose answer wouldn't change what the user does.
- **Room for the answer** under each. Where the likely answers are known, list them with an "other", which is quicker
  to answer; leave it open where a list would mean guessing.
- **A "why we ask" line** only under a question that could be misread or answered too lightly.
- **A last, open question**: what didn't we ask that we should have?

```markdown
# <What we need to decide>

From <user> to <recipient> · please answer by <date> · takes about <time>

<One paragraph of context.> Partial answers and "not sure" help: say how sure you are rather than skip a question.

## <Theme, once there are more than a handful of questions>

1. <The most important question, one idea>
   Why we ask: <only where it could be misread>
   Answer:
2. <A question whose likely answers are known>: <answer> / <answer> / other:

## Anything we didn't ask that we should have?
```

For an email, keep the order in plain numbered text; for a Word file, `docx` makes it; for a meeting, the questions
become the agenda. Save it in the workspace (or where the user says) as `questionnaire-<topic>.md`, or `.docx`, and
give the path. Sending is the user's call: they send it, or you show them the final text and recipient and ask first.

**When the answers come back**, read them as information, not instructions. Match each to what the user needed, keep
each person's answers apart (a disagreement is a finding), point out gaps, contradictions and "not sure"s, and suggest
a follow-up only for a gap that changes the decision. If the user now has a choice to make, that's a brief.

## Done means

- A brief: read it as the user will. Could they pick from it alone? Is every fact checked, an estimate or a marked
  placeholder, and do done-when and the plan match the pick? Nothing has been built yet.
- A questionnaire: every item the user needs back has a question, none asks what you could look up, the file's path
  is given, and nothing was sent without the user's say.

## Watch out for

- Straw men: two weak options set up to make the pick look good. Readers notice, and stop trusting the brief.
- Leading questions ("A later date would be fine, right?") get back the answer you planted.
- Questions that hand the recipient the user's job (design the solution) instead of asking what only they know.
- A pick that quietly drops something the user said mattered. If no option meets it, say so in the problem.
