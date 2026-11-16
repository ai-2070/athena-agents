# The Brain on agent tools

16 November 2026. Status: plan, nothing built yet.

The Brain has its own way to use tools. It writes JSON actions at the end of its answer, the server runs the
look-ups among them and asks it again (up to 4 rounds), and the other actions run once the answer is final.
Agents call tools natively through their engine. Every capability the Brain shares with agents is built twice,
most recently session search (`search_sessions` / `read_session` as agent tools and as Brain look-ups).

Goal: the Brain runs on the same engines and tool system as agents. Look-ups become ordinary tools, and the
roster actions become tools only the Brain gets. The JSON action protocol and its look-up loop go away.

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
  `runtime/brain-conversations/`.
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
- **Approvals.** "The Brain's tools" (`brainTools`: full, ask or off) covers all of the Brain's MCP use. In
  "ask", calls that change things go to Needs you as `agentId: 'brain'`, and the Brain never reviews its own
  requests.
- **Other `think()` callers stay as they are.** Approval review (`brainApproves`), follow-up checks (`irc.ts`),
  task drafts (`taskdraft.ts`) and the self-improvement review (`learning.ts`, which runs `applyActions` with
  skill actions only) are one-shot JSON calls. They are not part of this plan.

## Target

- The Brain is an agent run: a built-in agent with id `brain`. It isn't stored in `agents` and isn't listed
  with them; its engine and model come from `brainModel()`. Its turns go through `startRun()`, so it gets Stop,
  steering, runs pinned to their project, context accounting and compaction like any agent.
- Its conversations are agent chats. The Brain chat page renders them with the same components as agent chats.
- Tools: every `core` tool, the shared ones above, and a `brain` tool group that only the Brain gets. MCP servers
  that are on reach it through its engine like an agent's, with `brainTools` as their approval mode.
- `SYSTEM` keeps the role and the rules. The action reference moves into the tools' descriptions.

## Phase 1: run the Brain as an agent, with look-ups as tools

This phase carries most of the cost: the Brain's chat storage and page change here, not in phase 2.

1. **Identity.** A built-in Brain agent (`brainAgent()`): id `brain`, engine and model from `brainModel()`,
   workspace the Brain folder, file access read-only as today. Tool code that requires `agents.get(id)` (for
   example `search_conversations` and the session search helper) accepts it explicitly. It never shows up in
   `list_agents`, the Station or the agent pages.
2. **Chats.** Store its conversations as agent chats (`chats/brain/`). Move the open `brain-chat.json`, past
   conversations and private gateway conversations over once, keeping ids and times. Update backups,
   `projectsync.ts`, `overview.ts`, `boardwork.ts`, `gateways/execution.ts` and the follow-up code that reads
   `history()`. A project restored from an older backup still has `brainChat`: convert it on restore.
3. **The SNAPSHOT.** Today it is rebuilt every turn and is large. Agent sessions keep every user turn, so
   pasting it each time would fill the session. Decision needed (see below).
4. **Look-ups become tools.** `read_skill`, `TaskGet`/`TaskList`, `search_sessions`/`read_session` and MCP
   are tools it already has. `find_models` and `board_find` become `brain` group tools. Delete the look-up loop,
   `LOOKUP_ROUNDS`, the "YOUR FIRST ANSWER" re-prompt and `runSessionLookups`. Keep `brainmcp.ts` only if the
   "ask" approvals can't be expressed through the normal gate (see Approvals).
5. **Roster actions stay as a final `actions` block for now.** When the run ends, parse the block from its last
   message and apply it with `applyActions()` and the same checks. Stale handling: Stop aborts the run; a new
   conversation started meanwhile stops it; a project switch no longer matters, since the run stays pinned to
   its project and finishes there.
6. **`done` and the delegate.** Keep the `done` cards and the one delegate per turn, applied after the run, so
   the chat and the follow-ups work as they do now.

Afterwards: one tool system for everything the Brain reads, no round limits, and the Brain keeps a native session.

## Phase 2: roster actions become Brain-only tools

1. Add a `brain` tool group that only the built-in Brain agent can hold, with `risk: 'high'` for everything
   that creates, changes, deletes or sends. Fewer, broader tools work better on small models (the default Brain
   model is Haiku), so group them: `team` (create, members, update, hire), `delegate`, `project_md`, `board`
   (add, update, remove, tag, find, comment), `routine`, `skill_admin` (give, take, set, install, delete),
   `mcp_admin` (add, update, remove, give, take, set), `set_model`, `stop`, `station`. Shared work uses the agent
   tools that already exist (`save_skill`, `memory_*`, `world_*`, `Task*`).
2. **Keep the checks inside the tools.** MCP settings and GitHub links are checked against the user's own
   messages in the run's chat: items of type `user` from the user, never team messages, tool results or
   messages from agents. `seenSkills` becomes "the Brain read this skill's whole text with `read_skill` in this
   conversation since it last changed".
3. **Ids instead of `'new'`.** Tools return the id of what they make; `'new'` is no longer needed.
4. **The delegate becomes a tool** that sends right away, with `sendBrief()`'s objective, tasks and goal, so
   follow-ups keep working.
5. **Partial turns.** A tool takes effect when it is called, so a stopped turn can leave some changes made. The
   chat must show the tool steps that ran (they do for agents) and the stop note must say what changed. This is
   the one real change in behavior; Stop no longer means "nothing happened".
6. Delete the `actions` block, `parseActions` for chat turns, the action reference in `SYSTEM` and the
   `applyActions` paths that only chat turns used. `learning.ts` keeps its skill-only `applyActions`, or moves to
   the same tools.

## Approvals

- The Brain's tool calls go through `callTool()` and `gate()` like an agent's. Its autonomy follows
  `brainTools`: full → `full`; ask → read-only and `none`-risk tools run, others go to Needs you; off → no MCP
  servers. Roster tools are `high` and therefore ask in "ask" mode, which they don't today; decide whether they
  get their own switch (see below).
- `brainApproves` must never review the Brain's own requests. Keep that check on `agentId === 'brain'`.
- "Always allow" for the Brain stays in its own grants (`brainGrants`), shown in Settings as now.

## Security boundaries to keep

- Secrets never reach the Brain's prompt or tool results, as today.
- MCP server settings come only from what the user typed; GitHub installs only from links the user gave unless
  `brainAnyGitHub` is on.
- Gateway conversations: no session search, no board except a task's own conversation (`boardScope`), no
  memory. The run's conversation id decides this, never an argument.
- The `brain` group can't be given to any agent or team, and `request_tool` can't ask for it.

## Decisions needed

1. **The SNAPSHOT.** (a) Send it with each turn as context that isn't saved in the session (the engines don't
   have this yet; `startRun`'s `context` carries team messages only). (b) Make it a `project_snapshot` tool and
   send a short summary each turn. (c) A mix: a small summary each turn, the details through tools.
   Recommendation: (c). It keeps sessions small and the Brain looks up only what it needs.
2. **Approvals for roster tools.** In "ask" mode, should creating teams, hiring and delegating ask first?
   Recommendation: no. They are the Brain's job; keep "ask" for MCP calls that change things, as today.
3. **Old Brain chats.** Convert them (recommended) or keep them readable but closed.
4. **One release or two.** Phase 1 can ship alone. Phase 2 changes what Stop means and should ship separately,
   with a note in the guide.

## Tests

- Phase 1: the Brain answers on each engine with a fake model and calls `read_skill`, `TaskList`,
  `search_sessions` and an MCP tool natively; no look-up loop runs. Conversion of an old `brain-chat.json`,
  past chats, a gateway conversation and an old backup. Stop, steer and a new conversation during a turn. The
  final `actions` block is still applied with every existing check (`brain-mcp-tools`, skills, routines, board,
  install and MCP tests keep passing).
- Phase 2: each `brain` group tool, with the user-words check (a command an agent wrote in a team message is
  refused), the GitHub link rule, the seen-skill rule and gateway limits. The group can't be given to an agent.
  A stopped turn reports the changes that did happen. The follow-up checks still find the delegate's objective
  and tasks.
- Every phase: `bun run check`, `bun run build`, and the desktop staging build with `bun run desktop:smoke`.

## Risks

- **Phase 1 changes storage.** A conversion bug loses Brain history. Back up before converting and keep the old
  files until the next start succeeds.
- **Smaller models with many tools.** Haiku with the core tools, the world tools and the Brain tools may choose
  worse than it does with the action list. Measure on the existing Brain tests before deleting the action path.
- **Cost.** Native sessions on Claude Code and Codex cost more per turn than today's single call. The prompt
  cache helps when the system prompt is stable, which it becomes once the SNAPSHOT leaves it.
