# Code review 2026 11 03

Reviewed `LZL0/overview` (`51993d04cae8f2dbe2c382d8c17448ee1ab35984`) against local `main` (`ef89b9ee3724003fdc9638fa42abbf285f214a55`), using `main...LZL0/overview`.

Four issues were confirmed with temporary reproduction tests: three P1 issues and one P2 issue. No source fixes were made.

## 1. P1 Foreign project Brain actions are always discarded

**Location:** [web/brainpane.tsx:96](../../../web/brainpane.tsx#L96). Related guard: [server/overseer.ts:2106](../../../server/overseer.ts#L2106).

The pane sends requests through the correct project's scoped route, and `withProject()` pins the request to that project. However, `overseer.answerNow()` still checks `openProject().id !== p.id` before applying actions. `openProject()` deliberately returns the globally open project, even inside `withProject()`.

With project A open, ask project B's Brain pane to create a task or delegate work. The Brain can generate an answer, but its actions are discarded with “You switched projects while the Brain was thinking.” This happens even when no project switch occurred during the request.

Explicitly scoped Brain requests need an action guard that permits work in their named project while preserving cancellation and conversation checks. The reproduction confirmed that a correctly pinned request to the foreign Brain returned the switch error instead of creating the requested task.

## 2. P1 Foreign chats can display and answer another project's question

**Location:** [web/agentchat.tsx:127](../../../web/agentchat.tsx#L127). Related rendering: [web/chat/parts.tsx:122](../../../web/chat/parts.tsx#L122) and [web/questions.tsx:36](../../../web/questions.tsx#L36).

Chat requests are scoped, but `ToolCard` still reads questions from the open project's app state. `questionFor()` matches by question text, agent ID and chat ID, without a project identifier.

With project A open, open a pane for its copy in project B. If both chats have the same agent and chat IDs and ask the same question, B's pane displays A's waiting question and choices. Answering that card targets A's question. If there is no matching question in A, B's question has no answer card because B's questions were never loaded.

Load questions for the pane's project, carry project identity through the question rendering path, and scope answers and dismissals to that project. The reproduction confirmed that a foreign pane displayed a choice belonging only to the open project's question.

## 3. P1 Stacking panes loses unsent work

**Location:** [web/views/overview.tsx:881](../../../web/views/overview.tsx#L881). Related layout and visibility: [web/views/overview.tsx:710](../../../web/views/overview.tsx#L710) and [web/views/overview.tsx:715](../../../web/views/overview.tsx#L715).

Moving a pane between columns unmounts its chat root and creates a replacement under the destination column. The composer keeps its draft inside that root, and cleanup discards its staged attachments. Scrolling sufficiently far away also removes chat bodies and triggers the same cleanup.

Type a message without sending it, then stack that pane under another. The replacement composer is empty. A layout operation therefore loses unsent work even though the user did not close the chat.

Preserve composer state and attachment ownership outside temporary pane mounts, or retain the chat instance while its placement or visibility changes. The reproduction confirmed that stacking a pane changed its textarea from the unsent draft to an empty value. It used the production mount behavior, without development Strict Mode effect replay.

## 4. P2 Files stay on the previous project after changing scope

**Location:** [web/views/overview.tsx:524](../../../web/views/overview.tsx#L524).

`FilesPanel` initializes its selected `projectId` only once. When the Overview scope changes, the component remains mounted and does not check whether its selection is still among the projects shown.

Open Files under “All projects” while it shows project A, then change the scope to project B. A's files remain visible, the project picker disappears because the scope contains only one project, and folder actions still target A. No request for B's folder is made.

When the selected project falls outside the scope, select an available project and reset the relative folder and listing. The reproduction confirmed that A's file listing remained after selecting B's scope, with no project picker and no folder request for B.

## Validation

- `bun run check` passed: type checking succeeded; 269 test files passed, with 2,621 tests passed and one skipped.
- `bun run build` passed.
- Four temporary reproduction tests confirmed the findings above. They were removed after the review.
- The working tree was clean after removing the temporary tests, before saving this report.
