# Eve's local store

This package selects `@workflow/world-local` 5.2.1 through Eve's public custom-world option.
Eve otherwise substitutes its own compiled copy for that package name. The factory imports it at
runtime because the store reads its own package metadata; both packages stay external in the
runtime build and are copied into the desktop package. The factory protects queue deliveries with
a private process token and requeues active work after the store has recovered.

`patches/@workflow%2Fworld-local@5.2.1.patch` fixes a crash between a terminal claim, its step
checkpoint and its event. The original empty claim survives a crash but prevents any subsequent
completion. The patch puts the exact step and event in the atomic claim until both are saved.
Startup finishes pending claims before Eve requeues work, then drops the temporary payload. It
does not run a model or tool, invent an outcome, or reset a running step. Expired/deleted runs
are not restored. The local world continues to require one owning process.

The patch also saves over files on Windows that can't be replaced right then. Renaming over a file fails
(`EPERM`) while anything holds it open, and an antivirus scan can hold one for many seconds without
showing as an open file; the store's write then failed, and its queue retried seconds later, so work
stalled. Moving the file still works, so after a short retry the store moves the old file aside and renames
the new one in, in one synchronous step: nothing else in the process reads in between. If the new one
can't go in either (the temp file is the one held), the old one goes back and the write fails with the
file as it was, so nothing is lost. The old copy is then deleted; one still held after a retry is left
behind, named like a temp file.

The patch is for that exact version. To update the package, run `bun patch @workflow/world-local`, make the same
changes in the new version, `bun patch --commit 'node_modules/@workflow/world-local'`, and drop the old patch and
its `patchedDependencies` entry; `tests/server/eve-world.test.ts` fails while the patch doesn't apply. Renovate
waits for approval on its dashboard before it updates this package.

`bun run eve:recovery` kills the actual runtime at all three write boundaries and during a model
call, which must resume without receiving another input. Unit tests cover
successful and failed outcomes and repeated startup. CI repeats the process checks on Windows
and Linux; desktop smoke repeats them against the relocated package and its bundled Bun.

When upgrading, remove this patch only after the unpatched package passes those checks. Old empty
orphan claims are not migrated. Athena's runtime generation change will retire incompatible sessions
at cutover; application code never repairs private Workflow files.
