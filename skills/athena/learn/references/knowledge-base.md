# Knowledge-base skills: books and other large sources

When the source is a large body of knowledge (a book, a set of papers, a specification, a big docs site), one SKILL.md
would force you to summarise most of it away. Make a knowledge-base skill instead: a lean core that's read every
time, and one reference file per chapter or topic that's read only when a question needs it, so what an agent reads
grows with the question, not with the book.

## The layout

```
SKILL.md                       the core, read every time: 100 to 200 lines
references/ch01-<topic>.md     one per chapter or major topic
references/ch02-<topic>.md
references/glossary.md         only if the source has many terms of its own
references/decisions.md        only if it has decision tables or checklists worth having in one place
```

**SKILL.md** holds the source's central ideas and the decision rules worth having in every session, in a few
sentences each, then the index: one line per reference file saying what it holds and when to open it ("open
`ch05-partitioning.md` when choosing how to split data across machines"). The description says what situations the
book helps with, not the book's title alone.

**Each reference file** distils one chapter or topic into notes an agent can act on: the frameworks and definitions,
the decision rules and their conditions, the trade-offs, the anti-patterns, the key numbers and tables as the source
gives them, each with the chapter and section it came from. Dense bullets, roughly 100 to 150 lines a file. Notes
about the source, never passages of it: a short quoted phrase at most.

## Working through it

1. **Map it first.** For an EPUB, `index.json` from `learn_source.py epub`; for a PDF, its contents pages; for a docs
   site, its sitemap or contents. Decide the reference files: usually one per chapter, merging short ones and splitting
   very long ones by section.
2. **Save the skill early**, with the core's first draft and the planned index, so the work is never all in your head.
3. **One chapter at a time**: read it from `learn-work/`, write its reference file, save it (`save_skill` with the
   skill's id and that one file), then the next. Don't hold several chapters in mind at once, and don't read the
   whole book before writing.
4. **Write the core last**, once the chapters show what the central ideas are; save it.
5. **Reconcile**: every file in the index exists, every reference file is in the index, the "open it when…" lines
   still match what each file holds.

A long book is a long job. Tell the user how far you got if you stop part-way, and save what's done: the index can
mark chapters still to come, and a later `/learn` with the same book continues from there (update the skill; don't
make a second one).

## Extending one later

When the user learns more on the same subject (a second book, a new edition, the talk that goes with it), add to the
existing skill: new reference files, changes to the ones that are now out of date (say what changed and why), and an
updated core and index. Two sources that disagree: record both, with which said what, and which is newer.
