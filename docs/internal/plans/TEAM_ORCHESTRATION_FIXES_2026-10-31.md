# Team orchestration: four follow-ups

Plan, 31 October 2026. Follows the comparison in
[`docs/internal/GROK_BOT_ORCHESTRATION_2026-10-31.md`](../GROK_BOT_ORCHESTRATION_2026-10-31.md).

**Implementation, 31 October 2026.** All four follow-ups are implemented on
`fix/team-orchestration-2026-10-31`:

- Clone tests cover team running turns, queues, Stop, reply storage and handoff ownership.
- `server/teamdigest.ts` builds bounded recent context and older previews, reserves the oldest preview,
  counts omissions, and marks clipped message text in both context and addressed messages.
- Fallback routing explains a free or queued choice. It also rechecks the roster after the router returns:
  removing a member during selection previously dropped the request without starting a replacement.
- Initial routing, agent handoffs and Brain replies enqueue known targets together. Turn prompts disclose
  current and queued peers assigned overlapping messages, including the first member started.
- README, guide and comparison note describe the resulting behavior and its remaining limits.

The regression tests for new behavior failed before implementation; the clone guards passed already.
Validation includes `bun run check`, `bun run build`, and a real HTTP server with disposable project data
and fake model responses: the persisted fallback note, older previews, omission counts, clipping markers
and both members' assignment prompts were checked. The browser visual pass could not run because the
browser access host was unavailable; no visual or layout changes are included.
The final check passed all 193 test files: 1 592 tests passed and 21 were skipped. The production build
and `git diff --check` passed too.

Validation also exposed test issues outside the team changes: an API test tried to create an empty routine
that is now rejected; Brain chat and library/model tests launched real local CLIs; and preview/builder
tests relied on short fixed waits. Their fixtures now match the API, mock unrelated CLI calls and wait for
observable UI state. Installing the existing frozen lockfile restored the missing Cinzel dependency.

This covers four selected follow-ups from that comparison, checked against the current code. Cross-project
guards already exist and need regression coverage. The digest needs explicit, bounded previews and omission
counts. Routing and concurrent assignments need clearer disclosure. The last three reduce the reported
limitations; bounded previews do not guarantee full context, and disclosure does not prevent duplicate work.
Nothing here copies Grok Bot's three-round cap: long-running teams must still be able to finish their work.

| # | Item | Verdict | Size | Order |
|---|---|---|---|---|
| 1 | Cross-project state | Already fixed in code; verify and lock it with a test | ~1 h | First |
| 2 | The thread digest silently omits messages and clips their text | Make both limits visible; keep bounded previews | ~1 day incl. tests | Second |
| 3 | The routing fallback picks the first member, blindly | Skip busy members when possible; explain the actual choice | ~2 h incl. tests | Third |
| 4 | Members cannot see concurrent assignments | Disclose the whole assigned batch before any turn starts | ~½ day incl. tests | Fourth |

Sequencing note: 1 is a check, not a runtime change. 2 is the only one with context loss behind it, so if only one
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

**Change.** None to the runtime code. Three things to do:

1. Add **team stop/queue state across a clone** coverage to `tests/server/project-isolation.test.ts`.
   Its cloned-chat test covers engine state, not the team runtime. Hold turns open in both projects with
   the same team and agent ids, queue work, and check that stopping one leaves the other's running turn
   and queue alone. Check each project with `withProject()`, so switching the open project does not
   invalidate the assertions.
2. Extend the existing handoff test there to use an actual clone. It already rejects listing and collecting
   another project's handle with the same asker id, but creates two separate projects rather than cloning.
3. Leave the residual risk visible: the maps are process-global. Team runtime keys include the project;
   handoff lookups check the stored project and asker. A new call site must preserve those boundaries.

**Acceptance.** With a clone of a project open, stopping the clone's team leaves the original's turns
running, the clone cannot consume the original's queued work, and `await_agent` in the clone cannot list or
collect a handle created in the original. Release the original's held turn and verify its reply stays in
the original's thread. Do not require new turns to start in the original while the clone is open:
`pump()` deliberately suspends new work in a project that is no longer open.

**Risk.** None. Test-only.

## 2. Make digest omissions and text clipping explicit

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

The read mark jumps to the end regardless of what fit. Older unread messages omitted from the digest are
not retried on later turns. Messages addressed to this turn can still appear in the separate `forYou`
block; the defect concerns unread context that appears in neither block.

There is a second limit before this loop: `said()` slices every message's text to 2 500 characters, without
a marker, and `forYou` uses it too. A single 10 000-character message therefore normally fits the digest
after clipping, silently losing its tail. Testing only the 9 000-character aggregate cap will miss this.

**Change.** Keep the recent digest cap and the current read-mark advancement. Do not introduce partial
replay without a separate delivery design. Add bounded previews and make every shortening explicit:

1. Keep the existing 2 500-character text limit in `said()`, but append `[message shortened]` whenever it
   clips text. This applies to the recent digest and `Addressed to you`. Count the marker in size checks.
2. Build the recent digest newest first, displaying it in chronological order as today. Count separators,
   author labels, attachment labels and markers inside `CONTEXT_CHARS = 9000`. If one rendered line alone
   exceeds the budget, include a bounded, marked preview instead of leaving the digest empty.
3. Put older unread messages that did not fit into a separate block headed
   `Earlier in this chat (shortened):`. Use the same author naming as `said()`, with text previews of up to
   120 characters for agent replies and 400 for user and Brain messages. Mark shortened previews.
4. Bound that whole block to `EARLIER_BUDGET = 2000`, including its heading, labels, separators, markers and
   counts. Reserve room for the counts and a preview of the oldest unread message before filling the
   remaining space with the newest older previews. Display the selected previews in chronological order.
   Bound unusually long labels too, visibly, so one label cannot defeat the cap.
5. State `N earlier messages: P previews; Q not shown.`, with `N = P + Q`. Include the count whenever there
   are older messages, even when every older message has a preview. Do not promise that every unread
   author appears: a fixed 2 000-character block cannot guarantee that. The oldest preview reservation
   replaces the original proposal to retain only the newest folded lines, which could discard the oldest
   author while the acceptance test required it to remain.
6. Keep this model-free, like the repo's existing "instant" compaction. No extra model call or dependency.

**Acceptance.** Under both limits, content is unchanged and there is no fold block or shortening marker.
Over the aggregate cap, the prompt includes the fold heading, a preview of the oldest unread message,
accurate preview/omission counts, and the newest message up to the per-message limit. Over the fold cap,
both blocks remain within their budgets and omissions are explicit; not every author must be represented.
A single oversized text message has a visible shortening marker in both the digest and addressed block,
even when it does not trigger folding.

**Tests.** New `tests/server/team-digest.test.ts`, using the fake OpenAI-compatible server pattern in
[`tests/server/teams.test.ts`](../../../tests/server/teams.test.ts), which records the actual turn prompt.
Cover: under both limits; aggregate overflow with all older previews fitting; fold overflow with distinct
authors and the oldest reserved; and one text message over 2 500 characters with a unique tail. Assert
exact counts and both block sizes, including labels and separators. Add long-label/attachment coverage for
a rendered line exceeding 9 000 characters. Use at least 40 long unread messages in the fold-overflow case:
the original newest-only folding rule could retain 3 recent messages and 15 previews while omitting the
oldest 22 entirely. Keep fixtures within the existing 500-message retention limit.

**Risk and limit.** This fixes silent omission, not lossless context delivery. A prefix preview can still
miss a decision or instruction near the end of a message, and a counted omission contains none of its text.
Full delivery would need a separate replay or retrieval design; it is not promised here. The additional
fold block is bounded to 2 000 characters; clipping markers also add a small amount to addressed messages.
No schema change, UI change or migration; `seen` remains internal to `TeamChat`.

## 3. The routing fallback picks the first member, blindly

**Problem.** The routing ladder ends like this:

```ts
const pick = route ? await route(...).catch(() => null) : null;
...
targets = [pick && team.members.includes(pick) ? pick : team.members[0]];
why = pick ? 'best fit' : 'first member';
```

[`server/teams.ts:291-297`](../../../server/teams.ts#L291-L297).

Two problems with the current fallback:

- `team.members[0]` may already be mid-turn, so the team can queue work behind a busy member while another
  sits idle.
- Nothing in the thread says the choice was arbitrary. `why` is emitted as a transient `kind: 'routed'`
  event, and **that event is not rendered anywhere** — the type exists in
  [`web/teamchat.tsx:33`](../../../web/teamchat.tsx#L33) and
  [`web/views/station.ts:442`](../../../web/views/station.ts#L442), but no component handles it. So the user
  sees an answer from an agent they never asked, with no explanation.

**Change.**

1. Treat a route pick as matched only when it is a current team member. A non-member id is a fallback,
   even if it is truthy; do not retain today's `why = pick ? 'best fit' : ...` check.
2. In the fallback, take the first member not in `r.running`; fall back to `team.members[0]` only when
   everyone is busy. Check availability after the awaited router returns.
3. When the pick was arbitrary, post one line to the thread as the existing `system` author, so it lands in
   the transcript (persisted, survives reload, visible in every surface that already draws a team):
   `No routing match: asked @Name, the first member free.`
   When everyone is busy, use `No routing match: queued this for @Name; everyone is busy.` instead.
   Post the note before enqueueing, so it precedes the turn and appears in that turn's digest.
   Post it **only** in the arbitrary branch — never for mentions, the lead, or a best-fit pick. Reusing the
   `system` author is deliberately cheaper than teaching the UI to render `routed`, and it puts the
   explanation where the conversation is rather than in a toast that disappears.

**Acceptance.** With `route()` returning `null` and two idle members, the first is asked and the thread shows
the fallback note naming it; with the first already working, the second is asked instead. With everyone
busy, the first receives queued work and the note says so. A missing router, a thrown error and an invalid
member id all use fallback disclosure. Mentions, reply-to routing, a service match, a lead or a valid router
pick produce no fallback note, even when the chosen member is busy.

**Tests.** Extend [`tests/server/services.test.ts`](../../../tests/server/services.test.ts) for matched
routing and no-note assertions. It collects `routed` events but does not currently stub a route function
or provide a held model response. Put busy/all-busy fallback cases in the fake-model harness in
`tests/server/teams.test.ts`, holding responses until assertions finish. Supply explicit router stubs for
null, failure, invalid id and valid id. Assert the persisted note, chosen member, queue state and ordering;
release or stop every held turn in cleanup.

**Risk.** The system line is extra thread noise, but only on the rare path, and it is the honest kind of
noise. It also enters later digests, which is the point.

## 4. Show concurrent assignments to every member in the batch

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

**Review finding.** `enqueue()` calls `pump()` immediately. `runTurn()` builds its prompt synchronously
before reaching `await askAgent()`. For a message routed to A and B, A's prompt therefore exists before B
has even been enqueued. Reading only `r.running` tells B about A, but leaves A blind. Also, that set can
contain a member working on an unrelated message, so it cannot establish who is working on *this* request.

**Change.** Disclosure, not enforcement:

1. Add a way to enqueue a known set of targets before pumping it, then start the batch once. Use it for
   both initial multi-member routing and the multi-member mentions posted after an agent's turn. Keep
   existing per-agent queue merging, priority, skills and return semantics. Preserve target order within
   the batch; repeatedly prepending targets must not reverse their start order.
2. Before building each turn's prompt, find other current or queued turns whose `msgIds` overlap this
   item's ids. Include both running and queued peers, excluding the current agent and non-member ids.
   Because the full batch is queued first, its first member can see its peers too.
3. When any peers share the message, add this tail line, before `TURN_ASK`:

   `Other members assigned this message: @Maker, @Editor. Do your own part; avoid duplicating theirs.`

   Use assignment wording because a peer may still be queued. A name in `r.running` with no shared message
   is not evidence of shared work and must not appear on this line. This is a snapshot of known assignments,
   not a live update to an already-running model.

Do **not** build a lock, a claim, or a duplicate detector. Detection would need to know what "the same work"
means, which we can only guess from text; enforcement would serialise the team, which is the opposite of how
it is designed to work. The line gives members a chance to divide the task; it does not prove they will,
and it conveys neither a teammate's live progress nor ownership of a particular subtask.

**Acceptance.** With one message routed to two members, each member's first prompt names the other as
assigned, including the member started first. Both turns can run concurrently. A solo turn has no line;
a member running on an unrelated message is not described as assigned this one.

**Tests.** Extend [`tests/server/teams.test.ts`](../../../tests/server/teams.test.ts) with a dedicated batch
case whose fake responses stay held until both prompts are recorded. Assert reciprocal names in both
initial prompts and simultaneous working state. Repeat for an agent reply that mentions two teammates.
Add solo and unrelated-running-message cases. The existing Lead → Maker → Lead fixture is sequential:
Maker has no concurrent peer there, so adding a positive assertion to it would be incorrect. Capture
prompts per turn rather than only the last prompt, which a later return to the lead could overwrite.

**Risk.** A member may wait for the other instead of doing its part, weakening the "start now" rule. The
briefing's "Do your own part fully before handing off… don't redo work a teammate owns" already frames this;
if the line proves to make agents passive, revise the wording. Batch enqueueing also changes scheduling:
check existing handoff, steering, queue and chatter tests for regressions.

## Not doing

- **A structural turn cap for teams** (Grok Bot's three rounds, ten member turns). The product's promise is
  "agents keep handing work to each other until the work is done". A cap would end long jobs mid-flight.
- **Duplicate detection or locking.** See above; the disclosure in item 4 is the cheap half.
- **First-class silence** (`(pass)` instead of posting `(no answer)`). Tempting, and it is what Grok Bot
  does better, but it changes what a member's empty turn means to the Brain's `reviewWork`, to the relay
  protocol, and to the UI. Worth a plan of its own if we ever want it; not in this one.
- **Lossless delivery or retrieval of omitted context.** Item 2 makes shortening visible and preserves
  selected previews; omitted text is not automatically delivered later. Thread retention remains 500
  messages. Do not describe the result as a complete fix for information loss.
- **A spend ceiling, fan-out approval or a new source-selection ladder.** These are other trade-offs in
  the comparison, outside these four follow-ups. The unbounded-spend limitation remains after this plan.

## Verification

1. Run `bun run check` (both typechecks and the test suite), then `bun run build`, matching the page's CI
   gates. Use the focused tests while implementing, then run these gates before calling the code done.
2. New behavior tests for items 2–4 must fail before their implementation and pass after. Item 1's tests
   should pass on the current code: they lock existing guards rather than introduce behavior. Keep the
   existing under-limit, matched-routing and solo-turn behavior passing throughout.
3. One manual pass in the app: inspect the user prompt in the next agent's turn details after enough unread
   messages to cross the aggregate and fold caps (item 2), checking counts, the oldest preview and the
   shortening marker on one long message. The fold is prompt context, not a new team transcript message.
4. Remove the lead and service match, trigger routing fallback, and confirm its persisted note names the
   chosen member; repeat while all members are busy to check the queued wording (item 3). Route one
   message to two members and inspect both initial prompts for reciprocal assignment disclosure (item 4).

## Docs to touch when the code lands

- [`README.md`](../../../README.md) and [`docs/guide.md`](../../../docs/guide.md), in their team sections —
  keep the explanation of who answers in step with the free-member fallback and persisted routing note.
- [`docs/internal/GROK_BOT_ORCHESTRATION_2026-10-31.md`](../GROK_BOT_ORCHESTRATION_2026-10-31.md) — update
  the routing, digest and concurrency descriptions to reflect the changes. Retain the residual limitations:
  fallback is still arbitrary, previews still omit text, and assignment disclosure does not prevent
  duplication. Do not move those rows out of "Disadvantages" as if the limitations had been eliminated.
