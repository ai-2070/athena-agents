# Team orchestration: four fixes

Plan, 31 October 2026. Follows the comparison in
[`docs/internal/GROK_BOT_ORCHESTRATION_2026-10-31.md`](../GROK_BOT_ORCHESTRATION_2026-10-31.md).

Four limitations came out of that comparison. One is already fixed and only needs closing out; one is a
real bug that loses information; two are cheap honesty fixes. Nothing here copies Grok Bot's shape — its
three-round cap and its per-turn turn budget would break the long-running team work this product is built
around.

| # | Item | Verdict | Size | Order |
|---|---|---|---|---|
| 1 | Cross-project state | Already fixed in code; verify and lock it with a test | ~1 h | First |
| 2 | The thread digest drops messages, permanently and silently | **Bug. Fix it.** | ~½ day incl. test | Second |
| 3 | The routing fallback picks the first member, blindly | Small fix: skip whoever is busy, and say so in the thread | ~1 h | Third |
| 4 | Two members can duplicate work, and neither can see it | Disclosure: tell each turn who else is working right now | ~1 h | Fourth |

Sequencing note: 1 is a check, not a change. 2 is the only one with data loss behind it, so if only one
item gets done, do 2. 3 and 4 are independent of each other and of 2.

## 1. Cross-project state — verify, then lock it

**What we believed.** The 2026-10-28 review found the team runtime keyed by team id alone and handoffs
matched on `from: agent.id`, so a cloned or restored project could share stop and queue state, and an agent
in project B could list project A's handles.

**What the code says now.** Already addressed:

| Guard | Where |
|---|---|
| `const rt = new Map<string, Runtime>()` keyed `<project id>/<team id>` | [`server/teams.ts:161`](../../../server/teams.ts#L161) |
| `runtime(teamId, pid = activeProject().id)` | [`server/teams.ts:162`](../../../server/teams.ts#L162) |
| `teamRunId = team:<project>/<team>` | [`server/teams.ts:168`](../../../server/teams.ts#L168) |
| Handoffs carry `projectId` and are matched on it plus `from` | [`server/handoffs.ts:42`](../../../server/handoffs.ts#L42), [`:72-74`](../../../server/handoffs.ts#L72-L74) |

**Change.** None to the code. Two things to do:

1. Confirm `tests/server/project-isolation.test.ts` covers **team stop/queue state across a clone** and
   **handoff ownership across a clone**. It covers project isolation generally; if those two cases are
   missing, add them (a cloned team must not be stopped by, and must not answer, the original).
2. Leave the residual risk visible: the maps are still process-global and keyed by id, with a project check
   at each access. That is fine, but a new call site that forgets the check fails the same way. The test in
   (1) is what makes forgetting fail loudly.

**Acceptance.** With a clone of a project open, stopping the clone's team leaves the original's turns
running, and `await_agent` in the clone cannot collect a handle created in the original.

**Risk.** None. Test-only.

## 2. The thread digest drops messages, permanently and silently

**Problem.** Each turn, an agent is given the messages posted since it last spoke, newest first, and the
loop stops as soon as the next line would push the digest past the cap:

```ts
let digest = '';
for (const m of fresh.slice().reverse()) {
  const line = said(m);
  if (digest.length + line.length > CONTEXT_CHARS) break;   // CONTEXT_CHARS = 9000
  digest = `${line}\n\n${digest}`;
}
```

[`server/teams.ts:633-637`](../../../server/teams.ts#L633-L637), cap at
[`:25`](../../../server/teams.ts#L25).

The cap itself is reasonable. The defect is the line after it:

```ts
c.seen[agent.id] = c.messages.length;   // server/teams.ts:647
```

The read mark jumps to the end of the thread regardless of what actually fit in the digest. Every message
dropped by the `break` is therefore marked as read and **never delivered on any later turn**. The agent
answers in a thread whose earlier half it has never seen, with nothing in the prompt to say so. On a busy
team — a few hundred messages, or a handful of long ones — this is routine, not an edge case.

**Change.** Keep the cap and keep `seen` where it is (advancing it only part way would re-send the same
backlog every turn and stall the agent at the cap forever). Instead, *fold* what does not fit:

1. When the cap is reached, take the remaining older messages — one compact line each, the same author name
   as `said()` uses plus the first `EARLIER_CHARS` characters — joined into one block.
2. Cap that block too (`EARLIER_CHARS = 120` per message, `EARLIER_BUDGET = 2000` characters total). If the
   fold itself overflows, keep the newest of the folded lines and add a count:
   `…and N earlier messages (not shown).`
3. Put the block at the top of the digest under a plain heading:
   `Earlier in this chat (shortened):`
4. Model-free, like the repo's existing "instant" compaction — no extra model call, no new dependency.

Worth considering while in here: fold *user* and *Brain* messages at a longer slice (say 400 characters)
than agents' replies, because they carry the intent the work is against.

**Acceptance.** Seed a team thread whose unread messages total well over 9 000 characters, run one turn, and
the prompt contains an `Earlier in this chat (shortened):` block that names the **oldest** unread author and
states how many messages were folded; the newest message still appears in full; and no unread author is
missing from the prompt entirely.

**Tests.** New `tests/server/team-digest.test.ts`, modelled on the fake OpenAI-compatible server in
[`tests/server/teams.test.ts`](../../../tests/server/teams.test.ts) (it records `lastAsk[who]`, which is
exactly the prompt we want to assert on). Three cases: under the cap (no fold block appears), over the cap
(fold block with the oldest author and a count), and a single oversized message (still delivered, marked).

**Risk.** The prompt grows by at most `EARLIER_BUDGET` characters per turn — bounded, and far cheaper than
the model call it sits in front of. No schema change, no UI change, no migration: `seen` is internal to
`TeamChat`.

## 3. The routing fallback picks the first member, blindly

**Problem.** The routing ladder ends like this:

```ts
const pick = route ? await route(...).catch(() => null) : null;
...
targets = [pick && team.members.includes(pick) ? pick : team.members[0]];
why = pick ? 'best fit' : 'first member';
```

[`server/teams.ts:291-297`](../../../server/teams.ts#L291-L297).

Two things are wrong with the fallback and one with what follows it:

- `team.members[0]` may already be mid-turn, so the team can queue work behind a busy member while another
  sits idle.
- Nothing in the thread says the choice was arbitrary. `why` is emitted as a transient `kind: 'routed'`
  event, and **that event is not rendered anywhere** — the type exists in
  [`web/teamchat.tsx:33`](../../../web/teamchat.tsx#L33) and
  [`web/views/station.ts:442`](../../../web/views/station.ts#L442), but no component handles it. So the user
  sees an answer from an agent they never asked, with no explanation.

**Change.**

1. Skip whoever is busy: take the first member not in `r.running`; fall back to `team.members[0]` only when
   everyone is busy.
2. When the pick was arbitrary, post one line to the thread as the existing `system` author, so it lands in
   the transcript (persisted, survives reload, visible in every surface that already draws a team):
   `Nobody matched: asked @Name, the first member free.`
   Post it **only** in the arbitrary branch — never for mentions, the lead, or a best-fit pick. Reusing the
   `system` author is deliberately cheaper than teaching the UI to render `routed`, and it puts the
   explanation where the conversation is rather than in a toast that disappears.

**Acceptance.** With `route()` returning `null` and two idle members, the first is asked and the thread shows
the `Nobody matched:` line naming it; with the first member already working, the second is asked instead; a
message that names a teammate, matches a service, or has a lead produces no such line.

**Tests.** Extend [`tests/server/services.test.ts`](../../../tests/server/services.test.ts) — it already
collects `routed` events with a stubbed route function, so it can assert both the chosen member and that no
system line appears in the matched cases. A second case with a member made busy asserts the skip.

**Risk.** The system line is extra thread noise, but only on the rare path, and it is the honest kind of
noise. It also enters later digests, which is the point.

## 4. Two members can duplicate work, and neither can see it

**Problem.** When a message routes to several members, `enqueue()` gives each its own turn and `pump()`
starts them all at once (one turn per agent, several agents at a time —
[`server/teams.ts:510-560`](../../../server/teams.ts#L510-L560)). That concurrency is deliberate: the
briefing tells every member to start their own part without waiting for teammates
([`server/teams.ts:601-607`](../../../server/teams.ts#L601-L607)). But a turn's prompt says only what is new
since that member last spoke and what is addressed to it
([`:653`](../../../server/teams.ts#L653)). It cannot see that another member is being handed the same
message right now. The roster is in the briefing, the read marks are per agent, and the "one owner per
stage" rule is prose.

The user can see the concurrency — `teamState().working` is emitted and drawn — but the agents cannot. That
asymmetry is the whole gap.

**Change.** Disclosure, not enforcement. At the start of `runTurn`, before the prompt is built:

```ts
const alsoWorking = [...r.running].filter((id) => id !== agent.id);
```

and, only when it is non-empty, add one line to the prompt's tail block:

```
Also working on this right now: @Maker, @Editor
```

Do **not** build a lock, a claim, or a duplicate detector. Detection would need to know what "the same work"
means, which we can only guess from text; enforcement would serialise the team, which is the opposite of how
it is designed to work. Saying who else is on it is enough for a competent member to split the task or step
aside, and it costs one line.

**Acceptance.** With one message routed to two members, the second turn's prompt names the first as also
working; a turn with nobody else running has no such line.

**Tests.** Extend [`tests/server/teams.test.ts`](../../../tests/server/teams.test.ts): its fake model already
records `lastAsk[who]`, so assert `lastAsk['Maker']` contains `Also working on this right now:` and
`lastAsk['Lead']` (a solo turn) does not.

**Risk.** A member may wait for the other instead of doing its part, weakening the "start now" rule. The
briefing's "Do your own part fully before handing off… don't redo work a teammate owns" already frames this;
if the line proves to make agents passive, drop it — it is one string.

## Not doing

- **A structural turn cap for teams** (Grok Bot's three rounds, ten member turns). The product's promise is
  "agents keep handing work to each other until the work is done". A cap would end long jobs mid-flight.
- **Duplicate detection or locking.** See above; the disclosure in item 4 is the cheap half.
- **First-class silence** (`(pass)` instead of posting `(no answer)`). Tempting, and it is what Grok Bot
  does better, but it changes what a member's empty turn means to the Brain's `reviewWork`, to the relay
  protocol, and to the UI. Worth a plan of its own if we ever want it; not in this one.

## Verification

1. `bun run check` (typecheck for `server/` and `web/`, then the test suite) — this is the gate before done.
2. The new and extended tests above must fail before the change and pass after. Item 2's test in particular:
   the fold assertion cannot pass on today's code.
3. One manual pass in the app, on a team with a real thread: post enough messages to cross 9 000 characters,
   confirm the next agent's turn shows the fold block (item 2); remove the lead and the service match from a
   team, send a message, and confirm the `Nobody matched:` line names the member that answers (item 3);
   route one message to two members and confirm the second is told who else is on it (item 4).

## Docs to touch when the code lands

- [`docs/guide.md`](../../../docs/guide.md) "The Brain and your teams" — the `Nobody matched:` line is
  user-visible, so the sentence about who answers should mention it.
- [`docs/internal/GROK_BOT_ORCHESTRATION_2026-10-31.md`](../GROK_BOT_ORCHESTRATION_2026-10-31.md) — move the
  three rows out of "Disadvantages" as they are fixed.
