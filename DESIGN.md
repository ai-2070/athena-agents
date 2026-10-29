# DESIGN.md: the Brain chat

How the Brain chat looks and moves, and why. The Brain chat is the floating window on every page (`web/dock.tsx`),
opened from the "Ask the Brain" button or with Ctrl+K (⌘K), where you talk to the Brain or straight to an agent or team.

This records the finished state of the remake. The glass material and the dropdown are shared with other parts of the
app (the Station side panel, the project menu, the New project dialog); those are noted where they meet this window, and
`AGENTS.md` ("Look") has the app-wide rules.

## Principles

- **Quiet.** One frosted surface, hairline edges, one accent. Nothing glows, nothing is a card inside a card.
- **Compact.** Small type, tight rows, small radii (7px controls, 10 to 12px plates, 16px window). The first versions of
  the glass panel were rejected for being too large and too round; the Brain chat follows the corrected sizes.
- **Thin.** Icons are Phosphor Regular, a step stronger than the app's Light, so they hold up on glass.
- **One dropdown.** Every popup menu is the same one (ReUI's DropdownMenu look, on Base UI's Menu).
- **Same in light and dark.** Light is milky white, dark is true OLED black; both come from the same tokens.

## Material: glass

One shared rule (`components.css`, "glass") gives the window, the Station panel, every `.st-menu` and the New project
dialog the same surface. It remaps the page's colour tokens to see-through ones inside the surface, so everything in it
(fields, buttons, chips) turns into soft plates without being restyled one by one.

| Token (inside the glass) | Light | Dark |
|---|---|---|
| `--glass-base` (the fill) | white 56% | black 64% (OLED) |
| `--glass-sheen` (top-left highlight, 155deg to 38%) | white 60% | white 10% |
| `--glass-edge` (1px border) | white 80% | white 12% |
| `--glass-spec` (inset top highlight) | white 90% | white 8% |
| `--color-bg` / `--color-panel` / `--color-panel-2` / `--color-raise` | white 50 / 44 / 78 / 92% | white 4.5 / 5 / 10 / 14% |
| `--color-line` / `--color-line-2` | ink 8% / 15% | white 9% / 18% |
| `--color-ink` / `--color-dim` / `--color-faint` / `--color-icon` | #14151a / #4d4e59 / #6a6b77 / #73747f | #f6f7f9 / white 68% / 46% / 54% |

- Blur: `backdrop-filter: blur(32px) saturate(170%)`.
- The window uses a **gentler sheen** than the panel (white 50% light, 4.5% dark): it is large and mostly quiet, and a
  stronger one read as a grey band across the header.
- Window shadow: `inset 0 1px 0 spec`, a 1px outer ring (ink 6% light, black 70% dark) and
  `0 40px 90px -24px` (ink 32% light, black 95% dark). Menus use `0 24px 60px -18px`.
- **Fallbacks:** without `backdrop-filter`, or with `prefers-reduced-transparency`, the surface becomes a nearly opaque
  sheet (`#fafafc` light, `#060608` dark) and the blur is switched off.
- Do not put utility classes like `bg-glass-strong`, `backdrop-blur-*`, `border-line` or `shadow-pop` on the window:
  utilities win over the components layer and would cancel the glass.

## Layout

```
┌──────────────────────────────────────────────┐  window: fixed, centred, 16px from the bottom
│ ⬡ Brain chat                      ▤  ↺  [✕] │  header
│                                              │
│                         ┌──────────────────┐ │  messages (scrolls; soft fade at both ends)
│ Brain  Haiku 5.5        │ your message     │ │
│ The answer sits on the  └──────────────────┘ │
│ glass, no card…                              │
│ ┌──────────────────────────────────────────┐ │  queued messages, attached files, long pastes
│ ┌──────────────────────────────────────────┐ │  composer
│ │ What do you want done?                   │ │
│ │ To The Brain ⌄  ✳ Brain · Haiku 5.5 ⌄  📎 ↑│ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

- Window: `w-[min(680px,calc(100vw-32px))]`, `h-[min(70vh,640px)]`, `bottom-4`, `rounded-[16px]`, `overflow-hidden`.
- Horizontal padding is `px-5` (20px); the header and composer drop to `px-4` at 700px wide and under (`max-sm:`).
- Messages: `px-5 pt-4 pb-5`, `gap-6` between messages. A mask fades the list over 12px at the top and 14px at the bottom,
  so what scrolls past the header or the composer melts into the glass instead of being cut. There is no rule under the
  header and none above the composer.

## Typography

Geist (the page font) at normal letter-spacing. Chat text uses `font-chat`, which follows Settings > Look.

| Where | Size / weight |
|---|---|
| Title "Brain chat" | 14px, 600 |
| Messages | 14px / 1.6 |
| Name row (avatar, "Brain", model) | name 13px 600; model id 11.5px mono, faint |
| Empty state title / text | 16px 600 / 13.5px, 1.55, dim |
| Example prompts, menu items | 13.5px |
| Composer footer ("To", the To button, the model chip) | 12.5px |
| Menu group labels | 12px, 500, faint |

## Parts

### Header
Brain icon (17px, dim) and the title on the left. On the right three 26 to 28px icon buttons: MEMORY.md and New
conversation are quiet (no border, tint on hover), Close is bordered like the Station panel's close. Icons are 15 to 16px.

### Messages
- **Yours:** a soft plate, right-aligned, max 85% wide: `rounded-[12px]`, hairline border, `bg-panel-2`, `py-2.5 px-3.5`.
- **Answers (the Brain, agents, teams):** no card. A small name row says who wrote them (24px avatar, 13px name, model in
  mono), then the text on the glass. The avatar tile is `bg-accent/10`.
- **Actions the Brain took** ("Made the Social media team", "Handed to …"): light plates, `py-1.5 px-3`, 7px radius,
  hairline border, `bg-panel`, 13px, with a 13px icon.
- **Agent draft:** the one card that stays (it is a form): hairline accent border at 40%, `bg-panel`.
- Markers the tests look up stay on the elements: `dock-msg`, `user`, `brain`.

### Empty state
A 44px glass tile (12px radius, inset highlight) holding an accent sparkle, "Ask the Brain" (16px 600), a short
paragraph (13.5px, dim, max 380px) and three example prompts: *What is everyone working on?*, *Make me a social media
team*, *Write PROJECT.md for this project*. They are quiet plates (`.dock-suggest`: 10px radius, `bg-panel`, hairline
border, 9px 14px). Clicking one puts it in the box as if typed (the `/` menu and Send see it), focuses the box and puts the
cursor at the end. It does not send.

### Composer
One glass field (`.dock-composer`): 12px radius, 1px `line-2` border, `bg-panel`, inset top highlight.
- **Text box:** borderless and transparent inside it, `min-h-[56px]`, grows with the text up to `max(160px, 20vh)`,
  padding `12px 14px 4px`.
- **No focus ring on the box** (a deliberate choice). The global `:focus-visible` outline and the field's own ring are both
  off, and the composer's border does not change on focus; the cursor is the indicator. Every other control in the row
  keeps its keyboard focus style.
- **Footer row** (`px-2 pt-1 pb-2`), left to right: the word "To" (12.5px, faint), the **To button**, the **model chip**,
  then on the right the **paperclip** (32px quiet icon button) and **Send** (32px accent button with an up arrow, 16px).
  While something works and the box is empty, Send becomes **Stop** (danger button, square icon).
- The To button and the model chip are both **exactly 28px tall** at 12.5px, with a 7px radius, no border, a transparent
  fill and a panel tint on hover or while their menu is open. (They were mismatched at first; measured in the browser
  after the fix: 28px and 28px.)
- **Narrow screens:** To and the chip wrap onto their own lines; the paperclip and Send stay together on the right.

## Dropdowns

All floating menus share one look (`.st-menu*` in `components.css`), taken from ReUI's DropdownMenu (shadcn's, on Base
UI's Menu): compact rows, a popup with a hairline ring and padding, a tinted highlight, small muted group labels, and a
check on the chosen item. It is dressed in this app's tokens and glass instead of shadcn's.

| Part | Value |
|---|---|
| Popup | glass, `padding: 4px`, `border-radius: 10px`, 1px line border, `max-height: 480px`, scrolls |
| Item | `padding: 6px 8px`, `gap: 8px`, `border-radius: 7px`, 13.5px / 20px, 16px icon in the icon colour |
| Highlight (hover, arrow keys) | a tint: ink 6% (light) or white 9% (dark), not a grey block; icon goes to ink |
| Group label | 12px, 500, faint, `padding: 6px 8px 4px` |
| Separator | 1px line, `margin: 4px -4px` (runs to the popup's edges) |
| Chosen item | check at the right (14px, accent) |
| Danger item | red text, red 12% tint on highlight |
| Disabled | 50% opacity, no pointer events |

`web/ui/dropdown.tsx` is the React side: `Dropdown`, `DropdownTrigger`, `DropdownContent`, `DropdownItem`,
`DropdownGroup`, `DropdownLabel`, `DropdownSeparator`, `DropdownRadioGroup`, `DropdownRadioItem`. It is not modal (the page
keeps scrolling), the popup is placed against its trigger with an offset of 6px and 8px of collision padding, and it flips
to the other side when there is no room.

- **To menu** (`TargetMenu` in `dock.tsx`): a radio menu opening upward, `min-w-52`, `max-h-96`. Choices: *The Brain*, *New
  agent from this*, *New team from this*, then an **Agents** group (each with its real badge, not a small emoji) and a
  **Teams** group. The button shows the choice (with the agent's badge) and a thin chevron. The Brain's one-line description
  that used to be in the old select's text lives in the button's tooltip and the empty state.
- **Paperclip menu** (`web/attachmenu.tsx`): *Files…* and *A folder…*, opening upward and aligned to the right edge,
  `min-w-40`. It is its own small React tree inside the plain-DOM tray, so the tray is told the icon weight
  (`attachTray({ iconWeight })`).
- **Model picker** (`openModelPicker` in `web/models.ts`): **restyled, not rebuilt**. It has provider tabs, an effort row, a
  search box and favourite stars, and about 20 tests on its structure, so it keeps its plain DOM and takes the shared
  surface, rows and group labels.

## Icons

Phosphor, through one name table (`web/phosphor.ts`). The window sets `IconWeightProvider value="regular"` at its root, so
React `Icon`s inside are Regular (the rest of the app is Light). The paperclip is drawn in its own React tree and is passed
the weight. Chevrons are 12px (To button, model chip); header and menu icons 15 to 16px; the Brain icon 17px.

## Motion

All motion uses transform and opacity only. Settings > Look > Motion: Reduced (and the system's reduced-motion setting)
turns it off; the programmatic animations check `reducedMotion()` (`web/motion.ts`) and base styles collapse CSS
animations and transitions to about 0ms.

| What | How | Time / easing |
|---|---|---|
| **Window opens** | grows out of the "Ask the Brain" button's box (`flipFrom`, with a fade); its sections (header, messages, composer, …) then slide up 10px one after another, so the shape leads and the inside arrives a moment later | 460ms `cubic-bezier(.2,.9,.25,1)`; each section 360ms + 60ms per step, delayed 120ms + 40ms per step |
| **Window closes** | folds back into the button's box (`flipTo`), then the button slides back in from 92% | 300ms `cubic-bezier(.5,0,.75,0)`; button 260ms |
| **A message arrives** | rises 6px while fading in (`rise-in`) | 0.22s, `--ease-soft` |
| **To and paperclip menus open** | opacity 0 to 1 and scale .96 to 1, with a 4px slide from the trigger's side; origin is the trigger (`--transform-origin`) | 0.14s; the transform eases with `--ease-soft` |
| **To and paperclip menus close** | the reverse, kept on screen until it ends (Base UI waits for the transition) | 0.10s |
| **Model picker opens** | `menu-pop` keyframe: opacity 0 to 1, scale .97 and a 3px slide (`--menu-dy`), origin top-left (below the chip) or bottom-left (above it) | 0.14s, `--ease-soft` |
| **Model picker closes** | fades and shrinks to .97 (`slideOut`), no clicks while it goes, then removed; removed at once if Motion is Reduced or there are no animations; a 500ms backstop removes it if the animation never ends | 110ms `cubic-bezier(.5,0,.75,0)` |
| Hover and open states | background and colour transitions | 0.12s (menu items), 0.15s (To button, example prompts) |

Measured in a real browser (frame by frame): each popup goes from opacity 0 to 1 over 6 to 7 frames on the way in, and
spends 5 frames fading out before it is removed 100 to 120ms later.

Base UI popups get the class `dd` (set in `DropdownContent`), which turns off the `menu-pop` keyframe and uses the
`data-starting-style` / `data-ending-style` transitions instead. Other `.st-menu` popups (the project menu, the Station
right-click menu, skill pickers) get the `menu-pop` entrance but still leave instantly.

## Behaviour that goes with the look

- **Esc** closes an open menu and leaves the chat open (the chat's own Esc handler skips while any `.st-menu`,
  `.model-menu` or dialog is open). With nothing open, Esc closes the chat.
- **Keyboard in menus:** opening puts focus on the chosen item; arrows move; Enter picks and closes; focus returns to the
  button. Verified in a real browser (two ArrowDowns then Enter on *The Brain* lands on *New team*, and the button updates).
- Names for assistive tech: the To button is "Send to", the paperclip "Attach files", Send "Send", Stop "Stop", the header
  buttons "The Brain's MEMORY.md", "New conversation" and "Close".
- The chat's state (target, items, queue) lives in the module; React draws it. Pick a target and the model chip follows it.

## Where it lives

| File | What |
|---|---|
| `web/dock.tsx` | the window, `TargetMenu`, empty state, message looks (constants at the top), the composer |
| `web/ui/dropdown.tsx` | the dropdown component |
| `web/attachmenu.tsx`, `web/attach.ts` | the paperclip menu; `attachTray({ iconWeight })` |
| `web/models.ts` | the model picker (`openModelPicker`), its exit animation, the model chip |
| `web/motion.ts` | `flipFrom`, `flipTo`, `slideIn`, `slideOut`, `reducedMotion` |
| `web/ui/react.tsx` | `Icon`, `IconWeightProvider` |
| `web/styles/components.css` | glass, `.st-menu*`, `.dock-composer`, `.dock-target`, `.dock-suggest` |
| `web/styles/app.css` | `--animate-menu`, `menu-pop`, `rise-in`, `--ease-soft` |

Tests: `tests/web/dock.test.tsx` (example prompts, the To menu, Esc), `dock-reset.test.tsx`, `dropdown.test.tsx` (the
dropdown and the paperclip), `groupD-pickers.test.ts` (the model picker, including waiting for its exit),
`iconweight.test.tsx`.

## Glass across the app

- Floating dialogs, menus, chat windows, toasts, the approvals drawer and Station overlays use the shared glass material.
  Dialog backdrops do not blur: the dialog itself needs to see the page behind it.
- Flat pages and the attached sidebar use plates instead of blur. `.glass-plate` gives them a panel fill, hairline edge and
  inset highlight; the glass tokens are available at the root for plates outside floating surfaces.
- Settings sections share the Section and Row layout. Programs and Outbox use the same layout.
- Agent and team chats use one composer with controls below the text; answers sit directly on the window.
- Choice controls use the shared Base UI select and glass menu rather than native select popups. Checkboxes and segmented
  controls share the same treatment on pages and in dialogs.
- Plain-DOM project, skill, mention and model menus and Base UI menus use exit motion; reduced-motion settings still apply.


## Decisions and what was rejected

- **To and the model moved from the header to under the text box.** The header was crowded (title, "To", a select, a
  pill, three icons) and the select truncated its own label. Who you send to belongs next to what you are typing.
- **The native `<select>` became a menu.** Its popup could not be styled (white in dark mode) and showed agent emoji as
  tiny text. The label also dropped its description ("answers, builds, hands off") and lost the 🧠 emoji.
- **Answers lost their card.** Boxes inside boxes (a bordered answer holding bordered action rows) read as clutter.
- **No focus ring on the text box.** Requested; the ring was two stacked (the composer's glow and the browser's outline).
- **The model picker was restyled, not rebuilt on Base UI**, to avoid a risky rewrite of a rich popup.
- **Tracking is normal.** Negative letter-spacing tuned for Inter made Geist's and Archivo's words run together.

## Not done yet

- Agent and team replies share the answer container and follow the same plain style, but were not rendered with live
  content during the remake (only the Brain's own messages were).
- No visible focus indicator on the text box is a trade-off for keyboard users; a very faint border change on
  `:focus-within` would restore one with a single rule in `.dock-composer`.
