# Code review — 2026-10-28

## Scope

Reviewed repository HEAD `aecc2100a1c838fb1d44a2c6fc3514fcdd872d41`, focusing first on security boundaries, project persistence, and agent execution. The working tree was clean when reviewed. No production source files were changed.

The initial nine findings were runtime-reproduced. Probes used temporary `DASH_DATA`, `HOME`, and `USERPROFILE` directories, dummy secrets, Windows directory junctions, and controlled local HTTP endpoints. No real model accounts or user data were used. Initial probe scripts and fixtures were removed afterward. Continued-review findings below state their own verification status.

P1 findings expose credentials, bypass file access limits, or can delete or overwrite files outside the intended project. P2 findings affect project isolation, tool access, or conversation and restore correctness.

The review ran in two passes. The first covered every application subsystem once; the second re-reviewed the whole project independently, discarding anything the first pass had already found. Findings 1–29 come from the first pass (plus the browser and probe work done alongside it); findings 30–77 are what survived the second pass. Four findings were reproduced in an isolated browser, seventeen through isolated runtime probes, and the rest are established from source with the verification limits stated inline. Nothing under `server/`, `web/`, `shared/`, `scripts/` or `src-tauri/` was changed.

## 1. [P1] Browser-only agents can read unrelated MCP credentials and the internal bridge token

**Location:** [server/index.ts:835–838](../../../server/index.ts#L835-L838)

**Related path:** [server/tools.ts:281–292](../../../server/tools.ts#L281-L292), [server/mcp.ts:1053–1057](../../../server/mcp.ts#L1053-L1057)

### Problem

`GET /api/mcp` returns credential-bearing saved server configuration and `bridgeServerConfig('')`. The approval-free `fetch_url` tool can request this endpoint through loopback regardless of the agent's Files permissions or assigned MCP servers. The server-side request has an allowed Host and no cross-site browser metadata.

### Reproduction and evidence

Create an agent with only `toolGroups: ['browser']`, `autonomy: 'ask'`, and no assigned MCP servers. Save a disabled, unrelated MCP server with a dummy authorization header. Call `fetch_url` on the dashboard's `/api/mcp` endpoint.

Observed:

```text
assignedServers: []
readDummyCredential: true
readInternalToken: true
isError: false
```

The internal token compared here belonged only to the isolated review server. This exposes unrelated account credentials to an agent that was not given access to those accounts.

### Recommended change

Prevent agent-originated HTTP fetching from reaching the dashboard/control plane, including redirects and alternate loopback addresses. Separately redact credential-bearing values from general listing responses and avoid exposing the internal token through them. Browser Origin/Fetch Metadata checks alone do not constrain a server-side caller.

## 2. [P1] Auto-save can delete files outside the project through a directory junction

**Location:** [server/projectsync.ts:210–218](../../../server/projectsync.ts#L210-L218)

**Related implementation:** [server/projectsync.ts:108–116](../../../server/projectsync.ts#L108-L116)

### Problem

The standalone `prune()` calls do not check destination links. When no skills are assigned, the preceding copy loop is empty and never checks `.dashboard/skills`. If that directory is a junction to an outside directory, pruning follows it and recursively removes its children. The versions prune has the analogous unchecked destination path.

### Reproduction and evidence

Create a temporary project with no assigned skills. Create a separate temporary directory containing `precious.txt`, and make `.dashboard/skills` a directory junction to it. Call `saveProject()`.

Observed:

```text
saveProject: success, agents: 0, teams: 0
externalFileSurvived: false
```

Opening an existing project folder can therefore make its subsequent auto-save delete files outside that project.

### Recommended change

Apply destination ancestry/link checks before every standalone prune, including versions and skill-versions. Do not rely on an earlier `copyTree()` call having visited and checked the destination.

## 3. [P1] An uploads junction expands agent file access outside its allowed folders

**Location:** [server/uploads.ts:30](../../../server/uploads.ts#L30)

**Related paths:** [server/uploads.ts:118–145](../../../server/uploads.ts#L118-L145), [server/tools.ts:113–126](../../../server/tools.ts#L113-L126)

### Problem

`uploadsRoot()` is automatically added to agent read roots without checking that its canonical location remains inside the project's Brain folder. Resolving an escaping junction adopts its destination as a trusted root. Attachment validation and upload removal use the same unanchored root.

### Reproduction and evidence

Make the project's `uploads` directory a junction to a separate temporary directory. Put a dummy private file there, outside the workspace and configured allowed folders. Exercise `read_file`, `cleanAttachments()`, and `removeUpload()` with that outside file.

Observed:

```text
read_file text: dummy-private-file
read_file isError: false
cleanAttachments: accepted the outside path
removeUpload: true
externalFileSurvived: false
```

The root mistake allows both unauthorized reads and upload operations on outside files.

### Recommended change

Validate the canonical upload directory against the canonical Brain directory before granting it root status or performing upload operations. Reject an escaping uploads link rather than trusting its resolved destination.

## 4. [P1] Opening a copied project folder can make agents overwrite the original project

**Location:** [server/projectsync.ts:278–283](../../../server/projectsync.ts#L278-L283)

**Related metadata:** [server/projectsync.ts:193](../../../server/projectsync.ts#L193)

### Problem

Folder restoration writes agent configuration verbatim, including absolute workspace and linked knowledge paths inside the original project. Unlike backup restoration, this path does not relocate them. Saved project metadata does not retain the original Brain path needed to distinguish project-local paths from genuinely external paths.

### Reproduction and evidence

Create project A with an agent whose explicit workspace and linked knowledge point at `A/notes/reference`. Save A and copy its entire Brain folder to B. Restore B from the copied `.dashboard` snapshot. In B, call `write_file` using the relative path `reference.md`.

Observed:

```text
restored workspace: A/notes/reference
expected workspace: B/notes/reference
originalContent: written from copied project
copyContent: original project note
```

The restored project can overwrite the original project's files and continue reading its knowledge rather than its own copied files.

### Recommended change

Persist the snapshot's original Brain path and rebase project-local workspaces and knowledge paths during restoration, including restored agent versions. Preserve genuinely external folders separately.

## 5. [P2] The MCP bridge ignores tools granted only by a team

**Locations:** [server/index.ts:1039–1042](../../../server/index.ts#L1039-L1042), [server/index.ts:1052–1059](../../../server/index.ts#L1052-L1059)

**Related caller:** [server/engines/index.ts:740–747](../../../server/engines/index.ts#L740-L747), [server/teams.ts:612](../../../server/teams.ts#L612)

### Problem

`askAgent()` adds team access to the effective run agent. The bridge's tool listing and tool execution instead reload the persisted agent through `agentFor()`. Dashboard tools granted only through team access are consequently missing or rejected for CLI agents using the bridge.

### Reproduction and evidence

Start a real active run with `askAgent(..., { extra: { toolGroups: ['files'] } })` for a saved agent that has no Files group. Hold its controlled local API-model response so the run stays active. Query and call the actual internal HTTP bridge endpoints with that run ID.

Observed:

```text
effectiveRunHasListFiles: true
bridgeListsListFiles: false
callStatus: 500
callBody.error: Team capability probe isn't allowed to use list_files. Turn on the "files" tools for it.
```

This probe exercised the bridge endpoints and effective-run discrepancy, not a live third-party CLI/model session.

### Recommended change

Retain the effective agent on the run and use it consistently for bridge listing and execution, while keeping the correct originating project, run signal, and approval context.

## 6. [P2] Switching between CLI and API engines loses conversation context

**Locations:** [server/engines/index.ts:338–351](../../../server/engines/index.ts#L338-L351), [server/engines/openai.ts:305–307](../../../server/engines/openai.ts#L305-L307)

### Problem

Session transition and reseeding logic only handles CLI engines. API runs initialize or reuse `chat.llm` without reconstructing messages written by another engine. A CLI-to-API transition omits prior history; returning to API after intervening CLI work reuses stale API history.

### Reproduction and evidence

Create a saved chat containing a previous CLI exchange that established project code `ORCHID`, with its CLI session metadata. Run the agent through the production API engine using a controlled local OpenAI-compatible SSE endpoint, and inspect the outgoing messages. Add an intervening CLI exchange changing the code to `CEDAR`, then return to API and inspect the next request.

Observed:

```text
CLI to API messages: system instructions, "What is the project code?"
Previous ORCHID exchange: still visible in saved chat, absent from outgoing messages
API to CLI to API messages: prior API question/answer, then latest question
Intervening CEDAR exchange: absent from outgoing messages
```

The probe validated actual outgoing request payloads; it did not depend on a real model's answer.

### Recommended change

Track conversation ownership across all engines and rebuild or seed engine memory on transitions. Respect explicit memory reset boundaries and avoid resuming stale CLI sessions after intervening API work.

## 7. [P2] Switching projects during a URL knowledge import writes into the wrong project

**Location:** [server/index.ts:429–433](../../../server/index.ts#L429-L433)

**Related write:** [server/knowledge.ts:64–67](../../../server/knowledge.ts#L64-L67)

### Problem

The route validates the agent in the current project, awaits the remote response, and then writes through dynamically project-scoped storage without pinning the initiating project. A project switch during the fetch redirects the write.

### Reproduction and evidence

Create A and B with the same agent ID, as a clone would have. Put an existing `note.md` in B's agent knowledge. Start A's URL knowledge import and hold the source HTTP response. Activate B, then release the response.

Observed:

```text
HTTP status: 200
returned file: data/projects/other/knowledge/<agent>/note.md
aReceivedFile: false
bContent: Source: <controlled local source URL>\n\nimport intended for A
```

A's import overwrote B's knowledge file instead of creating A's file.

### Recommended change

Capture the initiating project before the first await and pin the whole operation with `withProject()`, or pass an explicit project-scoped destination.

## 8. [P2] Backup restoration silently drops valid linked knowledge folders

**Location:** [server/backup.ts:766–767](../../../server/backup.ts#L766-L767)

**Related ordering:** [server/backup.ts:810–814](../../../server/backup.ts#L810-L814)

### Problem

`fixAgent()` rebases linked knowledge folders and immediately discards paths that do not exist. Brain files and nested notes directories are restored later, so a valid folder carried by the backup can be removed from agent configuration before restoration creates it. Agent versions use the same transformation.

### Reproduction and evidence

Give an agent a linked knowledge folder at `<original Brain>/notes/reference` containing a Markdown file. Encode the project backup and restore it into a fresh directory using the production backup functions.

Observed:

```text
knowledgeFolders: []
expectedFolder: <restored Brain>/notes/reference
restoredFileExists: true
```

Restoration succeeds and recreates the file, but loses the agent's association with its knowledge folder.

### Recommended change

Restore Brain files before testing rebased folder existence, or defer filtering project-local rebased paths until restoration has finished.

## 9. [P2] Project logo and model endpoints serve files through escaping links

**Locations:** [server/projects.ts:263–266](../../../server/projects.ts#L263-L266), [server/projects.ts:343–346](../../../server/projects.ts#L343-L346)

**HTTP consumers:** [server/index.ts:174–178](../../../server/index.ts#L174-L178), [server/index.ts:192–196](../../../server/index.ts#L192-L196)

### Problem

Media lookup checks only existence, and the HTTP handlers stream the resulting path without canonical containment checks. A linked file or directory can point outside the project's allowed roots. Response sandboxing and media extensions do not prevent disclosure of the bytes.

### Reproduction and evidence

Create outside `logo.png` and `brain-model.glb` fixtures containing private sentinel text rather than media. Make the project's `.dashboard` directory a junction to that outside directory. Request both project media endpoints from the actual isolated server.

Observed:

```text
logoStatus: 200
logoLeaksOutside: true
modelStatus: 200
modelLeaksOutside: true
```

### Recommended change

Require canonical containment beneath the real project media directory before opening either media stream. Reject escaping directory and file links; apply equivalent checks to media removal helpers.

## Baseline verification

Executed against the reviewed revision before any production changes:

- `bun install --frozen-lockfile`: succeeded; 402 packages installed. Bun reported one blocked postinstall, which was not enabled.
- `bun run check`: passed server and web typecheck and all 154 test files; 1,267 tests passed and 18 skipped.
- `bun run build`: passed.
- Runtime probes reproduced all nine findings as described above. Probe data, home folders, scripts, HTTP servers, and fixtures were isolated from real user state and removed or stopped afterward.

The passing test run emitted a non-failing happy-dom `NotSupportedError` about external `openui.css` loading being disabled. Passing baseline checks did not detect these defects.

## Continued review

The requested review now comprises a complete first pass across application subsystems followed by a second full-project pass. Coverage and verification limits will be recorded below. Vendored upstream skill instructions, Agency agent text, lockfile package contents, and generated assets are reviewed at their application integration boundaries rather than treated as independently authored application subsystems.

## 10. [P1] Cloned chats share live state with the original project

**Locations:** [server/engines/index.ts:194–198](../../../server/engines/index.ts#L194-L198), [server/index.ts:456–467](../../../server/index.ts#L456-L467)

### Problem

Cloning preserves chat IDs, but `liveChat()` and chat-busy detection identify chats globally by chat ID without project identity. A chat update in a cloned project can retrieve the original project's active chat, mutate it, and save its live contents into the clone. Independent runs in the two projects also falsely conflict.

### Reproduction and evidence

**Runtime-reproduced** through production `cloneProject()`, a held API-model run, and the real chat-update HTTP endpoint:

1. Clone A as B, preserving an existing chat.
2. In A, send a private message after cloning and hold the model response.
3. Open B. Attempt to start its copied chat, then clear its memory through the chat PUT endpoint.

Observed:

```text
B startError: This chat is already working on something. Stop it or wait.
B resetStatus: 200
B response contains A's post-clone private message: true
A live chat memory reset by B's request: true
```

### Recommended change

Scope live chats, compactions, busy checks, queues, steers, loops, stop/delete operations and their consumers by project plus chat ID. Project pinning alone does not disambiguate global in-memory lookups.

## 11. [P1] Stopping a cloned team stops the original project's work

**Locations:** [server/teams.ts:160–163](../../../server/teams.ts#L160-L163), [server/teams.ts:910–921](../../../server/teams.ts#L910-L921)

### Problem

Team runtime state is globally keyed only by team ID, and child runs use `team:<teamId>` as their parent identity. Cloning preserves team IDs. The two projects therefore share working/queue/stop state, and stopping the clone aborts the source team's active agents.

### Reproduction and evidence

**Runtime-reproduced** using production project cloning and team dispatch. Start A's team and hold its agent's local model response. Open B and inspect and stop its copied team.

```text
B working before Stop: [the source project's agent ID]
Source run aborted by B's Stop: true
```

### Recommended change

Namespace team runtimes, relay identities, timers and synthetic parent-run identities by project. Ensure callbacks resume under the same project-scoped runtime they started with.

## 12. [P1] An extrusion can block the server outside the script deadline

**Location:** [server/voxel/ops.ts:573–596](../../../server/voxel/ops.ts#L573-L596)

**Related boundary:** [server/voxel/script.ts:78–94](../../../server/voxel/script.ts#L78-L94)

### Problem

Extrusion polygon coordinates are finite but unbounded. With points `[[1e20,0],[1e20,1],[1e20,2]]`, the inner loop starts at an `x` for which `x + 1 === x`. The degenerate polygon continually fails `inPlan()`, bypassing voxel-write limits. This synchronous host operation also cannot be interrupted by QuickJS's guest-code deadline.

### Reproduction and evidence

**Runtime-reproduced** by calling production `runBuild()` in a disposable child with:

```javascript
{ extrude: { points: [[1e20, 0], [1e20, 1], [1e20, 2]] }, use: "stone" }
```

The child printed `entering runBuild extrude host operation`, never returned, and was terminated by an external five-second deadline. No dashboard process or real world was used. The QuickJS-host-callback consequence is source-established; that separate guest entry path was not executed.

### Recommended change

Validate coordinate and bounding-box ranges before iteration. Enforce host-operation iteration/work budgets independently of changed-voxel counts and QuickJS interrupts.

## 13. [P1] A malformed 32-byte VOX file loops forever during import

**Location:** [server/voxel/vox.ts:110](../../../server/voxel/vox.ts#L110)

### Problem

The parser validates chunk content length but not children length or forward progress. An unknown chunk with content length zero and children length `-12` leaves the next offset unchanged, looping synchronously forever. The normal file-size limit accepts this tiny input.

### Reproduction and evidence

**Runtime-reproduced** in an externally supervised disposable child. Construct a 32-byte file with a normal `VOX ` header/version, `MAIN` with 12 child bytes, and `JUNK` with zero content bytes and `-12` child bytes. All integer fields are little-endian.

The child printed `entering parseVox on 32-byte negative-child fixture`, never returned, and was terminated after five seconds.

### Recommended change

Validate signed child lengths and enclosing chunk boundaries, and require every iteration to advance within the input before processing the next chunk.

## 14. [P1] VOX scene expansion bypasses the import voxel limit

**Location:** [server/voxel/vox.ts:149–166](../../../server/voxel/vox.ts#L149-L166)

### Problem

The parser caps stored model voxels, but scene traversal expands duplicate group references into an accumulated array without a cumulative expansion or work budget. A depth-limited acyclic graph can still expand exponentially before world-size checks run.

### Reproduction and evidence

**Runtime-reproduced at bounded scale** with serialized VOX fixtures, each containing one stored voxel and a chain of groups referencing the next group twice:

| Group layers | File bytes | Stored voxels | Expanded voxels |
|---|---:|---:|---:|
| 8 | 352 | 1 | 256 |
| 12 | 480 | 1 | 4,096 |

The production parser and `voxVoxels()` produced these results. Larger memory-exhausting payloads were deliberately not run. Server exhaustion at larger depths is an inference from the source-proven unchecked exponential expansion.

### Recommended change

Apply cumulative expanded-voxel and traversal-work limits while traversing, before appending results. Cycle rejection alone does not bound duplicate references in an acyclic graph.

## 15. [P2] Undo loses grids that a build emptied

**Location:** [server/voxel/build.ts:538–541](../../../server/voxel/build.ts#L538-L541)

### Problem

Saving deliberately omits empty grids, but undo only restores chunks into grids still present in the current data. Clearing a complete grid removes it from disk; undo skips its saved chunks and then deletes the history entry.

### Reproduction and evidence

**Runtime-reproduced** in isolated world data: build `Shed` with one stone voxel, build it again with `{clear:true}`, then undo as the same builder.

```text
undoText: Undid: Builder A changed Shed.
restoredGridCount: 0
restoredVoxelCount: 0
```

### Recommended change

Recreate missing grids using the history entry's grid ID and voxel size before applying saved chunks. Keep the undo entry until restoration succeeds.

## 16. [P2] Invalid prefab pivots commit voxel changes before returning an error

**Location:** [server/voxel/build.ts:323–331](../../../server/voxel/build.ts#L323-L331)

### Problem

Prefab voxel data is persisted before `cleanPivot()` validates the request. A rejected pivot can leave changed data on disk with neither matching metadata nor an undo entry.

### Reproduction and evidence

**Runtime-reproduced**: create a one-voxel prefab, then submit `{clear:true}` with `pivot:"invalid"`.

```text
error: pivot is "bottom", "top", "center" or [x, y, z] in map units from the prefab's origin
dataChanged: true
historyBefore: 1
historyAfter: 1
persistedVolumeCount: 1
actualGridCount: 0
```

### Recommended change

Perform pivot and all other fallible request validation before persistent writes. Commit voxel data, metadata and history consistently.

## 17. [P2] Undoing prefab creation breaks another builder's placed copies

**Location:** [server/voxel/build.ts:525–528](../../../server/voxel/build.ts#L525-L528)

### Problem

Undo's dependency safeguards apply only to `prefabMade` (save-from-object operations), not ordinary prefab creation. Later placement changes a consuming object, so the target-history conflict check does not catch it. Undo deletes a prefab still referenced by another builder's objects or skins.

### Reproduction and evidence

**Runtime-reproduced**: A creates prefab `Post`, B places it in an object, then A undoes its last change.

```text
undoText: Undid: Builder A built the prefab Post.
prefabStillPresent: false
remainingInstancePrefab: the deleted prefab's ID
```

The probe verified the dangling reference on disk; no renderer was needed.

### Recommended change

Apply placed-copy and skin-reference checks whenever undo removes a newly created prefab, matching normal prefab-deletion safeguards.

## 18. [P2] Undo omits global material changes

**Location:** [server/voxel/build.ts:340–342](../../../server/voxel/build.ts#L340-L342)

### Problem

Material steps mutate the world's shared palette, but build history stores no palette before-images. Undo reports success without restoring the material, so every object sharing it remains changed. New materials also remain allocated.

### Reproduction and evidence

**Runtime-reproduced**: build an object using stone, make a material-only build setting stone to red, then undo.

```text
before: #7d7a74
after undo: #ff0000
undoText: Undid: Builder A changed Rock.
```

### Recommended change

Record and restore per-material before-images with conflict checks for later edits to the same material. Do not overwrite unrelated later palette changes with an entire stale palette snapshot.

## 19. [P1] Project switching leaves an old agent editor able to overwrite the clone

**Location:** [web/views/agents.tsx:280–288](../../../web/views/agents.tsx#L280-L288)

**Problem:** The load effect and retained editor form depend on route ID/version, not project identity. The top-bar project selector changes the active project without remounting this page. Saving A's retained form consequently updates B's matching agent ID, including its workspace, instructions and permissions.

**Browser-reproduced:** Open A's editor, change its name without saving, select cloned project B through the actual top-bar menu, and click Save. The visible project became `UI COPY`, but the form retained `Unsaved A edit`. B's agent API then returned that name and A's absolute `My workspace/agent-work` path instead of B's correctly rebased `ui-copy/agent-work` path. A screenshot confirmed the mismatched project/editor surface. Only isolated fixture data was changed.

**Recommended change:** Remount/invalidate project-scoped editors on project switches and bind mutation requests to the project that owns the form. Apply the same lifecycle rule to routine and workflow editors.

## 20. [P2] Editing MCP metadata corrupts argument boundaries

**Location:** [web/views/mcp.tsx:306–310](../../../web/views/mcp.tsx#L306-L310)

**Problem:** The form joins an argument array with spaces and splits it on whitespace on every Save. Existing arguments containing spaces are irreversibly split even when Arguments was never edited.

**Browser-reproduced:** A disabled fixture server initially had `args: ["C:/MCP Servers/server.js"]`. Open its real Edit dialog, change only Description, then save. The server API returned `args: ["C:/MCP", "Servers/server.js"]`. No MCP process was launched.

**Recommended change:** Use a lossless argument editor/serialization, or retain the original array when Arguments was not changed. Quoting alone does not work with the current whitespace split.

## 21. [P2] The Brain model picker offers unsupported engines and silently selects Claude

**Location:** [web/models.ts:193–203](../../../web/models.ts#L193-L203), [225–228](../../../web/models.ts#L225-L228)

**Problem:** `local: false` removes local API choices but leaves pi, oh-my-pi and OpenClaw tabs/favorites. Those engines are absent from `BRAIN_PROVIDER`; choosing them falls back to `provider: "claude"` while retaining their selected model string.

**Browser-reproduced:** Open Settings, The Brain's model, select the pi tab, then `pi's default model`. The real settings API returned `{provider:"claude", model:"", effort:""}`. The UI announced Claude Sonnet rather than pi. No model was invoked.

**Recommended change:** Filter tabs and favorites to the Brain's supported engines and reject unsupported choices instead of silently translating them.

## 22. [P2] Clicking Send bypasses slash-command dispatch

**Location:** [web/chat/ChatView.tsx:695](../../../web/chat/ChatView.tsx#L695)

**Problem:** Enter invokes `submit()`, but Send invokes `send()` directly. Dashboard commands become ordinary model messages; a busy `/queue` message can steer and stop the existing turn instead of queuing.

**Browser-reproduced with network effects blocked:** Type `/goal finish the isolated review fixture` in the actual full-chat composer. Clicking Send attempted POST `/stream` with the literal `/goal ...` text. Pressing Enter with identical input attempted POST `/goal` with only the goal text. Both requests were intercepted and answered locally before any model operation.

**Recommended change:** Route the composer Send button through `submit()`. Keep explicit Rich-answer continuation sends separate.

## 23. [P1] Trailing whitespace bypasses interpreter approval

**Location:** [server/tools.ts:248](../../../server/tools.ts#L248), [server/programs.ts:651–674](../../../server/programs.ts#L651-L674)

**Problem:** Risk classification checks the untrimmed program name; execution trims it. An absolute `node.exe ` target with trailing whitespace avoids the interpreter regex and is classified low-risk, then runs as Node with its file argument.

**Runtime-reproduced:** An Auto-autonomy Programs-only fixture agent called `launch_program` with the resolved Node path plus a trailing space and a `.txt` script. The inert script wrote only a temporary sentinel. Result: `Started node.exe.`, sentinel `inert controlled script executed`, and `pendingApprovals: 0`.

**Recommended change:** Normalize and resolve the executable once, then classify and execute that same target. Do not independently interpret the input on the approval and execution paths.

## 24. [P1] Note writes follow escaping project links

**Location:** [server/projects.ts:178–181](../../../server/projects.ts#L178-L181)

**Problem:** Sanitizing the note filename does not constrain its canonical destination. A project-supplied `notes` junction redirects `addNote()` outside the Brain folder; a final-file symlink presents the same source-level risk.

**Runtime-reproduced:** Junction the isolated project's `notes` directory to an outside fixture containing `precious.md`, then call the production note function. Its outside contents became `overwritten by note`.

**Recommended change:** Validate directory ancestry and the final destination against the canonical Brain root before opening the file. Reject escaping links.

## 25. [P1] Asset extraction follows links already present at the destination

**Location:** [server/unzip.ts:73–75](../../../server/unzip.ts#L73-L75)

**Related consumers:** [server/tools.ts:585–588](../../../server/tools.ts#L585-L588), [server/assets.ts:178–190](../../../server/assets.ts#L178-L190)

**Problem:** ZIP entry-name checks reject lexical traversal and archive-supplied symlinks, but not links already in the destination. Asset downloads also append the asset ID after authorizing only its parent directory. Normal entries can therefore overwrite outside files through a destination junction.

**Runtime-reproduced without network:** Extract a valid stored ZIP containing only `maps/color.jpg` into a temporary asset directory whose `maps` is an outside junction. The outside sentinel became `outside changed by zip`. The analogous direct-download destination path is source-established, not separately network-exercised.

**Recommended change:** Authorize the appended asset directory and every actual write destination against the original roots, including existing directory and final-file links.

## 26. [P2] Lookalike-domain links grant GitHub installation authorization

**Location:** [server/skillinstall.ts:209–211](../../../server/skillinstall.ts#L209-L211)

**Problem:** `reposIn()` searches for a hostname substring rather than validating URL hosts. Under the default user-link-only policy, text containing `https://notgithub.com/attacker/skills` grants authorization to the real GitHub repository `attacker/skills`. The installer validates the proposed URL, but the authorization source is already wrong.

**Runtime-reproduced at the authorization parser:** `reposIn("Inspect https://notgithub.com/attacker/skills")` returned `["attacker/skills"]`. No installation, live model, or external request was executed; the subsequent permission comparison is source-established.

**Recommended change:** Extract URL candidates and validate their complete hostnames using the existing approved GitHub URL rules before granting repository authorization.

## 27. [P2] Legacy team presets lose all members

**Location:** [server/presets.ts:72–74](../../../server/presets.ts#L72-L74)

**Problem:** Legacy step-list teams derive membership through `teams.normalize()`. Saving a preset reads the raw workflow record and uses its absent `members` field, saving no agents and no lead.

**Runtime-reproduced:** Save a supported legacy team with two agent steps but no explicit members. `getTeam()` reported two members; `saveTeamPreset()` recorded zero.

**Recommended change:** Use the normalized team getter when collecting preset members and resolving the lead, as the existing clone path does.

## 28. [P2] Backup restore overwrites a user-edited BRAIN.md

**Location:** [server/backup.ts:960–963](../../../server/backup.ts#L960-L963)

**Problem:** A file under 600 characters containing the generated template's identifying sentence is treated as newly generated and disposable. An existing user-edited template meets that heuristic even though the restore did not create it.

**Runtime-reproduced:** Restore into an unregistered existing directory whose BRAIN.md contained the template sentence and `User edited sentinel.`. The operation replaced the entire file with `Backup BRAIN content`, despite the restore contract preserving existing files.

**Recommended change:** Track whether this particular restore created BRAIN.md and allow replacement only in that case. Do not infer file ownership from content and length.

## 29. [P2] Invalid replacement skill names clear valid assignments

**Location:** [server/overseer.ts:1441–1455](../../../server/overseer.ts#L1441-L1455)

**Problem:** `set_skills` records unresolved names as errors but still replaces the holder's list with the resolved subset. An entirely invalid list therefore clears all current skills while reporting an error.

**Runtime-reproduced:** Give an agent one valid skill, then apply `set_skills` with `does-not-exist-fixture`. The dispatcher returned both `no skill` and a successful removal message; the saved agent had `skills: []`.

**Recommended change:** Refuse replacement when any name is unresolved, before changing any holder. Keep an explicitly empty list valid for intentional clearing, matching the all-or-nothing MCP replacement convention.

## Second pass (independent, whole project)

After the first pass covered every application subsystem, the entire project was re-reviewed by independent lanes that inspected the implementation before reading this report. Findings 1–29 were excluded as duplicates. Entries below are **source-established** unless marked otherwise; no lane executed builds, tests, model CLIs, credentials or external network calls. The first-pass probes and the isolated browser session described above already confirmed findings 1–30's neighbours; nothing here is presented as executed evidence unless it says so.

### Project isolation and asynchronous pinning

The dominant theme of both passes: work that outlives an `await` re-reads the *currently open* project instead of the project that started it. Each of these is a separate entry point, so each needs its own correction (pinning at one call site does not fix the others).

- **30. [P1] A fresh desktop-style profile auto-saves over the shared default Brain folder.** [src-tauri/src/main.rs:220–224](../../../src-tauri/src/main.rs#L220-L224), [server/store.ts:121–128](../../../server/store.ts#L121-L128), [server/projectsync.ts:210–218,459–468,536–538](../../../server/projectsync.ts#L210-L218). The desktop app keeps its own `DASH_DATA`, but its default project points at the same `HOME/Documents/Blacksite/My workspace` the browser build uses. A first launch therefore auto-saves an empty project over that folder's snapshot and prunes its saved skills and world.
  **Runtime-reproduced:** with an isolated HOME containing a saved agent, a saved skill and a saved world, an initially empty `DASH_DATA`, and stdin held open past the startup save. Result: `{"savedAgents":0,"skillSurvived":false,"worldSurvived":false}`. (A first attempt exited early because `DASH_DESKTOP=1` treats closed stdin as "quit"; the desktop app and the smoke script both hold stdin open.) The same risk exists for `scripts/desktop-smoke.ts:36–46`, which isolates `DASH_DATA` but inherits the real HOME.
  **Recommended change:** restore an existing default folder before letting a fresh profile save into it, or give the desktop profile its own default folder, and point the smoke harness at a temporary HOME.
- **31. [P2] Manual compaction is not pinned to its project.** [server/engines/index.ts:765–786](../../../server/engines/index.ts#L765-L786). `compactNow()` loads the chat, then awaits context-window lookup and possibly a summary; `chats.save()` resolves through the project open at that moment, so a switch mid-compaction writes A's chat into B.
- **32. [P2] A waiting steer is not pinned to its project.** [server/engines/index.ts:455–483](../../../server/engines/index.ts#L455-L483). `steerNow()` awaits the stopped run before choosing the replacement run and chat; both the timeout (`queueFirst`) and the replacement path resolve in the newly active project.
- **33. [P2] Team routing, delegation and goals are not pinned across async selection.** [server/teams.ts:231–282](../../../server/teams.ts#L231-L282), [server/irc.ts:52–54,267–268](../../../server/irc.ts#L52-L54). When nobody is named, `postAndRoute()` awaits `pickMember()`; `enqueue()`/`pump()` then resume against the active project. With an unrelated project the queue item is silently dropped after the message was already accepted; with a clone it dispatches B's agents. `sendBrief()` and the idle-team goal path have the same post-then-write boundary.
- **34. [P2] Outbox publication is not pinned to its project.** [server/social.ts:415–457,475–478](../../../server/social.ts#L415-L457). `approvePost()` marks the item, awaits X/Reddit/Telegram/Discord, and then saves through the project-scoped Outbox. A switch mid-publish leaves A's item stuck at `posting` while the completion lands in B; approving again in A can republish content already sent.
- **35. [P2] Handoff ownership is keyed by agent id only.** [server/handoffs.ts:68–71,95–100](../../../server/handoffs.ts#L68-L71). The handoff map is process-global and matched on `from: agent.id`. Cloned or restored projects share agent ids, so an agent in B can list A's handles and read A's finished answers.
- **36. [P2] Two answers can be delivered to one question.** [server/questions.ts:119–148](../../../server/questions.ts#L119-L148). The waiting-status check precedes an unconditional dynamic import and the question is only claimed after delivery, so two concurrent answers (Outbox card, chat card, second tab) both proceed; a dismissal during that window can also be overwritten by the stale save.
- **37. [P2] A late team answer mentions the pre-rename agent name.** [server/questions.ts:135](../../../server/questions.ts#L135). The stored `agentName` is mentioned even after the agent has been renamed, so `parseMentions()` no longer resolves it and the answer falls to the lead or first member.
- **38. [P2] Stopping a team does not invalidate a review already in flight.** [server/irc.ts:142–167](../../../server/irc.ts#L142-L167). `teamIdle()` returns at `checking.has(brief.id)` before recording the stop; the pending `reviewWork()` verdict then posts a follow-up that resets the team's stopped state and starts new work.
- **39. [P2] Clearing the Brain conversation does not stop prepared actions.** [server/overseer.ts:1827–1866](../../../server/overseer.ts#L1827-L1866). The conversation generation is checked before asynchronous model/skill preparation but not after it; the final `remember()` is unconditional, so a clear during preparation is undone and its actions still apply.

### Filesystem and trust boundaries

- **40. [P1] Knowledge files follow file links out of an allowed folder.** [server/knowledge.ts:43–62,88–103](../../../server/knowledge.ts#L43-L62), [server/util.ts:186–191](../../../server/util.ts#L186-L191). `knowledgeFiles()` accepts anything matching the text-extension filter without requiring a plain file, so a `reference.md` symlink inside an assigned knowledge folder is read straight into the agent's instructions and exposed to `knowledge_read`/`knowledge_search`. **Note:** our environment refused non-administrator file symlinks (`EPERM`), so this stayed source-established; the read path is nonetheless unambiguous.
- **41. [P1] `PROJECT.md` writes follow a link out of the project.** [server/overseer.ts:1566–1578](../../../server/overseer.ts#L1566-L1578). The Brain action checks no containment before copying the existing file into `.brain-history` and writing it, so a linked `PROJECT.md` both leaks the outside file into the project and then truncates it.
- **42. [P1] Importing a Claude skill preserves a linked `SKILL.md`.** [server/skills.ts:84–90,566–572](../../../server/skills.ts#L84-L90). `fs.cpSync` copies the folder without rejecting links, and `readDir()` then reads `SKILL.md` directly (no anchor check, unlike extra files). The skill body becomes the outside file, and later saves/restores write through the retained link.
- **43. [P1] Imported team attachments bypass upload authorization.** [server/projectsync.ts:282–285](../../../server/projectsync.ts#L282-L285), [server/uploads.ts:239–250](../../../server/uploads.ts#L239-L250), [server/teams.ts:595–611](../../../server/teams.ts#L595-L611). Restored folder/backup teams keep their `files` verbatim, and `runTurn()` forwards them to `askAgent()`, which reads attached text files directly. A crafted saved project can put an outside path in a team's reference files and have its contents reach the model without Files tools. Normal routes sanitize through `cleanAttachments()`; restored state does not.
- **44. [P2] API-model MCP calls are always classified low risk.** [server/engines/openai.ts:424–427](../../../server/engines/openai.ts#L424-L427), [server/tools.ts:1036–1047](../../../server/tools.ts#L1036-L1047). Every MCP invocation passes the literal `'low'` to `gate()`, so under the default Auto autonomy a send/delete/exec-style tool needs no approval — contradicting the promise that Auto asks before risky work.
- **45. [P2] Disabled MCP servers stay usable by API-model agents.** [server/mcp.ts:927–936](../../../server/mcp.ts#L927-L936), [server/engines/openai.ts:163–178](../../../server/engines/openai.ts#L163-L178). Tool gathering iterates assigned names without filtering `enabled: false`, and `connect()` does not check the flag either, so a server the user turned off is still started and exposed. The Claude path (`claudeMcpConfig`) does filter it.
- **46. [P2] Slicer settings can bypass the validated profile paths.** [server/dcc.ts:87–94](../../../server/dcc.ts#L87-L94), [server/tools.ts:539–541](../../../server/tools.ts#L539-L541). `slice_model` validates each `profiles[]` entry with `readablePath()`, but a free-form `settings.load` emits the same `--load <path>` option unchecked.
- **47. [P2] Stopping a queued ComfyUI job interrupts a different job.** [server/comfyui.ts:283–290](../../../server/comfyui.ts#L283-L290). Cancellation deletes the caller's prompt id and then sends the service-wide `/interrupt` unconditionally, aborting whatever is running.
- **48. [P1] A native prefab graph can expand without a work budget.** [server/voxel/build.ts:190–199,299–303,335](../../../server/voxel/build.ts#L190-L199), [web/voxel/instances.ts:64–81](../../../web/voxel/instances.ts#L64-L81). `prefabBox()` re-evaluates every child for every instance, and the build limits cap stored copies and nesting depth but not expanded copies. Leaves at branching factor 2,000 across three wrapper levels pass validation and turn a bounds calculation into billions of synchronous leaf evaluations; browser expansion and GLB export expand the same accepted graph. Related to finding 14, but reachable without any VOX import.

### Voxel world correctness

- **49. [P2] `stamp` copies prefab references without the placement checks.** [server/voxel/ops.ts:764–781](../../../server/voxel/ops.ts#L764-L781). `place` consults `cantPlace`; `stamp` copies nested instances through `addInstance()` instead, persisting self-references and over-deep nesting that ordinary placement rejects.
- **50. [P2] A WORLD.md section edit satisfies the full-document freshness check.** [server/voxel/tools.ts:624–643](../../../server/voxel/tools.ts#L624-L643). The section tool advances `mdRead` to the newest document timestamp while returning only a character count, so an agent that never read the merged document can overwrite another builder's unseen changes with `world_md_write`.
- **51. [P2] Dressed skins miss nested-prefab and material-detail changes.** [web/voxel/skins.ts:223–234](../../../web/voxel/skins.ts#L223-L234). The fingerprint covers only directly named prefab versions and a reduced set of palette fields; editing a nested part, a `ramp`, or `jitter` leaves the existing rig/meshes in place, while ordinary objects redraw correctly.
- **52. [P2] GLB export drops inherited material swaps.** [server/voxel/gltf.ts:119–130](../../../server/voxel/gltf.ts#L119-L130), [web/voxel/instances.ts:48–53,75–77](../../../web/voxel/instances.ts#L48-L53). The renderer composes a parent's `swap` with the child's; the exporter recurses without carrying it, so a recoloured assembly exports in its original colours (and different recolourings share one cached mesh).
- **53. [P2] Saving an object as a prefab can exceed the world voxel budget.** [server/voxel/prefabs.ts:124–137](../../../server/voxel/prefabs.ts#L124-L137). `savePrefabFrom()` checks the per-prefab limit but not the resulting world total, and with `replace:false` it duplicates the object's voxels. At the world limit this succeeds where `build()` and library import refuse.
- **54. [P2] A prefab-only VOX import does not mark the world built.** [server/voxel/exchange.ts:69–72](../../../server/voxel/exchange.ts#L69-L72), [server/voxel/store.ts:70–78](../../../server/voxel/store.ts#L70-L78). `built` is inferred from objects, so importing a `.vox` only as a prefab leaves the world "unbuilt" — once another project has a built world, the imported one is hidden behind carry-over.
- **55. [P2] The documented top-level `wall` field is ignored.** [server/voxel/ops.ts:561–566](../../../server/voxel/ops.ts#L561-L566), [server/voxel/tools.ts:41,54](../../../server/voxel/tools.ts#L41). Help text advertises `wall` beside `height`, but extrusion reads only `extrude.wall`, and map-unit conversion converts only the nested field. The existing map/voxels test passes `wall` at the top level on both sides, so it cannot detect this.
- **56. [P2] `world_look` can answer before a scheduled refresh lands.** [web/voxel/worldlayer.ts:488–535](../../../web/voxel/worldlayer.ts#L488-L535). `refresh()` debounces loading by 120 ms while `look()` inspects the current `placed` map immediately, so a freshly built object can be reported missing — or photographed at its previous geometry — defeating the build-then-inspect workflow.
- **57. [P2] Whole-world snapshots ignore skin bounds.** [web/voxel/worldlayer.ts:464–483](../../../web/voxel/worldlayer.ts#L464-L483). Target-specific captures add `skins.boundsOf()`; the whole-world branch fits only placed objects and classic anchors, so a large or offset character, Brain shell or team platform can be cropped out.
- **58. [P2] Undressing never happens when the selected world disappears.** [web/voxel/worldlayer.ts:339–343](../../../web/voxel/worldlayer.ts#L339-L343). The no-world branch clears objects but returns before updating the captured world or syncing skins, leaving the previous world's skins attached (and its hides/replacements in force) after its world is deleted.
- **59. [P2] The postprocessing `OutputPass` is never disposed.** [web/voxel/post.ts:145–151](../../../web/voxel/post.ts#L145-L151), [web/voxel/view.ts:393–402](../../../web/voxel/view.ts#L393-L402). It is allocated inline with no reference kept; the teardown disposes the other passes and the composer, but Three.js' `composer.dispose()` does not dispose pass entries, so each teardown leaks its material.

### Conversation and browser state

- **60. [P2] Stopped Brain payloads survive a project or conversation reset.** [web/dock.tsx:249–252](../../../web/dock.tsx#L249-L252), [1055–1087](../../../web/dock.tsx#L1055-L1087). `projectChanged()`/`newConversation()` clear the transcript, queue and loop but keep `stoppedAsk`/`stoppedWork`, so a later `/resume` replays the previous project's request into the new one.
- **61. [P2] Late agent/team design responses mutate the replacement conversation.** [web/dock.tsx:1186–1198](../../../web/dock.tsx#L1186-L1198). The completions splice their loading note out of whatever transcript is current; after a reset `indexOf` is `-1`, so they remove the newest item of the new conversation and insert the stale draft (or open the old team builder).
- **62. [P2] Question cards match by text alone.** [web/questions.tsx:25–28](../../../web/questions.tsx#L25-L28), [web/chat/parts.tsx:107–111](../../../web/chat/parts.tsx#L107-L111). Two agents asking the same question resolve to the newest one, so answering under the first agent's tool card answers the second agent's question.
- **63. [P2] A Rich continuation discards staged attachments.** [web/chat/ChatView.tsx:279,307](../../../web/chat/ChatView.tsx#L279-L307). Rich actions call `send(t)`, which sends no attachments but still takes everything off the attach tray, so an uploaded file staged for the next message disappears silently.
- **64. [P2] Dock agent cards render Rich actions they cannot send.** [web/dock.tsx:478](../../../web/dock.tsx#L478), [web/chat/TurnView.tsx:68](../../../web/chat/TurnView.tsx#L68). `TurnView` is mounted without `onSend`, so continuation buttons look live and do nothing. Direct dock-to-agent runs are eligible for Rich answers.
- **65. [P2] `/resume` in the dock does not restart turn following.** [web/dock.tsx:1062–1063](../../../web/dock.tsx#L1062-L1063), [web/chat/TurnView.tsx:36–61](../../../web/chat/TurnView.tsx#L36-L61). The resumed run reuses the same mounted turn view, whose subscription and chat load run only once, so the displayed answer stays the stopped one.
- **66. [P2] A team chat is not reconciled after the event socket reconnects.** [web/teamchat.tsx:175–181](../../../web/teamchat.tsx#L175-L181), [web/core.ts:78–79](../../../web/core.ts#L78-L79). Reconnection refreshes `/state` only; the server replays no events, so replies and state changes missed while disconnected never appear.
- **67. [P2] Rich continuation context is dropped.** [web/chat/rich.tsx:44–47](../../../web/chat/rich.tsx#L44-L47). `actionMessage()` serializes the label and form state but not `event.params.context`, so buttons sharing a generic label send indistinguishable messages and lose the selected payload.
- **68. [P2] Outbox textareas are sized from the wrong array.** [web/views/outbox.tsx:235](../../../web/views/outbox.tsx#L235). `rows` is computed from `p.parts[i]` while rendering the local `parts`, which can be longer after a failed approval trims the server copy — an `undefined.length` throws and empties the Outbox page.

### Storage, versions and presets

- **69. [P2] An imported preset can overwrite an existing agent.** [server/presets.ts:99–104](../../../server/presets.ts#L99-L104), [server/library.ts:105–136](../../../server/library.ts#L105-L136), [server/backup.ts:552,831–843](../../../server/backup.ts#L552). Imported preset templates are not stripped of runtime fields and `usePreset()` spreads them into `newAgent()`, which honours a supplied `id`. Applying such a preset after switching projects replaces the agent that already has that id; locally created presets are sanitized, imported ones are not.
- **70. [P2] Restoring the oldest retained skill version deletes the files it is about to restore.** [server/skills.ts:239–255](../../../server/skills.ts#L239-L255), [server/versions.ts:116–126](../../../server/versions.ts#L116-L126). `restoreSkill()` first records the current state, and `keepVersion()` immediately prunes to 50 versions — removing the selected oldest version and its `files-<id>` directory before the copy. The restore then reports success with the old instructions and none of the old scripts.
- **71. [P2] `trimHistory()` can drop the newest user message entirely.** [server/engines/openai.ts:462–471](../../../server/engines/openai.ts#L462-L471). When one message exceeds the character budget the cut advances past it and then finds no later user message, returning `[]`. The engine then sends only its system prompt, and automatic compaction has nothing older to compact. The 25 MiB body limit makes this reachable from the chat box.
- **72. [P2] A failed Codex turn is reported as success if it printed anything.** [server/engines/codex.ts:151–186,227–231](../../../server/engines/codex.ts#L151-L186). `turn.failed` is recorded, but the failure (and the non-zero exit) is only raised when `answer` is empty. Commentary emitted before the failure — "I'll inspect the files" — therefore becomes the run's answer, is emitted as `done`, and satisfies a workflow's agent step.
- **73. [P1] Rebuilding the page deletes bundle chunks that open tabs still need.** [scripts/build-web.ts:50–52](../../../scripts/build-web.ts#L50-L52). Each successful rebuild removes the whole previous output directory, including content-hashed chunks that `bun run dev` reloads and that already-loaded tabs reference lazily (chat, voxel). A tab that has not yet opened an agent chat requests a deleted chunk after the rebuild and the import fails until it is refreshed.
- **74. [P2] Test isolation does not cover pi's configuration directory.** [tests/server/setup.ts:13–19](../../../tests/server/setup.ts#L13-L19), [server/engines/pi.ts:288–320](../../../server/engines/pi.ts#L288-L320). The setup replaces HOME/USERPROFILE but keeps an inherited `PI_CODING_AGENT_DIR`, which production code prefers. The pi engine tests call the real bridge installer, so a suite run from an environment with that variable set can write the developer's real `mcp.json`.
- **75. [P2] Server shutdown does not stop active agent subprocesses.** [server/index.ts:1375–1386](../../../server/index.ts#L1375-L1386), [src-tauri/src/main.rs:309–326](../../../src-tauri/src/main.rs#L309-L326). The stdin shutdown path closes terminal sessions and exits; chat engine children are killed only when their run's abort signal fires, and no shutdown handler aborts runs. Quitting the desktop app or installing an update can leave a CLI agent (and any command it started) writing into the project after the dashboard is gone.
- **76. [P2] The desktop resolves a relative `DASH_DATA` twice.** [src-tauri/src/main.rs:220–243](../../../src-tauri/src/main.rs#L220-L243). A relative override is used as both the child's working directory and its `DASH_DATA`, which the server then resolves against that new directory. `DASH_DATA=state` creates `state/` but stores data in `state/state/`, so the existing data appears to be missing.
- **77. [P2] Desktop restart requests are not serialized.** [src-tauri/src/main.rs:123–128,190–208,309–316](../../../src-tauri/src/main.rs#L123-L128). Each navigation to the restart URL starts its own thread while only the `Child` slot is locked; an overtaken attempt can spawn a second server on the same port and overwrite the tracked child, leaving the app with no server.

## Coverage and verification

**Subsystems reviewed in full (first pass, second pass).** Server: `index`, `store`, `util`, `tools`, `mcp`, `mcp-bridge`, `engines/*` (all eight), `teams`, `workflows`, `routines`, `commands`, `handoffs`, `compaction`, `uistream`, `toolimages`, `richanswers`, `promptcache`, `models`, `status`, `codexlimits`, `brain`, `overseer`, `irc`, `learning`, `approvals`, `questions`, `briefs`, `projects`, `projectsync`, `backup`, `history`, `versions`, `memory`, `knowledge`, `files`, `uploads`, `teammark`, `artifacts`, `presets`, `about`, `skills`, `skillinstall`, `unzip`, `library`, `social`, `reddit`, `services`, `programs`, `comfyui`, `assets`, `dcc`, `terminals`, and all 19 `voxel/*` modules. Web: `app`, `core`, all `client/*`, `ui/*`, `styles/*`, all `views/*`, all `chat/*`, `dock`, `agentchat`, `chatwin`, `teamchat`, `brainqueue`, `chatcommands`, `queuedlist`, `questions`, `pastes`, `attach`, `mentions`, `routinemention`, `compactmark`, the 24 management modules, and all `web/voxel/*`. Also `shared/*` (15 modules), `scripts/*` (11 scripts), `src-tauri/src/*`, both workflows, `package.json`, the TypeScript configs, `vitest.config.ts`, the test setup, `start.cmd` and `install-shortcut.ps1`, plus `public/index.html` and the bundled skill/library provenance READMEs.

**Not treated as application code:** vendored upstream skill instructions and Agency agent bodies (reviewed at their integration, discovery and packaging boundaries), third-party package internals beyond the specific Tauri updater, OpenUI and Three.js contracts cited above, generated assets, and images.

**Executed against revision `aecc2100a1c838fb1d44a2c6fc3514fcdd872d41`** (later commits touch only this report):

- `bun install --frozen-lockfile` — succeeded (402 packages; one postinstall blocked and left disabled).
- `bun run check` — typecheck plus **154 test files, 1,267 passed, 18 skipped**.
- `bun run build` — passed.
- Isolated runtime probes (temporary `DASH_DATA`, `HOME`, `USERPROFILE`, `PI_CODING_AGENT_DIR`, dummy secrets, local HTTP endpoints, Windows junctions, externally bounded child processes) reproduced findings 10–18, 23–30.
- An isolated headless-Chromium session against a throwaway server reproduced findings 19–22 (stale cross-project editor save, MCP argument splitting, Brain engine fallback, Send-button command bypass). One MCP call was intercepted and answered locally; no message, post or model call left the machine.
- Nothing else was executed: no real model CLI runs, no credentialed provider, no account or social action, no creative app, no installer, no Rust build, no macOS/Linux run, and no unbounded hang or expansion payload.

**Known false lead.** `read`'s `compact: true` element snapshot returned an empty element list for a populated menu, while the same elements were present through `tab.observe()`; the browser results above use the reliable path.

**Residual uncertainty.** Findings 40–42 depend on file symlinks, which non-administrator Windows refused in this environment; their read/write paths are unambiguous in source but the link creation itself is unexercised. Findings 51, 56–59, 52 and 58 (renderer behaviour), 75–77 (desktop runtime), 73 (`bun run dev` chunk reload) and all macOS/Linux legs are source-established only. Impact was not measured for the resource-limiting cases (14, 48); those probes were deliberately bounded.
