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

## Follow-up review, same day

Three alignment faults, found by looking at the running page and measured in it rather than by eye.

- **Station panel, a team's head** — `web/views/stationpanel.tsx`. `PanelHead` centres its close button on
  whatever the caller passes as the heading, and the team was the only caller that passed a *third* line
  (the status). Measured: the close button sat at y-centre 122 for a team against 111 for the Brain and a
  project. The status now sits under the head, indented to the name, so the button is back at 111.
- **Chat window title bar** — `web/chatwin.tsx`. The strip was `min-h-[52px] pt-3` with the tab list
  `self-end`, so the tabs' bottoms rested on the bottom rule (about 1px) and the window's four buttons sat
  only 6px above it. First pass gave the strip `pb-2`, which pushed the rule away from the buttons but left
  the tab floating 9px above it — not what a tab should look like. Final state: the strip keeps `pb-2` (the
  buttons are 11px above the rule) and the tab list carries `-mb-2` so the tab still meets that rule (1px),
  plus `ml-1.5` for room from the window's own icon (6px → 12px). Measured on the live window: strip 53px
  tall, plate bottom 1px above the rule, buttons 11px above it, icon-to-plate 12px.
- **The paperclip in chat composers** — `web/attach.tsx`, `web/dock.tsx`. Only the dock asked for a quiet
  paperclip (`variant: 'plain'`, 32px); every other chat box fell through to `mountAttachMenu`'s `ghost`
  default and drew a boxed one. A bare icon is what an icon-only action should be, so the quiet plate is
  the default now (`PICKER_BUTTON`) and the dock no longer passes its own copy.
- **Section titles** — `web/ui/controls.tsx`. On a long page (Tools & MCP, Settings) the left-hand title
  scrolled away while its panel was still being read. The title column is `lg:sticky lg:top-18` now, so it
  stays 16px under the sticky top bar (`h-14`) until its own section has gone past. Measured: the "Presets"
  title holds at y 76 while the section scrolls from 1200 to 2400. Narrow screens keep the single-column
  layout, where the title is above the panel and does not stick.
- **A message cut off at the bottom of a chat** — `web/chat/ChatView.tsx`. Reported as clipped text; it was
  a scroll position, not an unreachable line (the report confirmed scrolling revealed it). The list only
  returned to the newest message when its *content* changed (a MutationObserver and a `load` listener) or
  when ChatView re-rendered. Making the window shorter — resizing it, or maximizing — changes the list's own
  height with no mutation to see, so the view stayed where it was: reproduced at 953×595, shrinking the
  viewport took the list from 358px to 204px and left the last row 166px below its bottom edge. A
  `ResizeObserver` on the list now keeps to the newest message the same way. After: `scrollHeight −
  scrollTop − clientHeight` is 0 through a shrink (358 → 209) and a grow (→ 509), and the same holds in a
  chat window when it is maximized (list 148 → 385). No unit test: happy-dom's `ResizeObserver` never
  fires (measured — it was also why the big-Markdown test was failing), so such a test would exercise a
  stub rather than the behaviour.
- **5px of dead space under the chat and terminal pages** — `web/views/chat.tsx`, `web/views/terminals.tsx`.
  Both were `h-[calc(100vh-61px)]` while the top bar is 56px. Measured after: the page's bottom lands
  exactly on the window's bottom (674/674, 520/520, 820/820).
- **The sidebar's menu reads a step stronger** — `web/app.ts`'s `NAV_LINK`. `font-medium` → `font-semibold`
  (Geist ships as a variable font from `wght.css`, so 600 is a real cut, not a synthesis); measured in the
  page: the link and its label both compute to `font-weight: 600`.
- **The wordmark too** — `public/index.html`. "Athena" `font-semibold` → `font-[700]`, "Agents" `font-medium`
  → `font-semibold`; measured 700 / 600. Note for anyone else reaching for this: the app's `@theme` sets
  **`--font-weight-bold: 600`** (`web/styles/app.css:62`), so in this codebase `font-bold` and
  `font-semibold` are the *same* weight — the first attempt with `font-bold` changed nothing. Use an
  explicit `font-[700]`, or raise that token deliberately (it would move every `font-bold` in the app).
- **The Station's clock** — `web/views/station.ts:3791` (and the day period at ~3958). It carried
  `[font-family:Archivo,sans-serif]`, a leftover from before the redesign: Archivo is still copied into
  `public/dist` by `scripts/build-fonts.ts`, so the clock really did render in it rather than falling back.
  It is `font-mono` now — the app's JetBrains Mono token, which is what the numbers/ids convention asks for
  — measured `"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace` at 14px with `tabular-nums`, the
  AM at 11px in the same family. Archivo is now referenced by nothing but `build-fonts.ts` and the test that
  checks its licence file is copied; dropping it (and that line of `tests/server/styles.test.ts`) is the
  obvious follow-up.
- **The message box floating in the middle of a chat page** — `web/views/chat.tsx`. Two links in the chain
  were content-sized rather than filling: the page grid's single row (a short chat left it 651px inside a
  761px page) and `.chat-body`, which had no `flex-1`. The composer therefore stopped **110px** above the
  bottom with an empty chat, and 134px with the row already fixed. Now `grid-rows-[minmax(0,1fr)]` on the
  page and `flex-1` on the body: measured on an empty chat, the page fills 56→817 with the body 120→817 and
  the box ending 24px (its own padding) above the bottom; on a 60-message chat the page does not overflow,
  the list scrolls inside itself (clientHeight 505 against scrollHeight 6428, pinned to the newest) and the
  box still ends 24px from the bottom. The narrow layout is untouched — it is `h-auto` there, where a `1fr`
  row resolves to the content either way.
- **The MEMORY.md button, nearly invisible** — `web/memory.tsx` and its three callers. It was the last place
  that handed a *pre-built* `buttonClass(...)` string to a `dom*` factory, so `domButton` added its own
  defaults on top: the element carried **two** full class sets, and the stylesheet's order decided the
  colour — `text-on-accent` (`#0b0d1e`) won over `text-ink` while `bg-ghost` won over `bg-accent`, giving
  dark navy on a dark plate. Measured before: `color: rgb(11, 13, 30)`, class list containing both
  `text-on-accent` and `text-ink`; after: `color: rgb(236, 238, 241)` with only `bg-ghost text-ink`, and the
  duplicated-class check comes back empty. `memoryButton` now takes `{ variant, size, class }` like the other
  controls, and `tests/web/memory.test.ts` guards it (the old mistake shows up as `text-on-accent` on the
  element). Note it would have been invisible in the light theme too — white on a light plate — so it was
  broken everywhere, not just on dark.
- **Brand marks that were invisible on dark** — `scripts/build-icons.ts` (which generates `web/icons.ts`).
  `logo()` drew a mark in its owner's colour and only fell back to the page's text colour for an exact
  `#000000`, so GitHub's `#181717` and Anthropic's `#191919` were painted near-black on a near-black page: the
  GitHub mark in the Station panel's Brain folder card, next to "LZLO/dashboard", was not there at all (nor
  on the Skills page's "from GitHub" line). `readable()` now measures the colour's luminance and keeps it only
  when it reads on the page it is drawn on — dark: above 0.025, light: below 0.85 — and otherwise `logo()`
  draws in `currentColor` while the canvas helpers (`brandPath`, `brandColor`) use `neutral()`. Measured on
  the dark page: `fill="currentColor"` → `rgb(236, 238, 241)` on a card at `rgb(19, 20, 23)`, visible; on the
  light page the same mark is still its own `#181717`. Slack `#4A154B` and OBS `#302E31` go the same way on
  dark; no brand in the set is light enough to change on the light theme. `tests/web/groupE-icons-skills.test.ts`
  guards both branches (on the old rule it fails with `expected '#181717' to be 'currentColor'`).
- **The colour swatch was shorter than the field beside it** — `web/styles/base.css`, the agent editor
  (`web/views/agents.tsx`) and the team's Setup tab (`web/views/stationpanel.tsx`). `base.css` deliberately
  took `[type='color']` out of the "text boxes look the same everywhere" rule, so a colour input had no
  border, no background, no shadow and its own intrinsic 38px height, and both call sites patched it with
  `h-9.5 w-12 cursor-pointer p-1` — 38px against the text fields' 40px, and no border. The rule now includes
  colour inputs, with a swatch rule under it (`height: 40px; width: 48px; flex: none; padding: 4px`) and both
  call sites drop their class string. Measured: agent editor Name 40px / Color 40px, same 1px
  `rgb(49, 50, 58)` border, 7px radius and card shadow; the team Setup swatch likewise 40px.
- **Programs: an emoji per program became the program's own mark** — `web/views/programs.tsx`, the new
  `web/programicons.ts`, `scripts/build-icons.ts` (which generates `web/icons.ts`) and `web/phosphor.ts`.
  The page drew `p.icon`, an emoji from the catalog, so Claude Code was "✳️" and Blender an orange circle.
  It now asks `programIcon(id, name)`: the program's brand logo where Simple Icons has one (26 brands added,
  Claude Code among them — `claudecode`, so the Claude Code row no longer wears the Claude model's mark),
  the app's PNG where `appicons.ts` has one (ComfyUI, LM Studio), else a line icon from a curated map of ~70
  ids (the box is only a last resort). All 122 catalog ids were walked in a throwaway Vitest run: every one
  resolves to a brand, a PNG or a mapped line icon, none to the box; the live page shows 31 rows, no emoji
  text in any of them, every avatar an `<svg>` or `<img>`. `tests/web/programicons.test.ts` guards the
  Claude Code mark, the line-icon and PNG paths, and the never-nothing fallback.
  The same confusion was in the Station: its usage strip's "**Claude Code usage**" row (SESSION/WEEK, straight
  from `/headbar`) wore the *Claude* starburst — an X-shaped mark, read as the wrong icon — as did the engines
  row and the Claude Code integration. All three now ask for `claude code`; rows that mean the Claude *model*
  (model picker, engine tiles by provider) keep the starburst.
