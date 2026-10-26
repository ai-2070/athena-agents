# Machines: pair your computers and run projects on any of them

*Plan, 2026-10-26. Step 0 (proof of concept) done 2026-10-27; nothing in the app is built yet. Phones come later (see `REMOTE_APP_PLAN.md`, part C).*

## Goal

Pair your own computers with each other over Net, then choose where each project runs:

- **Assign** a project to another paired machine. It runs there: its routines, teams, team chats
  and the Brain's follow-ups.
- **Reassign** it: bring it back, or move it on to a third machine.
- **Pause** and **resume** it wherever it runs.

Pairing and the list of machines get a new item in the left sidebar: **Machines**.

## What we start from

### Projects only run while they are open

A server has one open project (`settings.activeProject`). Most work that acts on its own is tied
to it:

| What | Today | Where |
|---|---|---|
| Team schedules | only the open project's | `server/workflows.ts:221` (`workflows.list()` outside `withProject`) |
| Routine schedules | only the open project's | `server/routines.ts:232` |
| Team chats, team `/loop`, `/queue` | stop or are dropped when you switch | `server/teams.ts:439, 607, 675, 763` |
| The Brain's team follow-ups | open project only | `server/irc.ts:141, 166` |
| Brain chat answers | refused after a switch | `server/overseer.ts:1550, 1612` |
| Agent runs, chat `/loop` | keep their own project | `server/engines/index.ts:231, 513` |
| Learning | any project | `server/learning.ts:134` |

So a project sent to machine B would only run there while B has it open. B is somebody's computer
with its own open project, so this has to change first: **a project must be able to run without
being open.** This change is useful on its own too ("keep this project running in the background").

Nothing like a lasting "paused" state exists. The nearest things:
- `enabled` on teams and routines
- the Brain's "stop everything in this project" (`server/overseer.ts:826`), which is a one-off
  stop and doesn't filter routines by project
- restore pausing schedules so a copy doesn't run them twice (`server/backup.ts:704`)

### A project's parts

What a project is made of, and how far each part travels:

- **The Brain folder** (`brainPath`) holds `BRAIN.md`, `notes/`, `uploads/` and maybe a git repo.
  It is every agent's default working folder.
- **`<brainPath>/.dashboard/`** is already a portable copy of the project, kept up to date by
  `server/projectsync.ts`. It holds agents, teams, routines, layout, Brain chat, team chats, agent
  chats (up to 200 MB), knowledge, memory, versions and the skills the project uses.
  `restoreInto()` loads it into an empty project, and `backup.ts` `rebase()` rewrites paths.
- **Not in `.dashboard`:** runs, routine runs, Outbox, artifacts, Brain briefs, team marks and tool
  images. Most of these are history; the Outbox and team marks should travel.
- **Machine-wide, never in a project:**
  - Secrets (`data/secrets.json`) and accounts (`data/accounts.json`).
  - CLI logins (`~/.claude`, `codex login`, Hermes profiles).
  - Program paths, allowed folders and MCP server definitions.
  - Claude Code session ids resume only on the machine that made them. A chat moved elsewhere
    starts a new session (`engines/claude.ts:253` already falls back).

### What Net gives us (TypeScript SDK `@net-mesh/sdk` + `@net-mesh/core` 0.45.1)

**Usable as is:**
- **Identity:** an ed25519 keypair from a 32-byte seed we keep (`MeshNode.create({ identitySeed })`).
  `fingerprint()` gives a short code to compare on both screens.
- **nRPC:** unary, server-streaming, client-streaming and duplex calls to a node id.
  - Deadlines, AbortSignal and retries.
  - JSON codec in TS.
- **Folder transfer:** `storeDir` / `fetchDir`.
  - BLAKE3-checked chunks. Unchanged chunks aren't sent again on the next move.
  - The new copy is written to a temp folder and swapped in.
- **Enrollment:** invite → join → approve. An invite token can be a text code. The approver
  callback sees the joiner's name and key. `OperatorEnrollment.revoke()` cuts a device off.
- **NAT traversal:** direct first, hole-punching, relay through a third node, and an automatic
  upgrade from relayed to direct.
- **Capability announcements:** signed tags with a TTL. A machine can say what it can run.
- **Prebuilt native builds:** Windows, macOS and Linux, x64 and arm64.

**Gaps in the Node binding** (the Rust SDK has most of these). These shape the design:

1. **The connection key isn't kept.** The transport (Noise) key can't be persisted from Node, so
   a machine's `publicKey()` changes on every restart. A peer's saved address goes stale.
2. **No routed connect.** There's no `connect_via` from JS. `accept()` must come before `start()`,
   so a running node can't take a new peer directly.
3. **Unary handlers can't see the caller.** We can't tell which machine called. Stream and duplex
   handlers get `callerOrigin`, and `onStreamData` gives an authenticated peer id.
4. **No `allowed_nodes` on a service** (Rust has it). There's also no peer list, no peer events and
   no disconnect.
5. **Pairing in TS still needs a shared mesh key (PSK) passed out of band.** The PSK-free
   enrollment, which delivers it, is Rust/CLI only.
6. **No progress callback or resume on `fetchDir`.** `fetchBlob` buffers everything in memory.
7. **No LAN discovery and no hosted relay.** Across the internet, one reachable node or a
   self-hosted `net-mesh relay serve` is needed.
8. **Untested ground:**
   - Bun: only a bus benchmark has run under it.
   - Windows: CI runs the Node tests on Linux only.
   - Bundling the `.node` addon into the desktop app.

Net is ours, so the plan fixes 1–6 upstream rather than working around them for long (step 1).

### Step 0 results (2026-10-27)

`@net-mesh/sdk` + `@net-mesh/core` 0.45.1, Bun 1.4.4, Windows 11 x64. Everything ran on one PC
(loopback), in one process and in two separate processes.

**Works:**

| What | Result |
|---|---|
| Bun loads the native module | Yes |
| Same identity across restarts from a saved seed | Yes |
| Pairing: invite → join → approve | Two processes paired in about 2 s. The inviter's approve callback saw the joiner's name and fingerprint (`59E6-6149-…`), matching what the joiner shows. An invite is a 231-character `net-invite:…` string |
| Joining a node that is already running | Yes. `join` makes its own connection, so the "accept before start" limit (gap 2) doesn't affect pairing |
| Calls both ways after pairing | 0.3–1 ms each, 0.14 ms in one process. Steady for as long as both run |
| Streamed calls (`callStreaming`) for status updates | Yes |
| Folder transfer, many small files | 2,000 files in 0.6 s, byte-for-byte (matches Net's own `node_modules`-scale test) |
| Folder transfer, single files up to 128 MB | Yes, at about 4 MB/s |
| Bundled like the desktop server | Yes. `Bun.build` with `@net-mesh/core` as `external` (bundle 220 KB). The app folder keeps the core package's JS plus one `net.<target>.node` (19 MB, not the 169 MB package with all platforms). The loader tries `./net.<target>.node` first |

**Breaks or needs care:**

1. **No reconnect after a restart.** This is the blocker.
   - Each start makes a new connection key, so after the inviter restarts nobody can reach it:
     "reply-channel subscribe rejected" both ways.
   - After the joiner restarts, its `renew()` reconnects only if the inviter has already dropped
     the old session. That happened with `sessionTimeoutMs: 4000`.
   - Even then, calls back toward the restarted machine kept timing out.
   - **Fix in Net:** keep the connection key (or derive it from the identity seed), and refresh
     reply channels when a peer comes back.
2. **One large file is slow and can fail.**
   - A file's chunks are fetched one after another over one stream (`dataforts/dir.rs`,
     "chunks pull sequentially"). The stream's window is 32 packets of about 8 KB, giving about
     4 MB/s on loopback.
   - Each chunk has a fixed 30 s limit (`mesh.rs` `transfer_fetch_chunk`). A 190 MB file failed
     with "timed out fetching".
   - Many files are fine: up to 16 are fetched at once.
   - **Fix in Net:** fetch a large file's chunks in parallel too, make the limit follow progress,
     and report progress to JS. This is the plan's own Phase 4 (large files), which hasn't been
     measured yet.
3. **Streamed calls lose data under load, silently.**
   - `sink.send()` returned `true` while messages were dropped:
     - 1,089 of 2,341 arrived when sent in a burst, even with flow control and `grant()`.
     - With short pauses, 3 of 9,363 were lost and the rest arrived out of order.
   - Each message is limited to 8,104 bytes.
   - Fine for status updates, not for files. **Fix in Net:** make `send` report back-pressure
     truthfully, or document the drop.
4. **Handles that get garbage-collected stop the service.**
   - The handle from `rpc.serve()` and the one from `serveEnrollmentAuto()` must be kept.
     Dropped ones were collected and the service went away ("no nRPC service … is served").
   - Our code must hold every handle. Net could keep them alive itself, or say so in the docs.
5. **Two processes can bind the same UDP port on Windows** without an error. Packets then go to
   either one, giving handshake timeouts. `server/net.ts` must check its port isn't taken. Net
   should bind exclusively.

**Decision:** stay in-process. The native module runs under Bun and bundles the way node-pty does,
so no Rust sidecar. Pairing and calls can be built now (step 2). Machines must re-pair after a
restart until fix 1 lands, so fix 1 comes first in step 1, before anyone uses this. Moving projects
(step 4) waits for fix 2 when a project has large files.

## Design

### One owner per project

Every project has exactly one **owner**: the machine that runs it. The others may keep a copy, but
a copy never runs anything. Moving a project hands ownership over in one step that both sides
record. Two machines can't both think they own it, so two copies never run the same schedules.

```text
            pair (once)                       move "Launch" A → B
machine A ◀════════════════▶ machine B     A: pause, last save, send folder ──▶ B: check, place, take over
  owns: Launch, Blog           owns: —      A: keeps a copy, marked "on B"   ◀── B: "I own it now"
```

### Pieces

**Server, new files:**
- `server/net.ts`: the Net node.
  - Starts it, keeps its identity seed and the household key under `data/net/`, announces this
    machine, and closes it on shutdown.
  - Off until you turn Machines on.
  - All Net imports stay in this file, so a Rust sidecar could replace it later without touching
    the rest.
- `server/machines.ts`:
  - The paired-machine list (`data/machines.json`): pairing, removing, online status.
  - The nRPC services the other machines may call.
  - Every call is checked against the paired list first.
- `server/handoff.ts`: moving a project. Packing, sending, receiving, placing, and switching the owner.

**Shared types:** `Machine`, `ProjectHome` and `ProjectRunState` go in `shared/types.ts`.

**Page:** `web/views/machines.tsx` (React, Base UI), added to `NAV` in `web/app.ts` with the
`monitor` icon (already bundled).

### Pairing (computers)

1. On machine A: **Machines → Pair a machine → Show a code.**
   - A shows a pairing code: one use, expires in 10 minutes.
   - The code holds the invite, A's address and, until Net drops the need, the household key.
   - It's text you can copy, plus a QR code for later phone use.
2. On machine B: **Machines → Pair a machine → Enter a code.** B joins and sends its name.
3. A shows "**B (fingerprint 7F3A-…) wants to pair**". Both screens show the same fingerprint.
   You compare them and press **Pair** on A.
4. Each machine adds the other to its list: name, identity key and last address. On A, B appears
   as "Online · direct" (or "· through relay").

**Removing a machine:**
- It's taken off the list on this side, and told to remove itself if it's online.
- Its grant is revoked, and calls from it are refused from then on.
- Until Net can drop a peer, a removed machine still holds the household key. **Forget all
  machines** makes a new key, after which the remaining machines need to be paired again.

**Reaching each other:**
- On the same network, the address in the code is enough.
- Across the internet, both machines need a relay address (Machines → Advanced).
- A relay forwards encrypted packets only. See the open question on who runs it.

### What a machine can call on another (nRPC services)

Only paired machines, checked by identity on every call.

| Service | Kind | What |
|---|---|---|
| `bs.hello` | unary | name, Blacksite version, what this machine can run (see below) |
| `bs.status` | server stream | the projects it owns, each with state, "working now" and "needs you" counts |
| `bs.project.pause` / `resume` | unary | for a project it owns |
| `bs.project.offer` | unary | "will you take this project?" B answers with what it's missing |
| `bs.project.take` | unary | B fetches the folder (`fetchDir`), places it, becomes owner, answers |
| `bs.project.release` | unary | the owner pauses it, saves, and returns its folder reference |
| `bs.forget` | unary | "remove me": sent when you remove a machine |

**What a machine can run** comes from `bs.hello` and its capability tags. These are only facts,
never secrets:
- engines installed and signed in (Claude Code, Codex, Hermes…)
- which keys and accounts are set (`set`/not set only, the same as `secretStatus()`)
- programs found and MCP server names
- free disk space

No generic API pass-through in this plan. Opening a remote project inside this machine's page is a
later step (step 6).

### Run state: running or paused, open or not

Each project gets a run state on the machine that owns it:

- **Running**: its schedules fire, team chats answer, team `/loop` and `/queue` go on, and the
  Brain follows up, **whether or not the project is open**.
- **Paused**: nothing starts by itself.
  - Pausing stops the work in progress the way `/stop` does: what was cut off can be resumed, and
    `/resume` picks it up.
  - You can still open a paused project and look at it.
  - Writing in a chat asks "Resume this project?" first.

**Server change:** the schedulers, team chats and the Brain's follow-ups loop over the **running
projects this machine owns** inside `withProject(p, …)`, instead of reading "the open project".
The checks that drop work after a project switch (`openProject().id === pid` and similar) become
"is this project still running here?". This is the biggest change in the plan, and it is the
one to review hardest.

**Upgrade:** today a closed project effectively doesn't run. To keep that behaviour, existing
projects start as **Running** if they are open and **Paused** if not. Opening a paused project
doesn't resume it. You resume it on purpose (a "Paused · Resume" bar at the top). See the open
question.

### Moving a project (assign, reassign, bring back)

From the Machines page or the project menu: **Move to → B**. The flow:

1. **Check:** A calls `bs.project.offer`. B answers with what it lacks for this project, such as:
   - "Codex isn't signed in"
   - "no OpenRouter key"
   - "the X account isn't connected"
   - "MCP server `photocraft` isn't set up"
   - "agent Scout works in `D:\clips`, which won't move"

   A shows the list. You can move anyway: those agents ask for setup on B.
2. **Pause on A:** stop running work, as Pause does, then a last save into `.dashboard`.
3. **Send:**
   - The Brain folder (with `.dashboard`) via `storeDir`; B fetches it with `fetchDir` into its
     projects folder (`Documents/Blacksite/<name>`).
   - Also: the Outbox, team marks and the library skills and presets the project uses.
   - Big git repos: see the open question.
4. **Take over on B:**
   - B restores the project from `.dashboard` the way `restoreInto` and backup restore do, with
     paths rebased to B.
   - B records itself as owner and sets the run state you picked (Running by default).
   - Then it answers.
5. **On A:** the project stays in the list as **"On B"**.
   - A's copy is kept read-only as a fallback and never runs. It can be deleted.
   - Opening it shows a "This project runs on B" bar with **Pause**, **Bring back** and **Move to…**.

**Reassign:**
- From A, moving a project B owns to C means A asks B to move it to C. B does steps 1–4 with C.
- **Bring back** is a move to this machine.
- A second move only sends changed chunks.

**If the owner is offline:** the other machines show "B is offline (last seen …)".
- **Take it back from the last copy** is there, with a warning: work done on B since the last
  sync is not included, and B is told it no longer owns it when it comes back.
- B, coming back online, checks ownership before running anything (it asks `bs.hello` around). It
  pauses the project if someone else owns it now.

Nothing is merged between copies. One owner, whole-folder moves.

### What never travels

- Keys, tokens and account logins. Each machine uses its own; the check in step 1 says what's missing.
- MCP server definitions. They are commands to run, so B asks before adding any from a moved project.
- Absolute folders outside the Brain folder, which are listed in the check.

### The Machines page

| Part | What it shows |
|---|---|
| **This machine** | name (editable), fingerprint, Machines on/off, "Reachable: direct / through relay / not yet" |
| **Paired machines** | each: name, online or last seen, direct or relay, Blacksite version, what it can run, how many projects it runs. Menu: Rename, Remove |
| **Projects** | every project on every machine: where it runs, Running / Paused, working now, needs you. Actions: Pause / Resume, Move to…, Bring here |
| **Pair a machine** | dialog with two tabs: Show a code, Enter a code |
| **Advanced** | relay address, Net port, Forget all machines |

**Elsewhere in the app:**
- The project menu and the start screen badge projects that run elsewhere ("on Studio PC").
- The sidebar item shows a dot when a paired machine needs you.

### Security

- **Off by default.** No Net node starts until you turn Machines on.
- The HTTP server stays on 127.0.0.1 with its checks unchanged. Net is a separate door with its
  own small set of services above.
- **Every service checks the caller against the paired list.** Until Net exposes the caller in
  unary handlers, each request carries this machine's identity key and a signature over a fresh
  nonce, verified with `verifySignature`.
- **Keys live under `data/net/`:** the identity seed and the household key.
  - Same rules as `secrets.json`: never sent to the page, and never in `.dashboard`, backups or a
    moved project.
  - On Windows, NTFS ignores 0600, so encrypt the seed with DPAPI.
- **A received project runs nothing on arrival.** Schedules start only if you chose Running.
  MCP servers are never added without asking. Agents keep their tool approvals.
- Moves and pairing show in the activity log.
- New tools for agents (if any later, like "move this project") are `high` risk.

### Desktop app

- `@net-mesh/core` is a native module. It goes in `external` in `scripts/build-desktop.ts` and is
  copied per target like node-pty.
- Net listens on a UDP port, so Windows asks to allow it through the firewall the first time.
  Machines explains this before turning on.
- Fallback if the native module won't run under Bun, or won't bundle: a small Rust sidecar
  (`net-mesh-sdk`, built with the Tauri toolchain) that `server/net.ts` talks to over stdio. It
  would also cover the Node gaps at once.

## Steps

Each step ends with tests and a check by hand on two instances on one PC: different ports, and
`DASH_DATA`, `HOME` and `USERPROFILE` each pointed at its own throwaway folder.

0. **Proof of concept: done 2026-10-27.** See "Step 0 results" above. What it covered:
   - Under Bun on Windows, two server processes with `@net-mesh/core` 0.45.x pair (invite, join,
     approve), make unary and streaming calls, and `fetchDir` a 200 MB folder.
   - Restart one and see what breaks (gap 1).
   - Bundle it into the desktop app.
   - Outcome: in-process or sidecar, and the exact list of Net changes.
1. **Net changes (in the Net repo, alongside 2–3), in this order:**
   1. Keep the transport key across restarts (an option, or derived from `identitySeed`), and
      refresh reply channels when a peer reconnects. Without this, machines must re-pair after
      every restart.
   2. Large files: fetch a file's chunks in parallel, a time limit that follows progress, and a
      progress callback for `fetchDir`.
   3. Caller identity in unary handlers, or `allowed_nodes` on `serve`.
   4. Peer list, peer events and disconnect.
   5. Streamed calls: `send()` tells the truth about dropped messages.
   6. Exclusive UDP bind on Windows. Keep serve and enrollment handles alive while serving.
   7. PSK-free enrollment in TS.
   8. Node tests on Windows in CI.
2. **Machines page and pairing:**
   - `server/net.ts` and `server/machines.ts`, `bs.hello`, the pairing flow, online status,
     remove, Forget all.
   - The page with This machine, Paired machines and Pair a machine.
   - No projects yet.
3. **Run state:**
   - Running and Paused per project, and projects that run without being open.
   - Pause and Resume on this machine only.
   - The server change described above, with tests for schedules, team chats and follow-ups in a
     project that isn't open.
4. **Moving projects:**
   - `server/handoff.ts`: the offer check, send, take over, the copy marked "On B", bring back,
     move on to a third machine, and "Take it back" when the owner is offline.
   - The Projects part of the page, and Move to… in the project menu.
5. **Control from any machine:**
   - `bs.status` streaming into the Projects part.
   - Pause, Resume and Move for projects that run elsewhere.
   - "Needs you" from other machines shown in this machine's drawer, linking to that machine.
6. **Later:**
   - Open a project that runs elsewhere inside this machine's page. This needs the API
     pass-through from `REMOTE_APP_PLAN.md` part C, plus routes that can serve a project that
     isn't open.
   - Phones.

## Open questions

- **Relay:** we run one for everyone (cost, abuse limits), or each user runs `net-mesh relay serve`
  on a VPS? Same-network pairing works without one.
- **Closed projects after the upgrade:** Paused (keeps today's behaviour, recommended) or Running
  (closed projects' schedules start firing, which may surprise people)?
- **Git repos in Brain folders:** send `.git` too (simple, can be large), or have B clone from the
  remote when there is one and send only uncommitted changes?
- **The old machine's copy after a move:** keep it read-only as a fallback (recommended), or delete
  it once B confirms?
- **Keys on a new machine:** v1 never sends them. Later, an explicit "copy my OpenRouter key to B"
  with both machines confirming?
- **One Machines list or households:** all paired machines trust each other equally. Is that enough,
  or will people want "this machine may run projects but not move them"?
