# Wiki templates

The files a new wiki starts with, to fill in for its subject. Bracketed text is for you to replace; ask the user for
anything you don't know rather than inventing it. The SCHEMA.md template carries the wiki's defaults, each with its
reason, so the user can change one knowingly. Once written, the wiki's own SCHEMA.md is what holds.

## Folders

```
wiki/
  SCHEMA.md      the conventions
  index.md       every page, one line each
  log.md         what was done, oldest first
  raw/           sources as captured: articles/, papers/, transcripts/, assets/ when there are many
  sources/       one page per source
  entities/      people, organisations, products, places
  concepts/      ideas, methods, topics
  analyses/      comparisons and answers worth keeping
```

A small wiki can keep its pages in one folder and rely on `type:` in their frontmatter; the folders help most when
someone browses the wiki in a file manager.

## SCHEMA.md

```markdown
# Schema

## What this wiki covers

[The subject in a sentence or two, and what's out of scope.]
[Who reads it: the user, other agents, a team. Where: Obsidian, GitHub, a Markdown viewer.]

## Page types

- `source` (in `sources/`): one per file in `raw/`. What the source is, its main claims and where in it each is
  made, and what it changed in the wiki.
- `entity` (in `entities/`): a person, organisation, product or place.
- `concept` (in `concepts/`): an idea, method or topic.
- `analysis` (in `analyses/`): a comparison or an answer worth keeping.

A new type is added here before a page uses it.

## Names

Page files are lowercase words joined by hyphens (`attention-paper.md`), which work in every shell, URL and file
system; the page's title is its first heading. Raw files are named by the date they were captured
(`2026-11-04-attention.pdf`), so a raw file never shares a name with a page and a bare link can't mean both.

## Links

[Keep one of these two lines.]
Pages link with `[[page-name]]`, or `[[page-name|shown text]]` inside a sentence. (They read best in Obsidian.)
Pages link with relative Markdown links: `[shown text](../concepts/page-name.md)`. (They work on GitHub, in VS Code and
in a browser.)

A page links to the pages it relates to, and they link back where it reads naturally.

## Frontmatter

Every page starts with `type`, `tags`, `created` and `updated` (dates as YYYY-MM-DD), and where it applies `sources`
(the source pages it draws on), `confidence`, `contested` and `contradictions`. Source pages add `raw`, `url`,
`ingested` and `sha256`.

## Confidence

- `high`: several independent sources agree, or a primary source (the paper, the official record) says it directly.
- `medium`: one reliable source, not yet confirmed by another.
- `low`: one secondhand or interested source, an estimate, an opinion, or a claim the sources dispute.

Why: a weak claim repeated across pages starts to look like fact; the marker keeps its weight visible.

## Tags

Every tag on a page comes from this list, and a tag is added here before a page uses it. Lowercase, no spaces; a `/`
nests one tag under another.

- `[tag]`: [what it marks]

Why a list: free tagging drifts into near-duplicates (`ml`, `machine-learning`, `ML`) that each find part of the wiki.

## When a subject gets a page

- When it is central to a source, or comes up in a second one. A passing mention stays a line on a related page.
  Why: a page for every name buries the pages people need.
- A page covers one subject; when it starts covering two, it is split and the halves linked. Why: links then mean
  something. Length alone isn't a reason to split.
- An answer becomes an `analysis` page when it took real work to put together and the user wants it kept.

## Changes that need the user

- An ingest or a clean-up that would rewrite many existing pages is shown as a list first. [If the user names a
  number, write it here.]
- Pages and raw files are deleted only by the user, or with their yes; retired pages go to `_archive/`.
- This file changes only with the user.
```

## index.md

```markdown
# Index

[Two or three sentences: what the wiki covers and its main threads, so a reader knows where to start.]

## Sources

- [[attention-paper]]: [one line: what the source is and why it's here]

## Entities

- [[google-brain]]: [one line]

## Concepts

- [[transformers]]: [one line]

## Analyses
```

One line per page, under its type, alphabetical, with a summary that tells a reader whether to open it. When a
section grows too long to scan, split it under sub-headings by topic. Karpathy reports the index alone serving well up
to about a hundred sources and hundreds of pages; past that, search the pages' text as well when answering.

## log.md

```markdown
# Log

One entry per ingest, filed answer, check and reorganisation, oldest first. Entries are added at the end and never
changed. Pages are named as plain text, so a later rename leaves no dead links here.

## [2026-11-04] create | Wiki started

- Covers: [subject]

## [2026-11-04] ingest | Attention Is All You Need

- Created: attention-paper, transformers, google-brain
- Changed: none
- Disagreements: none

## [2026-11-05] query | How do transformers differ from RNNs?

- Filed: transformers-vs-rnns

## [2026-11-06] lint | 4 problems, all fixed

- Fixed: 3 broken links in transformers; google-brain added to the index
```

Every entry starts with `## [date] kind | subject`, so the latest ones are easy to pull out:

```powershell
Select-String -Path wiki\log.md -Pattern '^## \[' | Select-Object -Last 10
```

```sh
grep '^## \[' wiki/log.md | tail -n 10
```

If the log ever gets unwieldy to open, it can be renamed `log-<year>.md` and a new `log.md` started; the check treats
both alike.

## A source page

```markdown
---
type: source
tags: [paper]
created: 2026-11-04
updated: 2026-11-04
raw: raw/papers/2026-11-04-attention.pdf
url: https://arxiv.org/abs/1706.03762
ingested: 2026-11-04
sha256: [what wiki_lint.py hash prints]
confidence: high
---

# Attention Is All You Need

[Who made it, when, and what kind of source it is: paper, article, interview, data.]

## Main claims

- [A claim, and where in the source it's made: section, page or timestamp.]

## What it changed here

- [Pages created, claims added or changed, disagreements it opened.]

## Doubts and open questions

- [What it doesn't show, what seems weak, what to look for next.]
```

`raw:` is the file's path from the wiki's root. Leave out `raw:` and `sha256:` only for a source that couldn't be
saved (a paywalled page the user read to you), and say so on the page. Without Python, `Get-FileHash -Algorithm SHA256
<file>` in PowerShell, `shasum -a 256 <file>` on macOS or `sha256sum <file>` on Linux gives the same fingerprint; the
check ignores capital letters.

## A subject page (entity or concept)

```markdown
---
type: concept
tags: [method]
created: 2026-11-04
updated: 2026-11-04
sources: ['[[attention-paper]]']
confidence: medium
---

# Transformers

[What it is, in a sentence or two.]

## [Sections that fit the subject: how it works, history, who's involved, where things stand]

[Each claim with its source: "... ([[attention-paper]], section 3)."]

## Where sources disagree

[Each position, its source and date, and whether the newer one supersedes the older.]

## Related

- [[google-brain]]: [how it relates]
```

Write it as one account of the subject, not a stack of per-source summaries. In Obsidian's frontmatter, links in a
list are written in quotes (`"[[attention-paper]]"`) and each list item can also go on its own line after a `- `. A
page with an open disagreement adds `contested: true` and `contradictions: ["[[other-page]]"]`.

## An analysis page

```markdown
---
type: analysis
tags: [comparison]
created: 2026-11-05
updated: 2026-11-05
sources: ['[[attention-paper]]', '[[rnn-survey]]']
confidence: medium
---

# Transformers compared with RNNs

[The question as the user asked it, and the date.]

## Answer

[The answer, each claim citing the pages it rests on.]

## What would change it

[Gaps, assumptions, sources that would settle what's open.]
```

## .gitattributes

When the wiki is kept in git, put this at the wiki's root:

```
raw/** -text
```

It stops git from changing the line endings of raw files when it checks them out on another system (with
`core.autocrlf` set, as Git for Windows often is), which would change their fingerprints and make every text source
look edited. The pages can keep git's usual handling.
