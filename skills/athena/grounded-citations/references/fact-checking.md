# Evidence mode and fact-checking

In evidence mode every cited source has its text saved in `research-work/pages/`, and the words each claim rests on
are quoted in the draft and checked against that text by `sources.py check --evidence`. The reader gets the claim, its
source and the source's own words, and nothing rests on your paraphrase.

## Saving a source's text

The saved file is what quotations are checked against, so it has to be the source's words as they came, not tidied,
shortened or summarised. Save it as you read the source, name it after the source's number (`pages/3.txt`), and put
its path at the end of the source's line in the list (or pass it to `add --text-file`).

| The source | How to save its text |
|---|---|
| A web page, with the dashboard's page-fetch tool | It returns the page's readable text after a first line with the status and final address. Write that text into `pages/<n>.txt` with your file tools exactly as it came. It stops at a length limit: for a long page, fetch again with a larger one |
| A web page, with a shell | `curl.exe -fsSL --max-time 60 -A AthenaAgents -o research-work/pages/3.html 'https://…'` in PowerShell (`curl` on macOS and Linux). The script reads the text out of the HTML itself, leaving out scripts, styles and the page's head |
| A page that builds its text with scripts | The saved HTML comes back nearly empty. A browser that runs scripts (the Playwright MCP server, added on the dashboard's MCP page) shows the text; save what it shows |
| A PDF (a report, a filing, a paper) | Save the PDF, then its text with the `pdf` skill: `pdf_tool.py text report.pdf --out research-work/pages/4.txt`, which marks each page (`--- page 12 ---`) so you can give page numbers. Scanned pages need OCR first (the same skill) |
| A paper | `arxiv` finds it and its details; quote from its full text, saved as for a PDF, not from the abstract alone |
| A video | Its transcript (`youtube-content`) is the text; give the time of the passage in the sentence |
| A Reddit thread | Save what the social tool returned for the thread |
| The user's own document | Its text (`docx` for Word, `pdf` for PDF); for a spreadsheet, cite the sheet and cells and give the figure, since there are no sentences to quote |

Then search the saved file for the passage you mean to quote. If it isn't there, the save went wrong or the page
differs from what you saw: don't quote it until it is.

## Quoting

- Copy the words from the saved file, never from memory or from a summary of the page.
- Quote enough to carry the claim: the figure with its unit and what it measures, and the subject it's about. "Rose by
  12%" proves nothing until the quotation says what rose, where and when.
- Read the sentences around it. "Critics claim that…", "if current trends continue", a figure for one region only:
  a quotation that drops its qualifier misquotes, even if every word matches.
- Leave words out with `...` or `…`, and put your own words in [square brackets]. Each part between the gaps must
  still match word for word, in order.
- The check sets aside case, curly or straight quotes and dashes, Markdown and HTML formatting, line breaks and
  footnote marks such as `[3]`. Everything else counts: a changed figure, a dropped "not", a plural for a singular.
- Put the quotation in double quotes ("…", “…”, „…“ or «…») with the source's number right after it or at the end of
  its sentence, or in a blockquote whose last line, or a line under it starting with a dash (`— Statistics office[2]`),
  carries the number. A quotation is three words or more; one or two words in quotes are taken as a term.
- A source in another language: quote the original, give your translation after it in brackets, and say the
  translation is yours. The check reads the original.
- When `check` says a quotation isn't in the saved text, it shows where the two part ways. Correct the quotation from
  the file; don't reword it until something matches.

## Claims without a source

`[unverified]` goes after a sentence the piece needs but no source you could read supports, often background you know
but couldn't find written down. Before you mark one, try another kind of source. A quotation can't be `[unverified]`:
without a source it isn't a quotation. Opinions and your own reasoning, worded as such ("this suggests…"), need
neither a number nor the marker. If many sentences end up marked, say so at the top of the hand-over.

## Two independent sources

A disputed fact, a surprising figure, a claim about a named person or company, and anything the conclusion turns on
need two sources that found it separately. Trace each to where it started: syndicated copies, rewrites of one press
release, and articles that cite each other collapse into one. An organisation's statement about itself is the primary
source for what it says, not for whether it's true.

When sources disagree, give each reading with its own number and quotation, say why they may differ (dates,
definitions, what was measured, who paid for it), and say which you weigh more and why. Don't average them or quietly
pick one.

## Checking someone's text

When the user hands over a text to fact-check (theirs, an article, a post), leave it unchanged unless they ask for an
edited copy, and report on it:

1. List the checkable claims, numbered: facts, figures, dates, quotations, who said what. Leave out opinions and
   predictions, or note them as such.
2. For each, find the primary source, save its text, and quote the passage that settles it.
3. Give each a verdict in plain words: **Supported**; **Partly supported** (say which part is off); **Not supported**
   (a source contradicts it: quote the source); **Couldn't check** (say what you tried). Absence of evidence is
   "couldn't check", not "false".
4. Report as a table, claim by claim (claim | verdict | what the source says, quoted, with its number), then a short
   summary and the Sources block. `check` reads quotations inside table rows too.

## Reading check's problems

| Problem | What to do |
|---|---|
| `unknown_id` | The text cites a number the list doesn't have. Cite a listed source, or add the source if you read it |
| `marker` | `[1, 2]` or `[1-3]`: write `[1][2]` |
| `no_sources_block`, `block` | The Sources block is missing or doesn't match the list: run `render` again |
| `quote_not_found` | Fix the quotation from the saved text. If the passage isn't in the file, save the page again or drop the quotation |
| `unchecked_quote`, `no_saved_text` | Save the source's text and add its path to the list |
| `no_quote` | Quote the words the claim rests on. A source cited for nothing quotable may not be needed |
| `uncited_quote` | Add the source's number, or take the quote marks off words that aren't a quotation |
| `saved_text` | The saved file isn't text (a PDF, a Word file): save its text instead |
| `list` | A line in the list needs fixing: `sources.py list` names it |

Notes (`crowded`, and outside evidence mode `unchecked_quote` and `uncited_quote`) aren't failures, but each is worth
a look.
