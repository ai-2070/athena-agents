# Faster, cheaper built-in tools and tool calls

4 November 2026. Branch `LZL0/tool-optimization`. Phases 0–4 are implemented; see [Results](#results) at the end. Phases 5 and 6 were decided against for now, from the measurements.

The goal is that agents spend less time and money per tool call, need fewer calls per task, and never
get flooded by one oversized result. Safety does not change: every check in "Security boundaries"
(`AGENTS.md`) stays, and some only get cheaper to run.

## What we found

### Every request carries a large tool list

Measured from `toolsForAgent()` as JSON (name, description, schema), with tokens estimated as characters ÷ 3.6:

| What the model gets                | Tools | Characters | About tokens |
| ---------------------------------- | ----- | ---------- | ------------ |
| Core tools, which every agent gets | 19    | 15 969     | 4 400        |
| Voxel world group                  | 18    | 24 888     | 6 900        |
| Social group                       | 12    | 4 831      | 1 300        |
| Every group switched on            | 91    | 62 931     | 17 500       |

The agent's MCP servers come on top of this. The system prompt adds 3 000–4 500 characters more, plus up to
about 9 000 for the world (`worldPrompt`, `server/voxel/tools.ts:723`).

Core tools that most runs can never use:

- `board_task` and `board_reply` (1 022 characters) only work inside a Tasks board task (`server/tools.ts:251-276`).
- `prepare_gateway_files` and `send_gateway_files` (1 470 characters) only work in a gateway assignment (`server/tools.ts:226-247`).

Text that is said twice:

- `request_tool` is the largest core tool (2 596 characters), because its description lists all 18
  groups with their full descriptions (`server/tools.ts:312`).
- The system prompt explains the Task tools, `set_goal` and `search_conversations` (`server/engines/index.ts:379-381`).
  Their own descriptions already say the same things.
- `world_build` includes all of `STEPS_HELP` (1 800 characters, `server/voxel/tools.ts:52`), which `world_steps` already provides.
- `TaskCreate` and `TaskUpdate` repeat every field twice: once at the top level and once inside `tasks.items` (`bulkSchema`, `server/tasktools.ts:13`).

Results that are bigger than they need to be:

- Seven tools return pretty-printed JSON: ComfyUI status and workflow details, X posts and mentions, and the
  three Reddit reads (`server/tools.ts:405, 429, 852, 860, 868, 876, 884`). Indenting adds about 40% for
  data shaped like this.

### Eve repeats expensive work on every step and every call

Eve is the engine for API models. It asks the dashboard for its configuration from four places:

- the model resolver (`runtime/eve/agent/agent.ts:11`);
- the check before each model call (`agent.ts:17`);
- the instructions resolver (`instructions/athena.ts:4`);
- the tools resolver (`tools/athena.ts:9`).

Eve runs all four before each model call. Each one runs `eveConfiguration` (`server/eve/bridge.ts:32-56`), which:

- rebuilds the whole system prompt: memory, skills, knowledge, WORLD.md and rich answers;
- rebuilds the tool list;
- asks every MCP server for its tool list over the connection, because `mcp.listTools` has no cache
  (`server/mcp.ts:1023`, `server/apitools.ts:33`).

Each tool call also runs `gatherTools` up to three more times (`bridge.ts:67, 120`, and `/policy` runs a second
time inside `/tool`). With three MCP servers, a step that makes one tool call costs about **7 tool-list builds,
21 MCP list requests and 4 system-prompt builds**.

A tool call also triggers these lookups:

- `invocationContext` runs about 6 times. Each time it reads and parses **every** Eve run file
  (`activeEveRuns`, `server/eve/state.ts:175-182`) and the full chat.
- `prepareOperation` reads **every operation file ever saved** to look for unchecked outcomes
  (`operationsForRun`, `server/eve/operations.ts:19-22, 38`). I found no code that deletes run or operation
  files, and an operation file can hold base64 images. So each new call gets slower the longer Eve has been used.

The prompt cache also breaks. The system prompt is rebuilt before each step and contains MEMORY.md and WORLD.md
(`server/memory.ts:148`, `server/voxel/tools.ts:723`). So `memory_add`, `world_md_section`, or the first
`world_build` in a project (which replaces the "no world yet" text) changes the start of the prompt in the
middle of a run. Every later step in that run then pays full price for the whole conversation instead of the
cached rate. The `memory_read` description already tells agents the opposite: that the instructions hold
MEMORY.md "as it was when this chat started".

### Every tool call does slow checks

- `callTool` checks permission with `toolsForAgent(agent).includes(tool)` (`server/tools.ts:1268`). That walks
  the agent's knowledge folders on disk (up to 2 000 files, a `stat` each) just to answer "is this group on?"
  (`server/knowledge.ts:54-73`). It runs on every call, every bridge tool list and every prompt build.
  Workflows run it too, and as a side effect create a `knowledge/_workflow` folder.
- `read_skill` re-reads the skill library several times:
  - `findSkill` lists the whole library before trying the exact slug (`server/skills.ts:670`);
  - `searchSkill` re-reads the skill once per file, so its cost grows with the square of the file count (`skills.ts:640-665`).
- `knowledge_search` reads every knowledge file again on each search, with no index (`server/knowledge.ts:116-144`).
- `search_conversations` parses each chat file twice (`server/conversations.ts:19-56`).
- The chat is saved to disk on every tool start and every tool result, with no debounce
  (`server/engines/index.ts:474, 484`). Text events already wait 1.5 s between saves. A run with 50 tool
  calls rewrites the whole chat file 100 times.

### Results have no shared size limit

Each tool has its own limit, and some have none:

- `read_file` returns up to 60 000 characters, about 16 000 tokens, with no way to read a part (`server/tools.ts:1063`).
- `fetch_url` lets the model choose any `max_chars`, and there is no way to continue reading where it stopped (`server/tools.ts:388`).
- `truncate()` always keeps the beginning (`server/util.ts:484`). Command output usually has its error at the
  end, and `run_command` (20 000 characters) cuts that part off.
- In Eve, nothing limits what goes back to the model, built-in or MCP (`server/eve/media.ts:33`,
  `runtime/eve/agent/lib/tool-output.ts`). Only the copy saved in the chat is cut, to 30 000 characters.
  One large MCP answer can fill the context window.

### Missing tools mean extra calls

Agents that use the dashboard's file tools (Eve, and any agent without a shell) have no way to:

- **edit part of a file**: changing one line means sending the whole file back with `write_file`, and output
  tokens are the slowest and most expensive kind;
- **search**: finding a function means `list_files`, then `read_file` on file after file;
- **read a range**, or several files in one call.

Delegation needs at least two calls (`ask_agent`, then `await_agent`), plus more polling while the helper
works. Fanning out to several helpers needs one `await_agent` call per handle (`server/tools.ts:957`).

### CLI engines get two sets of the same tools

Claude Code, Codex and pi keep their own Read, Write, Edit and Bash tools. Agents on these engines that have the
dashboard's `files` or `shell` groups also get `list_files`, `read_file`, `write_file` and `run_command` over the
bridge (`server/engines/claude.ts:158-159`, and `--allowedTools` only pre-approves, it doesn't hide).

- The model has to choose between two tools that do the same thing.
- It pays for both sets in tokens.
- For these engines the dashboard's folder limits don't protect anything: the native tools can already reach
  the whole disk, subject to the same approvals (`permission_prompt`).

### Bugs found along the way

- `run_command` always starts `powershell` (`server/tools.ts:1101`). It fails on macOS and Linux unless
  PowerShell is installed. `server/terminals.ts:84` already picks the right shell.
- The system prompt always says "running on their Windows PC" (`server/engines/index.ts:384`).
- `reddit_draft_post` reads a `note` argument that isn't in its schema, so models never send it (`server/tools.ts:891-892`).
- `x_recent_posts` and `x_mentions` accept any `limit`, and X bills each read.

## Measure first (phase 0)

Without a baseline we can't tell whether a change helped, and nothing stops the tool list from growing again.

1. **Size budget test** (`tests/server/tool-budget.test.ts`):
   - compute the characters per group the way the table above does;
   - fail when the core list, or any group, grows past its ceiling;
   - set the ceilings to today's numbers first, then lower them as each phase lands.
2. **Call-count tests for Eve.** Count `mcp.listTools`, `buildSystemPrompt` and run-file reads during one
   simulated step with one tool call (a spy, or a counter used only by tests). Counting is deterministic;
   timing isn't. These tests prove the phase 1 caching works and keeps working.
3. **Local tool stats.** Keep counts per tool in memory: calls, errors, refusals, time (p50/p95) and result size.
   Save them with `writeJSON` to `data/tool-stats.json` every few minutes. They never leave the machine. A
   real week of stats tells us which tools to fix next and which descriptions are never used. A Settings ›
   Tools view can come later.

## Phase 1: stop repeating work (faster, no visible change)

| #    | Change                                                                                                                                                                                                                                                                                                                                                                                          | Where                                            | Expected effect                                                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1  | Check permission by group: `core`, the agent's `toolGroups`, `memory` from `hasMemory`, and walk the knowledge folders only when the tool is in the `knowledge` group. Give `toolsForAgent` the same fast path for everything except the knowledge check.                                                                                                                                       | `server/tools.ts:1171-1177, 1268`                | No folder walk on ordinary calls. The `_workflow` knowledge folder is no longer created.                                                      |
| 1.2  | Cache the MCP tool list per server. Drop it when the server sends `notifications/tools/list_changed`, when it reconnects, or when its settings change, with a 5-minute safety expiry.                                                                                                                                                                                                           | `server/mcp.ts:1023`                             | One list request per server instead of one per lookup. Tool order stays the same between steps, which also keeps the provider's prompt cache. |
| 1.3  | Eve: build the configuration **once per run** and keep it in memory by run id. Rebuild the tool list only when it really changes: `request_tool` gives a group, or an MCP list changes. The cheap checks (the run is still active, the session owns the binding, the cost and step limits) still run on every call. `/limit` stops rebuilding the whole configuration just to read two numbers. | `server/eve/bridge.ts:32-56, 198`                | 4 prompt builds per step become 1 per run.                                                                                                    |
| 1.4  | Eve: freeze the system prompt for the whole run. Changes to MEMORY.md or WORLD.md show up in the next turn, as `memory_read` already promises. Tool results already tell the agent what changed.                                                                                                                                                                                                | same                                             | The prompt cache no longer breaks mid-run. On long runs this is likely the largest saving in money.                                           |
| 1.5  | Eve: `/policy` and `/tool` share one route lookup per call, using the cached list from 1.2/1.3. Only the access checks run again (the MCP account still belongs to the agent, the server is still on).                                                                                                                                                                                          | `bridge.ts:67, 114, 120`                         | 3 tool-list builds per call become 0.                                                                                                         |
| 1.6  | Eve: keep an in-memory index of active runs and their operations, since the coordinator owns them in this process. Read from disk only on startup and recovery. Save operations per run (`operations/<runId>/…`), so `prepareOperation` reads one run's files.                                                                                                                                  | `server/eve/state.ts:175`, `operations.ts:19-38` | Cost per call stops growing with history.                                                                                                     |
| 1.7  | Eve: clean up old receipts. Delete operation and admission files of runs that finished more than 30 days ago and whose results are already in the chat. Never touch `waiting`, `uncertain` or unchecked outcomes.                                                                                                                                                                               | `server/eve/`                                    | The folder stops growing forever. **Decision:** how long to keep them.                                                                        |
| 1.8  | Cache skill reads by folder and `mtime`. `findSkill` tries the exact slug before listing. `searchSkill` reads the skill once.                                                                                                                                                                                                                                                                   | `server/skills.ts:640-672`                       | `read_skill` reads each file once.                                                                                                            |
| 1.9  | Keep a list of knowledge files per agent, keyed by each file's path, `mtime` and size. Re-read only the files that changed when searching.                                                                                                                                                                                                                                                      | `server/knowledge.ts:54-144`                     | `knowledge_search` and prompt builds stop re-reading every file.                                                                              |
| 1.10 | `searchConversations` parses each chat once.                                                                                                                                                                                                                                                                                                                                                    | `server/conversations.ts:37`                     | Half the parsing work.                                                                                                                        |
| 1.11 | Wait up to 1 s before saving the chat after tool events, like text events do. Save at once when the run waits for an approval or a question, and when it ends. Use `findLast` instead of copying and reversing the item list.                                                                                                                                                                   | `server/engines/index.ts:470-485`                | Far fewer full-chat writes in busy runs. If the app crashes, what was there just before is lost; Eve's own receipts keep its outcomes anyway. |

Safety notes for this phase:

- Caches hold only things the agent could already see: tool lists, skill text, file lists.
- Permission inputs are read fresh at the moment of the call, as today: autonomy, "Always allow", tool groups,
  MCP servers, and whether a server is on.
- A cache entry includes everything it depends on (agent id, run id, project), so one project's or agent's
  entry is never served to another.

## Phase 2: send fewer tokens with every request

| #   | Change                                                                                                                                                                                                                                                                                 | Where                                                                 | Expected effect                                                                                      |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 2.1 | **Tools that depend on the conversation.** `toolsForAgent(agent, run)` offers the board tools only in a board task's own conversation, and the gateway file tools only in a gateway assignment. The list must stay the same for a whole conversation, so the prompt cache stays valid. | `server/tools.ts:226-276, 1171`, `apitools.ts`, `/api/internal/tools` | About 2 500 characters (≈700 tokens) less on every other request.                                    |
| 2.2 | **Shorter `request_tool`.** List only the groups the agent doesn't have yet, with their short labels. Move the long descriptions into the approval text, where the user and the Brain read them.                                                                                       | `server/tools.ts:309-321`                                             | About 1 800 characters less.                                                                         |
| 2.3 | **Say it once.** Cut the system-prompt paragraphs on Tasks, `set_goal` and search down to what the tool descriptions don't already say. That is one line about using the dashboard's task list instead of the CLI's own.                                                               | `server/engines/index.ts:379-381`                                     | About 1 200 characters less.                                                                         |
| 2.4 | **Compact results.** Remove the JSON indenting at the seven places listed above, or use one line per item where that reads better (X posts, Reddit listings). Approval details stay readable for people.                                                                               | `server/tools.ts:405-884`                                             | About 40% smaller results for those tools.                                                           |
| 2.5 | **Slimmer world tools.** Take `STEPS_HELP` out of `world_build` and point to `world_steps`. Shorten the descriptions of `world_script`, `world_animate` and `world_skin`. Say the WORLD.md advice in one place, not three.                                                             | `server/voxel/tools.ts`                                               | Group from about 6 900 toward about 4 000 tokens. Check with `voxel-tools.test.ts` and a real build. |
| 2.6 | **No duplicate tools on CLI engines.** Don't send the dashboard's `files` and `shell` tools to Claude Code, Codex or pi, which have their own. Eve keeps them.                                                                                                                         | `server/tools.ts:1171`, `index.ts:1303`                               | Less to choose from and fewer tokens. **Decision below.**                                            |
| 2.7 | Fix `run_command` off Windows: PowerShell on Windows, the user's `$SHELL` elsewhere. Describe the shell per platform. Fix "Windows PC" in the system prompt.                                                                                                                           | `server/tools.ts:1095-1104`, `index.ts:384`                           | `run_command` works on Mac and Linux.                                                                |

Not planned yet: `TaskCreate`/`TaskUpdate` could share one field list through `$defs`. It would save about 600
characters, but some OpenAI-compatible local servers handle `$ref` badly. These schemas also deliberately
follow Claude Code's published shape (`TASK_TOOLS_2026-11-01.md`). Revisit once phase 0 stats show whether
local models matter here.

## Phase 3: fewer calls per task

| #   | Tool                           | Change                                                                                                                                                                                                                                                                  | Risk                   |
| --- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 3.1 | `read_file`                    | `offset` and `limit` in lines. Says the total number of lines and where it stopped. `paths` reads up to 10 files in one call. Default cut at 2 000 lines or 40 000 characters.                                                                                          | none (unchanged)       |
| 3.2 | `edit_file` (new)              | Replace exact text in a file: one or more `{ old, new }` pairs, each of which must match exactly once unless `all` is set. Same folders as `write_file`. The approval shows the change as a diff.                                                                       | low, like `write_file` |
| 3.3 | `find_files` (new)             | Find files by name pattern (glob) inside the allowed folders. Skips links that point outside them, stops after 500 hits.                                                                                                                                                | none                   |
| 3.4 | `search_files` (new)           | Find lines that match words or a regular expression, with the file and line number. Same folder rules, with caps on files, bytes and time.                                                                                                                              | none                   |
| 3.5 | `list_files`                   | Optional `depth` and sizes. Says when the list was cut (today it silently stops at 500).                                                                                                                                                                                | none                   |
| 3.6 | `fetch_url`                    | Limit `max_chars` to 50 000. Add `offset` to continue. Keep each run's fetched page in memory, so continuing doesn't download it again. Turn HTML into Markdown (headings, lists, links), leaving out navigation and footers. Stop reading the body after a byte limit. | none (unchanged)       |
| 3.7 | `run_command`                  | Keep both the start and the end of long output. The exit code comes first. Limit `timeout_sec`.                                                                                                                                                                         | high (unchanged)       |
| 3.8 | `await_agent`                  | Accept several handles and return the first to finish (or all, with `all: true`). `ask_agent` can take `wait_seconds` for quick questions, so one call is enough.                                                                                                       | none                   |
| 3.9 | `x_recent_posts`, `x_mentions` | Limit `limit` to 50, because each read is billed. Add `note` to `reddit_draft_post`'s schema.                                                                                                                                                                           | none                   |

The new file tools are added to the `files` group, so no new switch is needed. `edit_file` and the new
arguments go into `README.md` and `docs/guide.md`.

Merging tools (`world_light` with `world_effect`, the three `world_md_*` tools) would save more, but saved
workflow steps call tools by name (`server/workflows.ts:143`). If we merge, the old names stay as hidden
aliases in `BY_NAME`: accepted when called, never shown to the model. Do this only after phase 0 shows how
often each one is used.

## Phase 4: one size limit for every result

- Add `clipResult(text, budget)` in `server/tools.ts`.
  - It keeps the start and the end, and says how much was left out in between.
  - It writes the full text to `outputs/tool-results/<run>/<call>.txt` and tells the agent where it is
    (to read with `read_file` and `offset`, when the agent has the files tools).
- Apply it in `callTool` to built-in tools, and in the Eve bridge to MCP results.
  - The default budget is 24 000 characters, configurable in Settings.
  - `TaskCreate` and `TaskUpdate` stay exempt, as decided in `TASK_TOOLS_2026-11-01.md`.
- The CLI engines already cut what they save in the chat (Codex and pi at 20 000, the chat at 30 000).
  The model still gets the bridge's full text, so the limit applies there too.
- Tests: a 1 MB MCP result in Eve reaches the model clipped, the full copy is on disk, and Task results are untouched.

## Phase 5, later: load tool groups only when needed

For agents with many groups (up to 17 500 tokens, plus MCP):

- The prompt names each switched-on group in one line.
- The full schemas are sent once the agent calls `use_tools("world")` for a group it already has. That needs no
  approval. It shares its code with `request_tool`, which stays the way to ask for groups the agent doesn't have.
- Eve supports this, because its tool list is resolved before every step.
- Each group costs one extra call and one prompt-cache break per conversation, so it only pays off for agents
  with several large groups.
- First check whether Claude Code's own MCP tool search already holds back the dashboard's tools on large
  lists. If it does, that engine only needs descriptions that are easy to search.

## Phase 6, needs a decision: fewer approval stops

The slowest part of many tool calls is waiting for a person.

- `ffmpeg` and `imagemagick` are always `high`, because they could overwrite any file.
- Their risk could depend on the arguments, the way `launch_program`'s already does (`server/tools.ts:345`):
  `low` when every path is inside the allowed folders and there are no URLs or protocol inputs (`http:`, `rtmp:`,
  `concat:`…), `high` otherwise.
- "Always allow" would then cover only the low form, as it already does for `launch_program` and `orca`.

This touches a security boundary ("New tools need an honest Risk"), so it needs its own review and tests that
try to get around it.

## Order and size

| Phase | Changes                                     | Size                                                  | Ships separately                            |
| ----- | ------------------------------------------- | ----------------------------------------------------- | ------------------------------------------- |
| 0     | Budget test, call counters, local stats     | small                                                 | yes, first                                  |
| 1     | Caching and fewer repeats (1.1–1.11)        | medium; most of the work is in Eve's bridge and state | yes, in 2–3 commits: tools/MCP, Eve, stores |
| 2     | Leaner lists and prompts, `run_command` fix | small to medium                                       | yes                                         |
| 3     | File, fetch and delegation tools            | medium                                                | yes, with README and guide updates          |
| 4     | Shared result limit                         | small                                                 | yes                                         |
| 5, 6  | Load on demand, argument-based risk         | medium each                                           | after the decisions below                   |

Every phase passes `bun run check` and the desktop smoke test (`scripts/desktop-smoke.ts` calls tools through the
bundled server). Tests go in `tests/server`, next to the existing ones: `file-tools`, `skills`, `knowledge`,
`conversation-search`, `tasks`, `voxel-tools`, `request-tool` and the Eve tests.

Target once phases 0–4 are done:

- the core list under 3 000 tokens, from 4 400;
- an Eve step with one tool call down to at most one tool-list build and no MCP list requests while
  nothing changed;
- no single result over the budget.

## Decisions

Made on 4 November 2026:

1. **Duplicate tools on CLI engines (2.6): yes.** Hide the dashboard's `files` and `shell` tools from
   Claude Code, Codex and pi. The Files and Shell switches then only change something for Eve agents, and their
   labels say so.
2. **How long Eve receipts are kept (1.7): 30 days** after the run ends.
3. **Merging world tools: yes, where a merge makes the tools easier to use.**
4. **Load on demand (phase 5) and argument-based risk (phase 6):** decided after phases 0–4, from the measurements.

## Noticed, outside this plan

Codex gets the internal token, and the env and headers of every stdio and HTTP MCP server, as `-c` arguments on
its command line (`server/engines/codex.ts:157-172`). Other programs on the machine can read command lines
(`ps`), so these values could leak. Passing them through the environment or a private config file would
avoid that. **Fixed** in the same branch: see Results.

## Results

Measured on 4 November 2026, with the tool lists as the model gets them (`tests/server/tool-budget.test.ts`).

### Sizes

| What the model gets                   | Before                                      | After                                                          |
| ------------------------------------- | ------------------------------------------- | -------------------------------------------------------------- |
| Core tools, which every agent carries | 19 tools, 15 969 characters (≈4 400 tokens) | 15 tools, 11 978 (≈3 300 tokens), 25% less                     |
| Voxel world group                     | 18 tools, 24 888                            | 17 tools, 15 476 (≈4 300 tokens), 38% less                     |
| `request_tool`                        | 2 596                                       | 1 103                                                          |
| Every group, Eve agent                | 91 tools, 62 931                            | 87 tools, 52 893, with three new file tools included           |
| Every group, Claude Code agent        | the same 62 931                             | 80 tools, 49 275 (its own file and shell tools aren't doubled) |

The core list stays above the 3 000-token target. Most of what is left is the Task tools' schemas, which follow
Claude Code's published shape: single-task fields plus a `tasks` list with the same fields. Sharing them through
`$defs` would save about 600 characters, but some local OpenAI-compatible servers handle `$ref` badly. The budget
test now fails when any group grows past its ceiling.

### Repeated work, for one Eve step with one tool call (21 saved runs, from `tests/server/eve-calls.test.ts`)

|                      | Before     | After                                                                             |
| -------------------- | ---------- | --------------------------------------------------------------------------------- |
| System-prompt builds | 4 per step | 1 per run                                                                         |
| Tool-list builds     | 7          | 6, now without MCP requests while nothing changed (lists are kept per connection) |
| Run-file reads       | 219        | 0                                                                                 |
| Operation-file reads | 26         | 0                                                                                 |

The instructions stay the same for a whole turn, so the prompt cache no longer breaks when MEMORY.md or WORLD.md
change mid-run. Eve receipts of runs that ended more than 30 days ago are removed when they can no longer be needed.
Still open: `/configuration` lists tools on all four calls of a step, because only the worker's tools resolver
needs them and changing that means changing the worker's protocol. With MCP lists kept, those calls are cheap.

### What changed, by item

- **Phase 0:**
  - the size budget test;
  - Eve call counts (`server/eve/counts.ts`, used by tests);
  - local tool stats: calls, errors, refusals, approvals asked, clipped results, p50/p95 time and result size, saved in `data/tool-stats.json`, readable at `GET /api/tool-stats`.
- **Phase 1:** all items, 1.1 to 1.11.
  - **Fixed along the way:** an old MCP connection closing after a settings change dropped the new one, which started a third server and left one running.
- **Phase 2:** all items.
  - The world merge (decision 3) put `world_script` into `world_build`, with `world_script` kept as an alias.
  - `world_light` with `world_effect`, and the three `world_md_*` tools, stay separate. Merging them would make the tools harder to use: different fields and limits, different risks, and the same shape as the `memory_*` tools.
- **Phase 3:** all items.
  - The new tools: `edit_file`, `find_files`, `search_files`.
  - Improved tools: `read_file` (in parts, several files), `list_files` (depth, sizes), `fetch_url` (Markdown, parts, kept ten minutes, 5 MB cap), `run_command` (the right shell on each platform, start and end of output), `await_agent` (several handles), `ask_agent` (`wait_seconds`).
  - Smaller fixes: X reads capped at 50, and `reddit_draft_post`'s `note` added to its schema.
- **Phase 4:**
  - Settings › Context › Longest tool result, 24 000 characters by default.
  - It applies to the MCP bridge and to Eve's built-in and MCP results.
  - Full results are kept for a week in `outputs/tool-results`.
- **Codex keys:**
  - The bridge reads its token from the data folder, so the token is never on Codex's command line.
  - With Codex 0.136 or later, MCP servers' env and headers go through `env_vars` and `env_http_headers`, hidden from the commands Codex runs (`shell_environment_policy.exclude`).

### Phases 5 and 6, decided from the measurements

- **Phase 5, loading groups on demand: not now.**
  - A typical Eve agent (Files, Browser, Delegate) now carries 27 tools and 18 294 characters (≈5 100 tokens), and most of that is core tools every agent needs.
  - World builders use their world tools on almost every step, so holding those back saves nothing.
  - Each group loaded later would cost an extra call and a prompt-cache break per conversation.
  - Revisit if the tool stats show agents with several large groups they rarely use.
- **Phase 6, judging ffmpeg and ImageMagick risk by their arguments: not yet.**
  - It weakens a security boundary, and nothing measured how often those approvals come up.
  - The tool stats now count the calls that waited for approval (`asked`).
  - Decide once they show these approvals are a real cost, with a security review and tests that try to get around it.
