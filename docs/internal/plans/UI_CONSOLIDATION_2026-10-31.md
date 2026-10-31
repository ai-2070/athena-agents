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

### 5. Dead CSS, and a comment that no longer tells the truth — low

- `web/styles/components.css:70` — `.pill.mem { … }` ("how full the agent's memory is (chat header)").
  No `.ts`/`.tsx` applies a `mem` class any more; the rule is dead.
- `web/ui/classes.ts:6-7` — the comment says "nothing styles them any more" about the legacy markers,
  but `.pill.mem` *is* a rule on a legacy marker. Delete the rule and the sentence becomes true.

**Recommended:** delete `.pill.mem`; keep the marker-hook comment, corrected.

### 6. Legacy markers are pinned by tests — low, taste call

The markers (`btn`, `icon-btn`, `pill`, `chip`, `badge`, `dot`) are documented as hooks for tests and
lookups, but only one is read by code: `builder.ts:41` does `classList.contains('pill')`. Thirteen
assertions across ten files still look elements up by them:

`tests/web/`: `chat-page.test.tsx`, `dock-stream.test.tsx`, `home.test.tsx`, `library.test.tsx`,
`mcp.test.tsx`, `overlays.test.ts`, `programs.test.tsx`, `skills-page.test.tsx`,
`station-panel.test.tsx`, `world-panel.test.tsx`.

**Options:** leave the markers (cheap, harmless), or move those assertions to role/attribute queries and
drop the markers nothing reads. A marker whose only reader is a test is a test pinning an implementation
detail — revisit while doing item 2.

---

## Suggested order

1. **Items 2–5 in one pass** — widen the icon-button variants, add `fieldTriggerClass`, fold the two
   switches, delete `.pill.mem` and fix the comment. No behaviour change; verify with `bun run check`
   plus a look at the Station and a settings page.
2. **Item 1, one page at a time** — start with `projects.ts`; delete its `draw()` loop and `L_ACT` in
   the same change, seeding the pattern for the rest.
3. **Item 6** — only if we want the marker hooks gone; do it while inside the affected pages.

## Not in scope

- No design/visual change. Structure only; the "Linear, but white" look is unaffected.
- The voxel/three.js and terminal surfaces (canvas colours, `web/voxel/`, `web/views/terminals.tsx`)
  are correct as written and excluded.

## Verification notes

- Facts gathered by reading source and counting matches; no test run and no browser was used, because
  nothing was changed.
- Line numbers are from the working tree at 2026-10-31 and will shift as the above lands.
- If these edits proceed, each should run `bun run check` (typecheck + Vitest) and be eyeballed on the
  Station and a settings page before it is called done.
