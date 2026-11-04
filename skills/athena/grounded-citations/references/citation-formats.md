# Where citations go in each format

Draft and check in Markdown first (`research-work/report.md`), then build the final file from the checked draft, so
the numbers and the Sources block come from the list whatever the format. `sources.py render --style lines` gives
the entries as plain lines, one per source, for anything that isn't Markdown. After building, compare the final file
with the draft: the same numbers in the same places, and the same sources.

Pick one way of marking sources per document. Bracketed numbers with a Sources list, footnotes, and author-and-year
references each work; two of them in one document confuse the reader.

## A reply in chat

Numbers in the text and the list at the end, as in any draft. The dashboard's chat shows Markdown, so the default
`list` style (bullets, linked addresses) reads well. For a short reply, `render --ids 1,3` prints the block for the
numbers you used; without a shell, copy those entries from the list file. One source for the whole reply can be a
plain link in the sentence instead.

## A Markdown file or a wiki page

`render --in-place` as in SKILL.md. A set of pages (`llm-wiki`, an `obsidian` vault) shares one sources list for the
whole set, so [7] is the same source on every page: render each page on its own and it lists only the numbers that
page cites. Don't start a new list per page.

## Word (`docx`)

Two good ways, built with the `docx` skill:

- **Numbers and a Sources section**: the draft as it is, the bracketed numbers in the text and the Sources list as the
  last section. The simplest, and it survives editing by others.
- **Footnotes**, when the reader expects them (a formal report, legal or academic work): each bracketed number becomes
  a Word footnote whose text is that source's entry. Each footnote belongs to one place in the text, so a source
  cited twice gets two footnotes with the same text. Count the footnotes against the citations in the draft
  afterwards.

Either way, addresses become real links, and the date read stays in the entry.

## PDF (`pdf`, or from the Word file)

Build it from the Word document or Markdown rather than drawing it by hand, so the links survive. Print each address
in full in the Sources list as well as linking it: a printed page has no links.

## Slides (`powerpoint`)

- The number goes at the end of the bullet or in a small "Source: [3]" line under a chart or figure, never as an
  address on the slide: it takes room, and nobody can click a projected link.
- One Sources slide at the end with the entries from `render --style lines`, split over two slides if they don't fit
  at a readable size. Speaker notes can carry fuller detail.
- A chart drawn from a source names it under the chart, including when you recalculated the figures from it.

## Spreadsheets (`xlsx`)

- Facts in rows: a Source column holding the number for each row (or for the cell, as a note, when the sources
  differ within a row).
- A Sources sheet with one source per row: number, title, address, date read, taken from the list file (split its
  lines rather than typing them).
- A figure the workbook calculates cites its inputs, not itself; say so in the column or a note.

## An email or a message

Keep it light: numbers and a short list at the end, or, with one or two sources, the link in the sentence that uses
it. Sending is the user's call.

## Code and configuration

No citations inside code or config files. Where a value came from matters, say it in the document that explains the
code, the commit message or the PR body.

## A named style (APA, MLA, Chicago, Harvard)

When the user names a style, follow that style's own guide for the in-text form and the list. Build each entry from
the list and from what the source itself states: author, publication date, publisher, page. A detail the source
doesn't give is left out or marked as the style says (APA writes "n.d." for no date), never guessed. For a paper,
`arxiv` gives its authors, date and identifier. Keep the numbered form while drafting so `check` still works, convert
at the end, and read the result against the draft.
