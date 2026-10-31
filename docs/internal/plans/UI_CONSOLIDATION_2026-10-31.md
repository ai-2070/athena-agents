# UI consolidation — 2026-10-31

A read-through of `web/` asking one question: what should we update, change, solidify or consolidate?
No source file was changed. Every claim carries the file and line it came from.

The short version: the **control layer is already consolidated and healthy**. The debt is the other half
of the app, which never moved onto it. Nothing is broken today; the cost is drift and a stale tail.

---

## What is already solid — do not churn it

- **`web/ui/classes.ts` is the single source of look for every control.** `Button` / `ButtonLink` /
  `IconButton` (React, `web/ui/button.tsx`), the `dom*` factories (`web/ui/dom.ts`) and the bare
  `buttonClass()` / `iconButtonClass()` used by Base UI triggers all derive from it. Same for
  `Pill` / `Badge` / `Dot` / `Chip` (`web/ui/marks.tsx` + `web/ui/dom.ts`). This is the right shape.
- **Floating menus have one implementation.** `web/ui/dropdown.tsx` has four consumers (`attachmenu.tsx`,
  `dock.tsx`, `projectmenu.tsx`); `web/ui/popover.tsx` has two (`skillpickmenu.tsx`,
  `routinementionmenu.tsx`). No parallel hand-rolled menu exists.
- **The DOM/React "pairs" are not forks.** `seg()`/`Segmented`, `toggleRow()`/`SwitchRow`,
  `field()`/`Field`, `chipSet()`/`ChipSet`, `avatar()`/the React badge share their CSS (`.seg`, `.chips`,
  `.field`). Two renderings of one look is the intended design, not duplication.
- **Hard-coded colours are data, not chrome.** All 172 `#hex` occurrences sit in brand/tool/agent
  palettes — `web/views/station.ts` tool colours, `web/views/stationdata.ts`,
  `web/views/stationpalette.ts`, `crafticons.ts`, `icons.ts`, `appicons.ts`, `look.ts`, and the
  voxel/three.js code that cannot read `var()`. No chrome colour is a literal. No action.

---

## Findings

Ranked by value. Items 2–5 are one small, safe pass; item 1 is the real work.

### 1. Nine pages still hand-build DOM with their own `draw()` loop — high

Roughly half the app never moved to React and still builds elements with `h()` from `web/core.ts`,
re-implementing by hand the mount/update lifecycle every React page gets for free:

| File | Lines | `h()` calls |
|---|---|---|
| `web/projects.ts` | 520 | 38 |
| `web/models.ts` | 493 | 35 |
| `web/builder.ts` | 283 | 30 |
| `web/skilldialogs.ts` | — | 21 |
| `web/history.ts` | — | 21 |
| `web/navlimits.ts` | 280 | 17 |
| `web/attach.ts` | 515 | 17 |

Smaller: `filepreview.ts` (13), `memory.ts` (7), `schedule.ts` (6), `backup.ts` (4).

**Why it costs:** each page is a second lifecycle to keep in sync; a shared behaviour change has to be
made twice. `web/projects.ts` is the best first target — biggest surface, and it already carries a
page-local button (`L_ACT`, below) that the migration deletes outright.

**Recommended:** page-by-page, as each page is touched for other work; not a big-bang rewrite. Each
migration should delete that page's `draw()` loop and its local control constants in the same change.

### 2. Page-local control constants re-derive the shared controls — high (cheap)

These rebuild the look `buttonClass()` / `iconButtonClass()` already own, compiling to
similar-but-not-identical utilities, so they drift from the real controls:

- `web/builder.ts:33` — `STEP_BTN` (inline users at `builder.ts:96-97`)
- `web/projects.ts:428` — `L_ACT` (used at `projects.ts:476`)
- `web/projectmenu.tsx:13` — `RENAME_BTN`
- `web/views/chat.tsx:179` — the memory meter, written as `pill mem …` by hand
- `web/views/stationpanel.tsx:124-125` — `MEMBER_ACT`, `MEMBER_ACT_ON`
- `web/skillpick.ts:34` — the "Add skill" dashed-pill button, written inline
- `web/views/station.ts:1651` (chip), `:1662` (launcher pill), `:3682` (`INT_TILE`)

**Recommended:** widen `iconButtonClass()` with the variants these need (tone, size, borderless) and
replace each constant with a call; leave only genuinely Station-specific geometry in place.

### 3. The field/trigger look is copy-pasted three times — medium

The same "box that opens something" class run appears three times:

- `web/ui/select.tsx:20` — `flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-ctl border border-line-2 bg-bg px-3 py-2 text-left text-[13.5px] …`
- `web/ui/agentselect.tsx:14` — `flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-ctl border border-line-2 bg-panel px-2.5 …`
- `web/views/stationpanel.tsx:306` — `flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-ctl border border-line-2 bg-panel px-3 …`

**Recommended:** one `fieldTriggerClass` (or `inputClass`) in `classes.ts`, with width/tone as a
variant argument. The plain text inputs in `base.css` should share the same token set.

### 4. Two switch implementations in CSS — medium

`.toggle` (plain DOM, `core.ts:442`) and `.switch` (Base UI, `ui/controls.tsx:95`) describe the same
36×20 pill twice — same 16px thumb, same 0.18s transition:

- `web/styles/components.css:55-60` — `.toggle`
- `web/styles/components.css:61-65` — `.switch`

**Recommended:** make `toggle()` emit the `.switch` markup (or have both blocks share one declaration)
so there is one switch in the stylesheet. Behaviour is identical; plain-DOM users (`schedule.ts`) keep
working unchanged.

### 5. The memory meter wears a pill's name without its look — medium

The first version of this note called `.pill.mem` dead CSS. It is not: `web/views/chat.tsx:179` builds
the chat header's memory meter as `className={\`pill mem … ${… ? 'warn' : ''}\`}` by hand. Because it
never goes through `pillClass()`, it is missing every pill utility — the padding, the border, the
rounded ends, the background and the `--tone` the border and text colour read — so the meter renders as
bare text with no pill around it. It is also the one thing in the codebase that reads a marker class:
`web/styles/components.css:70` styles `.pill.mem`.

- `web/views/chat.tsx:179` — the hand-written pill
- `web/styles/components.css:70` — `.pill.mem { font: 12px …; font-variant-numeric: tabular-nums; cursor: default; }`
- `web/ui/classes.ts:6-7` — the comment saying "nothing styles them any more" was untrue because of it

**Recommended:** render it with `Pill` (`web/ui/marks.tsx`) and the `mem` marker as its className, carry
`tabular-nums cursor-default` in the utilities, and delete the `.pill.mem` rule. The comment then tells
the truth, and the meter gets the pill look the test already assumes.

### 6. Legacy markers are pinned by tests — low, taste call

The markers (`btn`, `icon-btn`, `pill`, `chip`, `badge`, `dot`) are documented as hooks for tests and
lookups, but only one is read by code: `builder.ts:41` does `classList.contains('pill')`. Thirteen
assertions across ten files still look elements up by them:

`tests/web/`: `chat-page.test.tsx`, `dock-stream.test.tsx`, `home.test.tsx`, `library.test.tsx`,
`mcp.test.tsx`, `overlays.test.ts`, `programs.test.tsx`, `skills-page.test.tsx`,
`station-panel.test.tsx`, `world-panel.test.tsx`.

**Decision: keep the markers.** `web/ui/classes.ts:5-7` states the intent — they are hooks kept on purpose
"the same way the dock and the Station keep their markers", and ten test files use them. Moving those
assertions to role/attribute queries would be churn for no gain, and dropping markers that only tests
read would break the very lookups they exist for. The one thing that was wrong here was that a marker
was *styled* (`.pill.mem`); that is fixed above. The only code that reads a marker is still
`web/builder.ts:41` (`classList.contains('pill')`), which its own module owns.

---

## What was done (2026-10-31)

All six findings are addressed, each in its own commit.

- **Finding 2, 3, 4, 5** — one commit: `fieldTriggerClass` in `web/ui/classes.ts` now draws the box a
  select's trigger and the agent picker share; `.toggle` and `.switch` share their declarations in
  `components.css`; the chat header's memory meter is a `<Pill>` (it had never had the pill's own
  utilities); `iconButtonClass` gained a `quiet` variant for the small borderless actions in a panel
  row, and the Station panel's member actions are `IconButton`s. `openModal` now takes a `ReactNode`
  title.
- **Finding 1** — eleven modules moved to React, in one commit, each keeping its exported signatures so
  no caller's logic changed: `history`, `schedule`, `memory`, `backup`, `skilldialogs`, `filepreview`,
  `navlimits`, `models`, `builder`, `projects`, `attach`. They are `.tsx` and no longer build DOM with
  `h()` or redraw with their own loops; the dialogs use `openModal` with React content. `web/projects.tsx`
  lost `L_ACT` and `web/builder.tsx` lost its page-local control constants.
- **Finding 6** — the markers stay, as decided above.

What still builds its own DOM with `h()`: the page shell (`web/app.ts`), the Station's map and header
(`web/views/station.ts`), and the small helpers `skillpick.ts`, `pastes.ts`, `chatcommands.ts`,
`routinemention.ts`, `compactmark.ts`, `projectlogo.ts`, `teammark.ts`, `modelviewer.ts` and a few
sightings inside `dock.tsx` and `web/chat/ChatView.tsx`. That is the tail left for later.

### Test suite before and after

Before: `tests/server/brain-chat.test.ts` (Windows temp-dir EPERM), `tests/web/bigmarkdown.test.tsx`,
`tests/web/find.test.tsx` and `tests/server/api.test.ts` failed.

After: both Markdown tests pass, and the whole web suite is green.

- `bigmarkdown.test.tsx` stubbed `offsetHeight`, but `@tanstack/react-virtual` reads the scroller's
  `clientHeight`/`clientWidth`, so nothing was ever measured. Added those two spies.
- `find.test.tsx`'s "finds a word that is far from the screen" exposed a real bug: `scrollToIndex()`
  returns early when it has not measured the index asked for, so Ctrl+F could not reveal a match that
  was far away. `web/ui/bigmarkdown.tsx` now scrolls the box itself to the summed estimate, and the
  test's `scrollTop` mock fires `scroll` the way a browser does (its `scrollTo` mock already did).

Left failing, both server-side and unrelated to this work: `brain-chat.test.ts` (a Windows temp-dir
`EPERM`) and `api.test.ts` (a routine endpoint answering 404 where the test wants 400).

## Still open

- An `h()` tail: `skillpick.ts`, `pastes.ts`, `chatcommands.ts`, `routinemention.ts`, `compactmark.ts`,
  `projectlogo.ts`, `teammark.ts`, `modelviewer.ts`, plus sightings inside `dock.tsx` and
  `web/chat/ChatView.tsx`.
- `web/builder.tsx` kept `STEP_BTN` for its ★/✕ step buttons, and `web/projectmenu.tsx` kept
  `RENAME_BTN`: both are 26–28px row affordances whose size, radius or reveal differ from the shared
  `quiet` icon button, so folding them in would have changed how they look.

## Not in scope

- No design/visual change. Structure only; the "Linear, but white" look is unaffected. (Two small
  deltas came with the migrations: the project launcher's row actions now use the shared `inset` icon
  plate, and `deleteProject`'s confirm is an `openModal` instead of `confirmBox` — same DOM and copy.)
- The voxel/three.js and terminal surfaces (canvas colours, `web/voxel/`, `web/views/terminals.tsx`)
  are correct as written and excluded.
- No JSX was added to `web/core.ts`, `web/ui/dom.ts`, or anywhere the page shell still owns.

## Verification notes

- The findings were gathered by reading source and counting matches. The first version of finding 5 was
  wrong (it called `.pill.mem` dead CSS); it is corrected above, which is a reminder that a grep for
  `'pill` misses `\`pill mem …\`` in a template literal.
- Line numbers are from the working tree at 2026-10-31 and have shifted where modules were migrated.
- After the work: `bun run typecheck` is clean, `bun run build` is clean, and the test suite is down to
  the two known failures above. The page was also driven in a real browser against a throwaway data
  folder: the sidebar's Limits panel and Status/Limits switch, the project launcher, the New project
  window, the model picker (tabs, effort levels, model rows) and the Station all render with no console
  errors.
