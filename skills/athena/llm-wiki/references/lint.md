# Checking the wiki

A wiki decays quietly: a rename leaves dead links, a new page never reaches the index, a source is re-saved and no
longer says what its page claims. `wiki_lint.py check` finds what can be counted; the rest of this file says what each
finding means, how to fix it, and the checks that need reading.

## Running it

```
python <skill folder>/scripts/wiki_lint.py check <wiki folder>
python <skill folder>/scripts/wiki_lint.py check <wiki folder> --skip _archive --skip templates
```

| Option             | What it does                                                                                                                                                                              |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--skip FOLDER`    | Pages in this folder (from the wiki's root) aren't checked; links into it still count. Repeatable                                                                                         |
| `--raw FOLDER`     | The folder of raw sources (default `raw`)                                                                                                                                                 |
| `--require FIELDS` | Frontmatter fields every page needs, comma-separated (default `type,tags,updated`). `--require=` asks for none; Windows PowerShell 5.1 drops an empty `""` argument, so write it that way |
| `--limit N`        | List at most N items of each kind (default 50); the counts are always complete                                                                                                            |

It reads `index.md` and every page: each `.md` file outside the raw folder, dot folders (`.obsidian`, `.git`) and
`--skip` folders, apart from `SCHEMA.md`, `index.md`, `log.md` and `log-*.md` at the root. It changes no file. Exit
code 0 means no problems, 1 that the JSON lists some, 2 that it couldn't check (no such folder, a bad option), with one
line on stderr saying why. The JSON has `counts`, `problems` and `review` (each kind with a `count` and its `items`),
`how_to_fix` for each kind of problem found, and `skipped` when a check couldn't run (no Tags section in SCHEMA.md).

Links are resolved the way Obsidian and Markdown viewers would: `[[name]]` by file name anywhere in the wiki or by a
path from its root (`.md` may be left off; other files need their extension), Markdown links relative to the page,
then from the root, then by name. Links inside code, `<!-- -->` and `%% %%` comments don't count.

## Problems

Fix the ones that mislead readers first: broken links and changed sources, then the index and orphans, then fields
and tags.

- **`broken_links`**: a link, or a name in `sources:` or `contradictions:`, that reaches nothing. The `why` says which
  of four ways: no such file (often a renamed page: search for its old name in the log and its title in the pages);
  a name that differs only in case (Windows and macOS may open it, Linux and GitHub won't); a bare name two files
  share (write the folder in, or rename one, since a bare link can't choose); a path that leaves the wiki. Broken
  links in `index.md` are listed here too. A link to a subject that deserves a page can be kept and the page written
  instead.
- **`orphans`**: pages no other page links to. Links from the index and the log don't count, since they reach
  everything. Usually the pages it relates to never linked to it: add those links (a source page is linked from the
  pages that cite it, an analysis from the pages it draws on). A page nothing relates to may not belong; ask.
- **`not_in_index`**: add a line under its type, with a summary that tells a reader whether to open it.
- **`missing_fields`**: no frontmatter, frontmatter that never closes with `---`, or fields `--require` names that are
  absent or empty. A page with `raw:` also needs `sha256:` (one per raw file, in the same order, if it names several).
- **`unknown_tags`**: a tag missing from SCHEMA.md's Tags section, or one Obsidian can't read as a tag (a space, or
  only digits). Use a listed tag, or add the new one to the list first; if the user keeps the list, ask. The check
  reads the tags in backticks on the list lines under the heading `Tags`, and compares them ignoring case, as
  Obsidian does.
- **`raw_missing`**: the file a source page names isn't there. It was probably moved or renamed: find it and fix
  `raw:`. If it's gone, tell the user; the page stays, saying its source is no longer kept.
- **`raw_changed`**: the file no longer matches the fingerprint taken when it was ingested. Raw files aren't edited,
  so find out why before fixing anything: re-saved from a page that has since changed, edited by hand, or line endings
  changed by git (see `.gitattributes` in templates.md). Compare the file with the source page, update the claims
  that changed (dated, with the old wording kept where it mattered), record the new `sha256`, and log it.
- **`not_utf8`**: a page saved as UTF-16 or in a Windows code page, usually by PowerShell's `>` or `Set-Content`.
  Obsidian, git and browsers expect UTF-8: write it again with your file tools.
- **`missing_files`**: `SCHEMA.md`, `index.md` or `log.md` isn't at the root. Recreate it from the templates; for a lost
  index, rebuild it from the pages' titles and frontmatter.

## For review

These never fail the check; they're listed for a person to decide.

- **`contested`**: pages marked `contested: true` or with `contradictions:`. Has a newer source settled it? If so,
  say which claim stands and why, and clear the marks. If not, the user may know.
- **`low_confidence`**: pages marked `confidence: low`. Candidates for a better source, or for the user to drop.
- **`not_ingested`**: files in the raw folder that no source page names and nothing links to (the pictures a saved
  article shows count as used): sources the user dropped in, by hand or with Obsidian's Web Clipper, or ones an
  earlier session saved and never filed. Offer to ingest them.
- **`same_name`**: two pages with one file name in different folders, often two pages about the same subject. Merge
  them, or rename one so bare links can tell them apart.

## What it doesn't check

Tags written in the text with `#`; whether the heading in `[[page#heading]]` exists; links in the log (it's history);
web addresses (nothing is fetched); and anything about what the pages say. That part is reading:

- **Disagreements nobody marked.** Pages that cite the same sources, or link each other, giving different numbers,
  dates or names for the same thing. Check against the source pages, then mark and report as in SKILL.md.
- **Claims a newer source overtook.** For each source page ingested recently, open the subject pages it changed and
  those it links to: an `updated` date older than the source's `ingested` date means the page may still say the old
  thing.
- **Subjects without a page.** A name or term that turns up in plain text on several pages but links nowhere; give it
  a page if SCHEMA.md's rule says so, and link the mentions.
- **Missing links.** A page mentioning another page's subject without linking it.
- **Gaps.** Questions the user cares about that the wiki can't answer, or rests on one source for: suggest sources to
  look for.

## Fixing many pages at once

List the changes before making them when they reach many pages (a renamed tag, a merged pair of pages, links fixed
across the wiki), and wait for the user's yes. Then make them, run the check again, and add one log entry:
`## [date] lint | <n> problems; <what was fixed>`, with what's left and why.
