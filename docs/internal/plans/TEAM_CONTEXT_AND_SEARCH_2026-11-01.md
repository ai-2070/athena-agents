# Full team context and conversation search

Follow-up: [Automatic work completion](WORK_COMPLETION_2026-11-01.md) adds completion checks to ordinary assignments, continuation while work advances, and separate user-action blockers.

1 November 2026. Replaces item 2 of [the team orchestration follow-ups](TEAM_ORCHESTRATION_FIXES_2026-10-31.md).

The previous change made omitted text visible, but still removed information before agents could use it.
The requirement is a shared conversation with saved originals and model-aware memory, including tools
for looking up the agent's own and its teams' earlier work.

**Implemented and verified on `fix/team-orchestration-2026-10-31`.** `bun run check` passed all 194 test
files: 1 605 tests passed and 21 were skipped. The web build, desktop staging build and desktop smoke test
passed. The smoke test searches and reads a saved original through the bundled server's internal tool
endpoint, then checks MCP bridge startup and server shutdown. Typechecking and `git diff --check` passed.

Restore coverage includes a member's own earlier team replies, a missing private session or API memory,
and a lost native session whose reported compacted memory was smaller than its saved full transcript.
Restored team sessions receive the briefing again. Incidental test fixes wait for a debounced find result
and check every simulated particle's bounds with fewer assertions, avoiding load-dependent timeouts.

## Delivery and retention

- Keep each shared message's full text. Remove the 2 500-character text limit, the 9 000-character digest,
  the 2 000-character preview block, and automatic deletion after 500 messages.
- Import new source messages into a member's own chat as separate user entries with `teamMessageId`.
  Source ids deduplicate imports across turns and survive compaction. Imports from a failed request are
  preserved. A retry restores CLI history when the native session may not have received the input.
- Import the retained thread for a new member and once for existing sessions that only received clipped
  digests. Already deleted messages cannot be reconstructed.
- Keep the addressed task in full. Advance read marks and reference-file delivery only after success.
- Honor explicit Clear and Delete operations. They do not create a hidden searchable archive.

## Model capacity

The engine owns context management. The API engine receives the imported entries directly; CLI engines
receive them in their existing session or a full seed when a session is new or restored. CLI imports can
trigger dashboard compaction even when native compaction is enabled, so a large imported backlog can fit
before the model is called. Full CLI seeds bypass the separate per-entry seed clipping.

Compaction uses the selected model's window and the existing Chat memory settings. It can reduce older
active memory, while the originals remain saved. Conversation search and reading recover those originals.
The API engine no longer applies a separate last-resort history trim to team chats.

If the current addressed task itself exceeds available space, fail explicitly before asking the model.
Keep the source and imported text and leave the read mark unchanged. Do not silently truncate the task.
A larger-context model or a smaller request is required for that case.

## Tools and access

Both tools are read-only `core` tools, available to API engines and through the existing MCP bridge:

- `search_conversations(query, scope?, teamId?, offset?, limit?)`: case-insensitive word matching in the
  same saved entry. Scope is `own`, `team` or `all` (default). Search the calling agent's saved chats,
  including tool results, and the shared transcripts of teams it currently belongs to. Return excerpts,
  source, conversation id, message id and pagination. Recovery-tool results and compaction copies are
  excluded so searches do not recursively find their own output.
- `read_conversation(source, conversationId, messageId, offset?, limit?)`: read the original entry.
  Long entries use explicit character pages with `nextOffset`; no part of the original is made
  inaccessible by the output budget. Serialized output, including escaping, fits below engine tool-result
  limits. Team references use message ids; own-chat references use the existing item sequence numbers.

No caller-supplied agent or project id grants access. Bound calls use the run's agent and project, even
after a project switch; an invalid run or another agent's run is rejected. Calls without a run are scoped
to the saved agent in the current project. Another member's private chat, a non-member team's transcript,
and another project's post-clone messages are unavailable. No extra Files permission is needed.

## Verification

- Put a critical instruction at the end of each long message and assert full input reaches the model.
  Cover both shared context and addressed text, repeated turns, late joiners and over 500 messages.
- Use a small model window to force compaction. Assert full source entries stay saved, then have the
  fake API model call search and read to retrieve an original tail before finishing its answer.
- Check full delivery and restored seeds in a mocked CLI, including native-compaction mode.
- Fail a request and retry; assert read marks do not advance on failure and imports are not duplicated.
- Search and read own and shared history; test literal matching, hit paging, long-text paging, escaped
  output, cleared/deleted sources, membership removal, private peer chats, invalid ids and stand-ins.
- Clone a project and switch while a run is held. Assert tool access remains in the run's original project,
  and another agent cannot borrow the run id.
- Run `bun run check`, `bun run build` and the desktop bundle checks appropriate to the new server modules.

## Limits

The model's live context is finite, and compaction can omit detail. The saved original is the source of
truth; the tools make it recoverable. Search is local word matching, with no embedding service or external
dependency. It scans saved JSON on demand. Very large projects may eventually need a separate index or
segmented transcript storage. Existing JSON storage and project backup/copy behavior remain in use.
