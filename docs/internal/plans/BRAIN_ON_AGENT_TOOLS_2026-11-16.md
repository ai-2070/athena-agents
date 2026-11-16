# The Brain on agent tools

16 November 2026. Status: built on `LZL0/brain-agent-tools`, in three commits (the Brain's tools; its turn as an
agent run; the access level), with docs. `bun run check` passes. See "As built" for where it differs from the plan.

The Brain has its own way to use tools. It writes JSON actions at the end of its answer, the server runs the
look-ups among them and asks it again (up to 4 rounds), and the other actions run once the answer is final.
Agents call tools natively through their engine. Every capability the Brain shares with agents is built twice,
most recently session search (`search_sessions` / `read_session` as agent tools and as Brain look-ups).

Goal: the Brain runs on the same engines and tool system as agents, in one change. Look-ups become ordinary
tools, the roster actions become tools only the Brain gets, and the JSON action protocol and its look-up loop go
away. One access level (today's "Tool access") decides what the Brain may do without asking, for all of its
tools. It starts at Full.

## Decisions

- **One change, no interim.** All Brain actions move to tools together. An in-between step that keeps a final
  `actions` block on top of an agent run would be thrown away right after.
- **Old Brain chats stay where they are.** They are not converted now and not shown in the new Brain chat. Their
  files are never deleted or rewritten, so a converter can come later. Session search keeps reading them.
- **The SNAPSHOT** becomes a short summary sent with each turn, with tools for the details (see Phase steps).
- **One access level for all the Brain's tools**, default Full: Full, Ask first, Read only (see Access level).
  Hiring, creating teams and delegating run without asking at Full, as they do today.

## As built

- **Old Brain chats are not left behind after all.** The Brain chat keeps its own conversation files; each
  conversation records the agent chat that holds its engine session (`chatId`), the way a team member keeps a
  session per team. A conversation without one (from before, or a new session) gets its last messages with the
  first message, as before. Nothing is converted, nothing is hidden, and gateway and board-task conversations go on.
- **The action reference stays in the system prompt**, each entry labelled with the tool that takes it
  (`team {"do":"create_team",…}`). The tools themselves take `do` and the action's fields and apply it with
  `applyActions()`, so every existing check (and its tests) stays in one place. `'new'` carries across calls.
- **The Brain's MCP use stays its own** (`mcp_use`: `brainmcp.ts`), not the engines' native MCP: "ask only for
  calls that change things" works the same on every engine.
- **The SNAPSHOT summary** is NOW, the project, its folder, agents, teams, work handed out and what waits for the
  user. `project_overview` has files, tasks, board, routines, skills, mcp, activity, world and library.
- **Stopping.** Stop and `/clear` end the run; what already ran stays and is named. New chat, or opening another
  conversation, lets the answer finish where its question went, while its tools refuse further changes (as the
  old Brain kept the answer and applied nothing). A project switch doesn't stop it.
- **Limits.** The 12-actions-per-answer cap is the engines' tool-step limit now; GitHub installs stay capped at 3
  per answer; the shared 48 000-character MCP budget is gone (each result comes back with its own call, still cut
  to 12 000).
- **Files.** Claude Code gets only Read, Glob and Grep; Codex the read-only sandbox; Hermes never `--yolo`;
  opencode only reads. API models get the dashboard's file tools that only read (they couldn't read files before).
- **Engine chats go with their conversation** when it is deleted, pruned or cleared.

## Today (checked in the code)

- **How it thinks.** `think()` in `server/brain.ts` asks for plain text on every provider: chat completions
  without tools for OpenRouter and Venice, a read-only `codex exec`, `hermes chat`, opencode, and Claude Code
  with only `Read,Glob,Grep`. `brainModel()` already maps each provider to an engine id (claude → `claude-code`,
  openrouter/venice → `eve`, `hermes`, `codex`, `opencode`).
- **Its turn.** `answerNow()` in `server/overseer.ts` builds the system prompt (`SYSTEM`, which includes the
  reference for every action) and a user prompt (SNAPSHOT, catalog, the last messages as text, the question). It
  then runs the look-up loop (`read_skill`, `find_models`, `TaskGet`/`TaskList`, `board_find`,
  `mcp_tools`/`mcp_call`, `search_sessions`/`read_session`) and applies the remaining actions with
  `applyActions()`.
- **No session.** Each turn is stateless. History is the last 24 messages (`HISTORY_KEEP`) pasted in as text,
  stored in `brain-chat.json` and `past-chats/brain/`. Gateway conversations are stored under
  `runtime/brain-conversations/`. What the Brain remembers across conversations is its MEMORY.md.
- **About 55 action kinds.** Many already exist as agent tools:

  | Brain action                                                                                                | Agent tool today                                   |
  | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
  | `read_skill`, `create_skill`, `update_skill`                                                                | `read_skill`, `save_skill`                         |
  | `TaskCreate`, `TaskGet`, `TaskList`, `TaskUpdate`                                                           | the same (`tasktools.ts`)                          |
  | `remember`, `write_memory`                                                                                  | `memory_add`, `memory_write`                       |
  | `build`, `world_light`, `world_effect`, `world_env`, `skin`, `animate`, `write_world_md`, `update_world_md` | `world_*` (`voxel/tools.ts`)                       |
  | `search_sessions`, `read_session`                                                                           | the same                                           |
  | `mcp_tools`, `mcp_call`                                                                                     | MCP servers given to the agent, through its engine |

  Only the Brain has these: teams (`create_team`, `add_members`, `remove_members`, `update_team`, `hire`),
  `delegate`, `write_project_md`, the whole board (`board_add`, `board_update`, `board_remove`, `board_tag`,
  `board_find`, `board_comment`; agents only reach their own task), routines (`create_routine`,
  `update_routine`, `run_routine`, `delete_routine`), skill admin (`give_skill`, `take_skill`, `set_skills`,
  `install_skill`, `delete_skill`), MCP admin (`add_mcp`, `update_mcp`, `remove_mcp`, `give_mcp`, `take_mcp`,
  `set_mcp`), `set_model`, `find_models`, `stop`, `station_look`, `background`.

- **All or nothing.** Actions run only after the final answer. If the user stops the Brain, starts a new
  conversation or switches projects while it thinks, nothing changes (MCP calls that already ran are reported).
- **Checks against what the user typed.** A custom MCP server's command, link, env and headers must be
  exactly what the user wrote in the chat (`notFromUser`, `userWords`). `install_skill` takes only GitHub links
  the user gave unless `brainAnyGitHub` is on. A skill's body can be rewritten only if the Brain saw its whole
  text in this turn (`seenSkills`).
- **Within one answer, `'new'` means the item made just before** (a team, agent, skill, routine or server), so
  one answer can create a team and delegate to it.
- **One delegate per answer**, sent after the actions with `sendBrief()` (`irc.ts`): the objective, the task ids
  and the goal, which the follow-up checks use.
- **Approvals.** Settings › The Brain's tools › Tool access (`brainTools`: full, ask or off) covers only the
  Brain's MCP use. In "ask", MCP calls that change things go to Needs you as `agentId: 'brain'`; "off" gives it
  no MCP tools. Roster actions never ask. The Brain never reviews its own requests.
- **Other `think()` callers stay as they are.** Approval review (`brainApproves`), follow-up checks (`irc.ts`),
  task drafts (`taskdraft.ts`) and the self-improvement review (`learning.ts`, which runs `applyActions` with
  skill actions only) are one-shot JSON calls. They are not part of this plan.

## Target

- The Brain is an agent run: a built-in agent with id `brain`. It isn't stored in `agents` and isn't listed
  with them; its engine and model come from `brainModel()`. Its turns go through `startRun()`, so it gets Stop,
  steering, runs pinned to their project, context accounting and compaction like any agent.
- Its new conversations are agent chats (`chats/brain/`), shown on the Brain chat page with the same components
  as agent chats.
- Tools: every `core` tool, the shared ones above, and a `brain` tool group that only the Brain gets. MCP servers
  that are on reach it through its engine like an agent's.
- `SYSTEM` keeps the role and the rules. The action reference moves into the tools' descriptions.
- The access level decides what runs without asking, for every tool alike.

## Access level

Today's "Tool access" control becomes the Brain's access level for all of its tools, not only MCP.

| Level              | What it does                                                                                                                                                    | How it maps                                                             |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Full** (default) | Everything runs right away: hiring, teams, delegating, the board, skills, MCP setup, MCP calls that send, post, edit or delete.                                 | autonomy `full`                                                         |
| **Ask first**      | Anything that changes something waits for you in Needs you, including hiring, creating or changing teams and delegating. Reading and looking up run right away. | autonomy `auto`: every Brain tool that changes something is `high` risk |
| **Read only**      | The Brain answers, reads and looks things up (files, tasks, sessions, MCP tools that only read). Tools that change things aren't offered.                       | change tools filtered out of its list; a call is refused too            |

- **"Off" goes away.** Applied to all tools it would leave a Brain that can't do its job. Read only takes its place.
- **Setting.** A new key `brainAccess: 'full' | 'ask' | 'read'`, default `full`, replaces `brainTools`. Saved
  values move over once: `full` → `full`, `ask` → `ask`, `off` → `ask` (someone who turned MCP tools off wanted
  control, not a Brain that stops building teams).
- **Settings page.** The section is renamed from "The Brain's tools" to **"What the Brain may do"**, the row
  from "Tool access" to **"Access"**, with the choices **Full**, **Ask first** and **Read only**. Descriptions:
  - Full: "The Brain hires, builds teams, hands out work and uses every tool right away, including ones that send,
    post, edit or delete. It only does those when you ask for them."
  - Ask first: "Anything that changes something waits for you in Needs you: new agents and teams, handing out
    work, the board, skills, MCP servers and tools. Looking things up runs right away."
  - Read only: "The Brain answers and looks things up, but changes nothing. Ask an agent or team for the work."
    The section description no longer talks only about MCP servers. The "allowed without asking" list
    (`BrainGrantsRow`) stays below it and now also covers Brain tools.
- **Risk ratings.** Every Brain tool that creates, changes, deletes, sends or starts work is `high`, so "Ask
  first" catches it. Look-ups are `none`. MCP tools keep `mcpToolRisk()`; agents' `ask` autonomy would also stop
  MCP tools that only read (rated `low`), which is why "Ask first" maps to `auto`.
- **Always allow.** Approving with "always" adds the tool to the Brain's grants (`brainGrants`, today MCP only),
  so a user on "Ask first" can let hiring or delegating through for good.
- **Unchanged and separate.** "The Brain approves" (`brainApproves`, the Brain answering agents' and teams'
  permission requests) is a different switch and stays. The Brain still never reviews its own requests.
- **Gateways.** In a gateway conversation the existing limits apply at every level: no board except a task's own
  conversation (`boardScope`), no memory, no session search.

## Steps

1. **Identity.** A built-in Brain agent (`brainAgent()`): id `brain`, engine and model from `brainModel()`,
   workspace the Brain folder, file access read-only as today, autonomy from `brainAccess`. Tool code that
   requires `agents.get(id)` (for example `search_conversations` and the session search helper) accepts it
   explicitly. It never shows up in `list_agents`, the Station or the agent pages.
2. **Chats.** New conversations are agent chats under `chats/brain/`, including gateway and board-task ones.
   Update what reads the old history: `boardwork.ts`, `gateways/execution.ts`, the follow-up checks that call
   `history()`, `overview.ts`, backups and `projectsync.ts` (back up and sync the new chats; an older backup
   still restores `brain-chat.json`, which stays unread). The old files are left untouched.
3. **The SNAPSHOT.** A short summary goes with each turn (counts, who is working, what waits for the user, what
   changed since the last turn). The details move to Brain tools: `project_overview` (agents, teams, models,
   access), `project_files` and the existing board, task, skill and MCP look-ups. Measure the summary's size;
   it must not grow with the project.
4. **Brain tools.** A `brain` group only the built-in Brain can hold, never given to an agent or team and not
   available through `request_tool`. Fewer, broader tools work better on small models (the default Brain model
   is Haiku): `team` (create, members, update, hire), `delegate`, `project_md`, `board` (add, update, remove,
   tag, find, comment), `routine`, `skill_admin` (give, take, set, install, delete), `mcp_admin` (add, update,
   remove, give, take, set), `set_model`, `find_models`, `stop`, `station`. Shared work uses the agent tools that
   already exist (`read_skill`, `save_skill`, `memory_*`, `world_*`, `Task*`, `search_sessions`).
5. **Keep the checks inside the tools.** MCP settings and GitHub links are checked against the user's own
   messages in the run's chat: items of type `user` from the user, never team messages, tool results or
   messages from agents. `seenSkills` becomes "the Brain read this skill's whole text with `read_skill` in this
   conversation since it last changed".
6. **Ids instead of `'new'`.** Tools return the id of what they make.
7. **Delegating sends right away**, through `sendBrief()` with the objective, tasks and goal, so follow-ups and
   `/goal` keep working.
8. **Stop now leaves what already ran.** A tool takes effect when it is called. The chat shows the tool steps
   that ran, as it does for agents, and the stop note says what changed. Release note: Stop no longer means
   "nothing happened". A new conversation started during a turn stops it; a project switch no longer matters,
   since the run finishes in its own project.
9. **Delete the old path.** The look-up loop, `LOOKUP_ROUNDS`, the re-prompt, `parseActions` for chat turns, the
   action reference in `SYSTEM`, `runSessionLookups`, the MCP calling in `brainmcp.ts` (its grants move to the
   normal gate) and the `applyActions` paths only chat turns used. `learning.ts` keeps its skill-only
   `applyActions`, or moves to the same tools.
10. **Docs.** README and `docs/guide.md`: the access level, Stop, and that Brain chats from before the change
    aren't shown (they are kept, and agents can still find them with session search).

Commit in reviewable steps on one branch; release once.

## Security boundaries to keep

- Secrets never reach the Brain's prompt or tool results, as today.
- MCP server settings come only from what the user typed; GitHub installs only from links the user gave unless
  `brainAnyGitHub` is on.
- Gateway limits come from the run's conversation id, never from an argument.
- The `brain` group can't be given to any agent or team, and `request_tool` can't ask for it.

## Tests

- The Brain answers on each engine with a fake model and calls tools natively: `read_skill`, `TaskList`,
  `search_sessions`, an MCP tool, `team`, `delegate`. Most Brain tests drive `ask()` with actions blocks today;
  they move to fake tool calls, like the Eve engine tests.
- Access level: Full runs everything; Ask first sends hiring, team changes, delegating and changing MCP calls to
  Needs you and runs look-ups and reading MCP tools; Read only doesn't list change tools and refuses a call.
  "Always allow" lets one tool through. Old settings move over (`off` becomes Ask first). The Brain never
  reviews its own request.
- Each Brain tool's checks: a command an agent wrote in a team message is refused, the GitHub link rule, the
  seen-skill rule, gateway limits. The group can't be given to an agent.
- Stop during a turn reports what changed. Follow-ups still find the delegate's objective and tasks.
- Old Brain chat files are untouched after a turn, and session search still finds them.
- Settings page: the renamed section, the three choices and their saved values.
- `bun run check`, `bun run build`, and the desktop staging build with `bun run desktop:smoke`.

## Risks

- **One big change.** `overseer.ts` is over 3 000 lines and most Brain tests are rewritten. Reviewable commits
  and the existing behavior tests, ported, are the guard.
- **Old history out of sight.** Users see an empty Brain chat after the update, and gateway and board-task
  conversations with the Brain start over. Nothing is deleted; a converter can follow.
- **Smaller models with many tools.** Haiku with the core tools, the world tools and the Brain tools may choose
  worse than it does with the action list. Compare on the ported tests before deleting the action path.
- **Cost.** Native sessions on Claude Code and Codex cost more per turn than today's single call. The prompt
  cache helps once the SNAPSHOT leaves the system prompt.
