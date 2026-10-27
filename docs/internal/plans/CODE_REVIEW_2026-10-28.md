# Code review — 2026-10-28

## Scope

Reviewed repository HEAD `aecc2100a1c838fb1d44a2c6fc3514fcdd872d41`, focusing first on security boundaries, project persistence, and agent execution. The working tree was clean when reviewed. No production source files were changed.

The initial nine findings were runtime-reproduced. Probes used temporary `DASH_DATA`, `HOME`, and `USERPROFILE` directories, dummy secrets, Windows directory junctions, and controlled local HTTP endpoints. No real model accounts or user data were used. Initial probe scripts and fixtures were removed afterward. Continued-review findings below state their own verification status.

P1 findings expose credentials, bypass file access limits, or can delete or overwrite files outside the intended project. P2 findings affect project isolation, tool access, or conversation and restore correctness.

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
