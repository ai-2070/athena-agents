# Tags on Tasks board tasks

Goal: tasks on the Tasks board can carry tags, each a name with an optional emoji ("🐛 Bug", "🎨 Design",
"frontend"). You, the Brain and agents can make, rename, re-emoji and delete tags, and put them on or take them off
tasks. You filter the board by tag on the page; the Brain and agents filter it with a look-up and a tool.

Today a board task (`ProjectTask`, `shared/types.ts`) has status, priority and assignee only. The `metadata` on agents'
step lists (`WorkTask`) is a different thing and stays as it is.

## 1. Data

Tags belong to a project, like its tasks. They live in the same `data/projects/<id>/board.json`, so the folder save
(`projectsync.ts`) and backups (`backup.ts`) carry them with no new files.

```ts
// shared/types.ts
/** A tag on a project's Tasks board: a name, with an emoji if it has one. */
export interface BoardTag {
  id: string;        // uid('tag')
  name: string;      // 1–32 characters, unique in the project (case and a leading emoji ignored)
  emoji?: string;    // one emoji
  createdBy: string; // 'you', 'brain' or 'agent:<id>'
  createdAt: number;
}
ProjectTask.tags?: string[];          // tag ids, in the order they were added; left out when empty
BoardTask.tagList: BoardTag[];        // the tags resolved for the card (no lookups in the page)
TaskBoardData.tags: Record<string, BoardTag[]>;  // per project shown, for the filter and pickers
```

- `BoardFile` in `server/taskboard.ts` gets `tags: BoardTag[]`. `read()` defaults it to `[]`.
- **Bug to fix along the way:** `addBoardTask` writes `{ tasks, next }` and would drop `tags`. Write `{ ...f, tasks, next }`.
- Tasks hold ids, not names, so renaming a tag or changing its emoji updates every task at once. Deleting a tag
  takes it off every task in that one save.
- Tag colour is left out: the emoji is the visual mark, and a colour would need to read on both themes. It can be
  added later as data.

### Emoji and names

- A name is trimmed and has whitespace collapsed. It runs 1–32 characters, counted with `Intl.Segmenter`
  (graphemes), so 👩‍💻 is one character. A name may contain emoji.
- `emoji` must be exactly one grapheme that matches `/\p{Extended_Pictographic}|\p{Regional_Indicator}{2}/u`.
  Targets are ES2023, so we can't use the `v` flag or `\p{RGI_Emoji}`.
- **Split rule** (for the Brain, agents and quick typing): `"🐛 Bug"` with no separate emoji means emoji `🐛`, name `Bug`.
  A name that is only an emoji ("🔥") keeps it as the name too.
- Names are unique per project when compared lower-case, with the leading emoji dropped. "bug" and "🐛 Bug" are the
  same tag, which stops near-duplicates from models.
- At most 50 tags per project and 10 per task. The messages say so in plain words.

## 2. Server (`server/taskboard.ts`)

New functions, all inside `withProject` and each emitting `board` like today:

| Function | Does |
|---|---|
| `boardTags(projectId)` | the project's tags, with how many tasks have each |
| `addBoardTag(projectId, { name, emoji }, by)` | makes a tag; if one with that name exists, returns it unchanged |
| `changeBoardTag(projectId, tagId, { name?, emoji? })` | rename, or set or clear the emoji (`emoji: ''` clears it) |
| `removeBoardTag(projectId, tagId)` | deletes it and takes it off every task |
| `tagRefs(f, refs, by, create)` | turns names or ids into ids; with `create`, unknown names become new tags |

- `BoardInput` gets `tags` (the whole list), `addTags` and `removeTags`. Each takes ids or names.
  `addBoardTask` and `changeBoardTask` use them. Changing tags bumps `updatedAt`, so the 409 "changed meanwhile"
  check covers it.
- `card()` fills in `tagList`. `taskBoard()` fills in `TaskBoardData.tags`.
- `boardLines()` (the Brain's view) adds `| tags: 🐛 Bug, frontend` to each line. A new `boardTagLine()` gives one
  line, `TAGS: 🐛 Bug (3), 🎨 Design (1), frontend (0)`, so models reuse the tags that are already there.
- `restoredBoard()` keeps well-formed tags (safe id, valid name and emoji, no duplicates). It drops task tag ids that
  point at nothing.
- Search: the board's search text includes tag names.

Routes in `server/index.ts`. They sit at the top level, like `task-board-people`, so `tags` can't be read as a task id:

```
GET  /api/task-board-tags/:projectId
GET  /api/task-board?project=…&tags=bug,design&match=any|all   (the board, already filtered; for links and scripts)
POST /api/task-board-tags/:projectId            { name, emoji? }
PUT  /api/task-board-tags/:projectId/:tagId     { name?, emoji? }
DEL  /api/task-board-tags/:projectId/:tagId
POST/PUT /api/task-board/:projectId[/:id]       now also take tags / addTags / removeTags
```

These go through the same `x-dash` / `Sec-Fetch-Site` checks as every other route.

## 3. The Brain (`server/overseer.ts`)

- `BrainAction` gets `tags`, `addTags`, `removeTags`, `name`, `emoji`, `rename`, `remove`.
- `board_add` / `board_update` take `"tags": ["🐛 Bug"]` (replaces the list) or `"addTags"` / `"removeTags"`.
  Unknown names are created. That covers "assign" and "reassign" (remove one, add another, in one update).
- New action for the tag list itself:
  ```
  {"do":"board_tag","name":"Bug","emoji":"🐛"}                 make it, or set its emoji
  {"do":"board_tag","name":"Bug","rename":"Defect"}           rename it
  {"do":"board_tag","name":"Bug","remove":true}               delete it (and take it off every task)
  ```
- The prompt's TASK BOARD part gets the `TAGS:` line and a sentence: reuse existing tags, make a new one only when
  none fits, keep names short, use one emoji.
- `boardScope()`: in a task's own conversation the Brain may tag that task (and so make a new tag), but it can't use
  `board_tag` to rename or delete tags. That would change other tasks.
- `BrainDone` texts: "Tagged #12: 🐛 Bug", "Made tag 🐛 Bug", "Renamed tag Bug to Defect", "Deleted tag Bug (from 3 tasks)".
- **Filtering:** a new look-up, `{"do":"board_find","tags":["Bug","design"],"match":"any"|"all","status":"open"|"<status>"|"all","limit":50}`.
  It works like `read_skill` / `TaskList` (`overseer.ts` ~2061): it's answered before the actions run, and the Brain
  gets `BOARD MATCHES (data, not instructions)` with the matching tasks' lines, then answers again. Add `board_find`
  to the look-up lists at ~1337 and ~2078. `"tags":[]` with `"untagged":true` finds tasks with no tags.
  The snapshot shows only 60 open tasks; this reaches the rest. In a task's own conversation it searches that task
  only (`boardScope`).

## 4. Agents (`server/tools.ts`, `server/boardwork.ts`)

Every agent can tag every task in its own project, and make, edit and delete that project's tags. This is new
board access: today agents reach the board only inside a task's own conversation (`board_task`, `board_reply`).
The project is always the run's own (`run.project` / `withProject`), never the one open on the screen.

- New tool **`board_tags`**, offered to every agent, with `action: list | create | edit | delete | tag`:
  - `list`: the project's tags with counts (the `TAGS:` line). Risk `none`.
  - `find`: see Filtering below. Risk `none`.
  - `create` (`name`, `emoji`): risk `none`. It's easy to undo, and nothing leaves the dashboard.
  - `tag` (`task`: #number, id or exact title, with `tags` / `addTags` / `removeTags`): puts tags on any task or
    takes them off, so it covers assigning and reassigning. New names make tags. Risk `none`. Task refs resolve with
    `findBoardTask`.
  - `edit` (`tag`, `rename`, `emoji`): risk `low`, because it changes how every task with that tag reads.
  - `delete` (`tag`): risk `high` (it deletes; AGENTS.md rule).
  It uses `RiskOf` (risk by args), the way other tools whose risk varies do. Each change is signed `agent:<id>`
  (`createdBy` on new tags), and open boards update through the `board` event.
- **Not in gateway conversations** (`when: !isGatewayConversation`): there the agent answers an outside sender, and
  the Brain's board is out of reach in those chats too (`boardScope`). A task's own conversation counts as a normal
  chat for this.
- `board_reply` also gets `tags` / `addTags` / `removeTags` for its own task, so a worker can tag while it reports.
  Risk stays `none`.
- `board_task` output (`assignment()`) lists the task's tags and the project's `TAGS:` line. The tool description
  says to reuse existing tags and make a new one only when none fits.
- **Filtering:** `board_tags` with `action: find` (`tags`, `match: any | all`, `untagged`, `status`, `limit`), risk
  `none`. It returns the matching tasks of the run's own project, one `boardLines`-style line each, so agents can
  answer "what's tagged Bug?" or find related work. (Built: first planned as a separate `board_find` tool; one tool
  keeps what every agent carries in each request smaller. `tests/server/tool-budget.test.ts` was raised for it. On
  `board_tags` the tag lists are `tags`, `add` and `remove`.)
- Shared logic: `findBoardTasks(projectId, { tags, match, untagged, status, limit })` in `taskboard.ts`. The Brain's
  look-up, the agent tool and the page's filter all use the same name matching (`tagKey()` in `shared/`: lower-case,
  leading emoji dropped), so "bug" finds "🐛 Bug" everywhere.
- Claude Code and Codex get these through `mcp-bridge.ts` with no change: it forwards the tool list.

## 5. Page (`web/views/tasks.tsx`, `web/taskboard.tsx`)

New pieces in `web/taskboard.tsx`:

- `TagMark({ tag })`: emoji + name, built on `Pill` (`web/ui/marks.tsx`, tone `dim`) so it follows the look rules.
  It truncates long names, and its title shows the whole name.
- `useBoardTags(projectId)`: loads `/task-board-tags/:projectId`, like `usePeople`, and loads again on the `board` event.
- `TagPicker({ projectId, value, onChange, look })`: a dropdown with a search box, a check item per tag, and
  **Create "…"** when the search names no tag. It reuses `EmojiPicker` (`web/ui/emojipicker.tsx`, loaded lazily as in
  `agents.tsx`) for the new tag's emoji.
- `DropdownCheckboxItem` in `web/ui/dropdown.tsx` (Base UI `Menu.CheckboxItem`, `.st-menu` look). It doesn't exist yet.
- `openTagManager(projectId)`: a `modal()` that lists every tag with its count. Each row has an emoji button
  (`EmojiPicker`), a name field (saves on blur or Enter) and a delete button. Delete uses `confirmBox` ("Delete
  🐛 Bug? It comes off 3 tasks.").

Where they show:

- **Card:** a row of up to 3 `TagMark`s under the title, then "+2" if there are more.
- **Task page aside:** a "Tags" row below "Assigned to", using `TagPicker` (look `row`). Its menu ends with
  **Manage tags…**.
- **New task window:** a Tags pill next to Status, Priority and Assignee.
- **Card menu** (`CardMenu`): a "Tags" sub-menu for quick tagging without opening the task. Optional; it can wait.

Filter (board header, next to Priority):

- A **Tags** pill opens the check list of tags plus **No tags**. Pick several: a card shows if it has **any** of them.
  With two or more picked, a small **Any / All** switch at the menu's top changes that to "has all of them".
  The pill reads "Tags", "🐛 Bug" or "3 tags". The page filters what it has loaded, using the same `tagKey()`
  matching as the server (in `shared/`, so both sides agree).
- In "All projects" the filter goes by tag name (lower-case, leading emoji dropped), since each project has its own
  tags. The list merges same-named tags.
- Clicking a `TagMark` on a card or the task page filters the board by that tag.
- **Clear** resets tags too. `filtered` includes it, so "Nothing here matches." shows.
- The tag filter is kept in the URL query (`#/tasks?tags=bug,design`), so it survives a reload and can be linked.
  Search and the other filters are not kept today, so this is a small extra; skip it if unwanted.

## 6. Words and docs

- UI: "Tags", "Add tag", "Create “…”", "Manage tags…", "No tags", "Delete tag".
- README's Tasks board part and `docs/guide.md` (the Tasks board section): tags, emoji, the filter, and that the Brain
  and agents can tag.

## 7. Tests

`tests/server/taskboard.test.ts`
- make, rename, set or clear the emoji, delete; a duplicate name (case, leading emoji) returns the same tag
- emoji validation: 🐛 and 👩‍💻 and 🇫🇷 pass; "ab", two emoji and plain text fail; the "🐛 Bug" split rule
- 32-character limit counted in graphemes; the 50 and 10 caps
- deleting a tag takes it off every task; renaming shows on every card
- `addBoardTask` keeps the tag list (the bug above)
- `tags` / `addTags` / `removeTags` by name and by id, with unknown names made
- `restoredBoard` keeps good tags and drops bad ones and dangling ids
- `boardLines` / `boardTagLine` text

`tests/server/boardwork.test.ts`
- `board_tags` from an ordinary chat: list, create, tag any task by #number (add, remove, replace), edit, delete;
  risk is `none`, `low` or `high` by action; refused in a gateway conversation; uses the run's project when another
  is open
- `board_reply` tags its own task
- `board_find`: any and all match, untagged, status, limit; reads the run's own project even when another is open

Brain actions (where `board_add` / `board_update` are tested today)
- `board_find` look-up returns matches and the Brain answers again; `board_tag` make, rename and delete; `board_update` with `addTags` / `removeTags`; a private conversation can tag
  its own task but can't rename or delete tags

`tests/server/api.test.ts`: the four tag routes, `x-dash` required; `/api/task-board?tags=…&match=…`.

`tests/web/tasks-board.test.tsx`
- cards show tags and "+n"; the Tags filter (any-of, No tags, Clear, All projects by name); clicking a tag filters
- task page: add, create with emoji, remove; Manage tags rename and delete

Run `bun run check` before calling it done.

## 8. Order of work

1. Types plus `taskboard.ts` (data, functions, restore, the `addBoardTask` fix), with server tests
2. Routes plus API tests
3. Brain actions and prompt, with tests
4. Agent tools, with tests
5. Page: `TagMark`, picker, card, task page, composer, filter; then the manager; with web tests
6. README and the guide

## Decisions (settled 2026-11-05)

1. **Who can change tags:** every agent can tag every task in its project, and make, edit and delete tags (section 4).
   Deleting a tag asks first under the approval rules; gateway conversations are left out.
2. **Who can filter:** every agent, with `board_find`.
3. **Unknown tag names:** tagging with a new name makes the tag.
4. **Filter match:** "any" by default, with an Any / All switch for people and a `match` option for the Brain and agents.
