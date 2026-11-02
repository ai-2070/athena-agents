# Eve's local store

This package selects `@workflow/world-local` 5.1.2 through Eve's public custom-world option.
Eve otherwise substitutes its own compiled copy for that package name. The factory imports it at
runtime because the store reads its own package metadata; both packages stay external in the
runtime build and are copied into the desktop package. The factory protects queue deliveries with
a private process token and requeues active work after the store has recovered.

`patches/@workflow%2Fworld-local@5.1.2.patch` fixes a crash between a terminal claim, its step
checkpoint and its event. The original empty claim survives a crash but prevents any subsequent
completion. The patch puts the exact step and event in the atomic claim until both are saved.
Startup finishes pending claims before Eve requeues work, then drops the temporary payload. It
does not run a model or tool, invent an outcome, or reset a running step. Expired/deleted runs
are not restored. The local world continues to require one owning process.

`bun run eve:recovery` kills the actual runtime at all three write boundaries and during a model
call, which must resume without receiving another input. Unit tests cover
successful and failed outcomes and repeated startup. CI repeats the process checks on Windows
and Linux; desktop smoke repeats them against the relocated package and its bundled Bun.

When upgrading, remove this patch only after the unpatched package passes those checks. Old empty
orphan claims are not migrated. Athena's runtime generation change will retire incompatible sessions
at cutover; application code never repairs private Workflow files.
