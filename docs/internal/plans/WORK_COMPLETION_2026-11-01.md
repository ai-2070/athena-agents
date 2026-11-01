# Automatic work completion

1 November 2026. Extends [team context and conversation search](TEAM_CONTEXT_AND_SEARCH_2026-11-01.md).

## Requirement and comparison

An ordinary assignment should finish without the user typing a continuation command. The Brain should verify the result, continue missing work, or stop with a concrete request for user action when the request cannot advance. A plan or partial result is not completion.

[Claude Code's goal documentation](https://code.claude.com/docs/en/goal), reviewed on 1 November 2026, describes a separate completion evaluator after each turn, automatic continuation for unfinished work, an impossible verdict, deferred checks while background work runs, bounded transient retries, and a stop for repeated lack of progress. Athena applies this pattern to ordinary assignments by default; `/goal` remains available for an explicit condition.

## Findings addressed

- Ordinary Brain briefs stopped after two follow-ups; explicit goals stopped after five, even if useful work was still advancing.
- Direct agent and team messages were not supervised without `/goal`.
- The evaluator treated questions, approvals and missing access as success and reported “Goal reached.”
- Agent checks saw a clipped final answer rather than saved tool results. Team checks saw a short thread preview.
- Evaluator errors only produced a log, leaving work silently open.
- Switching projects suspended team queues and dropped some handoff replies.
- A newer Brain assignment to the same agent replaced supervision of an earlier assignment in another chat.
- Stop during a completion check, Clear/Delete, background delegates, and saved open work after a restart needed explicit lifecycle handling.

## Implemented behavior

- Root user messages and ordinary team messages create a saved project-scoped completion brief before work begins. Steering and queued messages amend that assignment and invalidate older checks. Separate agent chats remain independent.
- Brain delegation retains the user's complete request as its completion condition, alongside the execution brief. New work sent to an already supervised team amends its unfinished assignment.
- A separate Brain model invocation checks saved conversation evidence, including tool outcomes. The original request is retained separately from the evidence window. A simple answered question can finish normally; substantive work requires evidence for the requested result.
- Verdicts distinguish delivered, unfinished and blocked. Unfinished work receives a concrete next step automatically. Later user updates take precedence over superseded requirements.
- Productive work has no fixed follow-up count. Three consecutive checks without new progress stop as stuck. Repeated identical results cannot reset the counter just because the evaluator paraphrases its progress claim.
- Blockers, impossible requests, unrecoverable run errors, failed completion checks and stalled work create an actionable question in Needs you/Outbox. Existing unanswered questions are reused. These outcomes are not marked done.
- Answering the question or sending a new message reopens the same blocked assignment with its original scope. Direct work reports in its chat; Brain-delegated work reports in Brain chat.
- Temporary network/service failures retry up to three times with backoff. Authentication, credits, rate/usage limits and context problems request user action. A successful completion check resets the failure counter.
- Parent and team checks wait for dashboard background delegates, including children whose parent turn already ended. Their finished results are added to saved conversation evidence. Team checks wait for outstanding cross-team questions and queued turns; a supervised helper team passes its completion check before its result is relayed back.
- Stop invalidates checks and cancels background delegates even after the parent turn ends. Clear/Delete cancels saved supervision. Late verdicts cannot restart stopped, cleared, replaced or newly revised work.
- Team replies, handoffs and queued work continue in their owning project when the visible project changes. Clones with the same chat/team IDs remain isolated.
- Startup checks saved open assignments across projects and resumes missing work. Stopped and closed assignments are not restarted.
- The existing Brain follows up setting remains the opt-out for ordinary assignments; explicit `/goal` checks still work when it is off. Permissions, tool risk checks, manual approvals and Outbox publication approval stay in force.

## Evidence and limits

Completion checks use the configured Brain model and add one model call per settled turn. The evaluator can judge only saved evidence; it does not independently run commands. It receives up to 60,000 characters of recent evidence with an explicit omission notice, the full assignment, and the preceding review/progress evidence. Missing proof must trigger verification rather than inferred success. Original conversations remain available through search/read tools.

Native harness background jobs that do not appear as dashboard runs remain the harness's responsibility. A stalled check is a request for help, not a claim that the task is logically impossible. A blocked assignment stays saved so the user can answer normally to continue. Explicit repeat loops retain their own scheduling rather than creating a new completion brief on every tick.

## Validation

Regression tests exercise direct and Brain assignments without commands, more than five productive continuations, repeated identical results, agent and team blocker questions and answers, original request preservation, completion model failure, authentication and bounded transient errors, tool evidence, background delegates and Stop, stale verdicts after steering, Clear/Delete, startup recovery, and project/clone isolation. Full repository checks and desktop validation are recorded after completion below.

- `bun run check`: passed, 194 test files; 1,625 passed and 21 skipped.
- `bun scripts/build-desktop.ts`: passed, including the web build and bundled server.
- `bun run desktop:smoke`: passed, including page/API, conversation search/read, MCP bridge and app shutdown.
- `git diff --check`: passed. The local ccc index was refreshed for the changed orchestration code.
