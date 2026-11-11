# Tracked changes and comments in depth

How Word stores both, what `docx_tool.py revisions` and `comments` do with each piece, and what they leave for Word.
Run `python <skill folder>/scripts/docx_tool.py revisions --help` (or `comments --help`) for the options.

## How a tracked change is stored

Word writes a change as a mark around the content it touches, with an id, an author and a date:

```xml
<w:p>
  <w:r><w:t xml:space="preserve">Payment within </w:t></w:r>
  <w:del w:id="4" w:author="Ana Ruiz" w:date="2026-03-02T10:15:00Z">
    <w:r><w:delText>30</w:delText></w:r>
  </w:del>
  <w:ins w:id="5" w:author="Ana Ruiz" w:date="2026-03-02T10:15:00Z">
    <w:r><w:t>14</w:t></w:r>
  </w:ins>
  <w:r><w:t xml:space="preserve"> days.</w:t></w:r>
</w:p>
```

Deleted words move from `w:t` into `w:delText`, so anything that reads only `w:t` sees the document as if every
change were accepted; `docx_tool.py text` reads it that way on purpose and says so. One edit in Word can leave several
marks with different ids (a word deleted across two runs, say), and `revisions list` shows each one. Changes can sit
in the body, in tables at any depth, in headers, footers, footnotes, endnotes, text boxes and the comments' own text;
the scripts look in all of them.

## What accepting and rejecting do

Accepting keeps what the change says; rejecting puts back what was there before.

| `kind` in the list                     | Stored as                                                                                                                    | Accept                                      | Reject                       |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ---------------------------- |
| `insert`                               | `w:ins` around runs                                                                                                          | the mark goes, the text stays               | the text goes                |
| `delete`                               | `w:del` around runs, text in `w:delText`                                                                                     | the text goes                               | the text comes back as `w:t` |
| `move_from`, `move_to`                 | `w:moveFrom` / `w:moveTo`, between range marks that share a `w:name`                                                         | text leaves the old place, stays in the new | the other way round          |
| `paragraph_insert`, `paragraph_delete` | `w:ins` / `w:del` in the paragraph mark's properties (`w:pPr/w:rPr`)                                                         | see below                                   | see below                    |
| `row_insert`, `row_delete`             | `w:ins` / `w:del` in `w:trPr`                                                                                                | inserted row stays, deleted row goes        | the other way round          |
| `format`                               | `w:rPrChange` in a run's properties, holding the old ones                                                                    | the record goes, the new look stays         | the old look comes back      |
| `paragraph_format`                     | `w:pPrChange`, holding the old paragraph settings                                                                            | as `format`                                 | as `format`                  |
| `layout_format`                        | `w:sectPrChange`, `w:tblPrChange`, `w:trPrChange`, `w:tcPrChange`, `w:tblGridChange`, `w:tblPrExChange`, `w:numberingChange` | the record goes                             | left for Word                |
| `cell`                                 | `w:cellIns`, `w:cellDel`, `w:cellMerge`                                                                                      | left for Word                               | left for Word                |

**Paragraph marks.** A paragraph's mark (the ¶ Word shows) holds its settings. When a whole paragraph is typed or
deleted with Track Changes on, Word marks the paragraph's mark too. Accepting an inserted mark, or rejecting a deleted
one, only drops the record. The other two join the paragraph to the next one, and the scripts do that only when the
answer is plain: a paragraph left empty by the change goes (its comment anchors and bookmarks move to its neighbour),
and so does an empty paragraph after it. Joining two paragraphs that both keep text is left for Word, which decides
whose formatting the joined paragraph gets; so is a paragraph that ends a section. A cell keeps at least one
paragraph, and a table that ends the document keeps the empty paragraph Word needs after it.

**Moves** have two halves with different ids, tied by the name on their range marks. They're resolved only when all
changes are accepted or rejected together; with `--ids` or `--author` they're left, so text is never kept or lost in
one place only.

**What "left" means.** When something chosen can't be resolved, nothing is written and the result lists each one
with its reason. Tell the user, and offer the two ways on: finish those few in Word (Review, then Accept or Reject on
each), or `--partial`, which writes a copy with everything else resolved and the rest still tracked.

## Recording edits as tracked changes

`edit --track --author "Name"` writes each operation the way Word would record it, so the reader sees and can accept
or reject it in Word or LibreOffice:

- `replace`: the old words in `w:del` and the new ones in `w:ins` right after, in the look of the run the match began
  in. A match that runs across a link, a field or an earlier tracked change can't be recorded this way; those are
  listed and nothing is written.
- `insert`: the new paragraph's runs in `w:ins`, and its mark marked inserted.
- `delete`: every run in `w:del` and the paragraph's mark marked deleted.
- `style`: the old paragraph settings kept in `w:pPrChange`.
- `cell`: the old content deleted and the new text inserted.

Dates are written in UTC and ids are new numbers no other mark in the file uses. This is separate from Word's Track
Changes switch (`w:trackRevisions` in `settings.xml`), which only tells Word to record the user's own next edits;
`info` reports it as `track_changes_on`, and the scripts don't change it.

## How comments are stored

Three pieces, all needed:

1. `word/comments.xml` holds one `w:comment` per comment: `w:id`, `w:author`, `w:initials`, `w:date`, and the comment
   text as ordinary paragraphs. The document part links to it, and `[Content_Types].xml` lists it.
2. `w:commentRangeStart` and `w:commentRangeEnd`, with the same id, mark the commented words in the text.
3. A run holding `w:commentReference` with that id, just after the end mark, is where Word hangs the balloon.

`comments add` splits runs where the words begin and end (each half keeps the run's formatting), then adds all three
through python-docx's `add_comment`, which creates `comments.xml` when the document has none. Its anchors sit inside
one paragraph of the body or a table in it; Word itself can anchor across paragraphs. `comments delete` removes the
comment and all three marks; the commented words stay as they were.

**Replies and resolved comments.** Word 2013 and later keep threads in `word/commentsExtended.xml`: one
`w15:commentEx` per comment, found by `w15:paraId`, which is the `w14:paraId` of the comment's last paragraph.
`w15:paraIdParent` names the comment it answers, and `w15:done="1"` means resolved. Newer Word also writes
`commentsIds.xml` (lasting ids), `commentsExtensible.xml` (dates in UTC) and `people.xml` (who the authors are).
`comments list` reads the threads (`reply_to`, `resolved`). `delete` takes a comment's replies with it, as Word does,
and removes their entries from those parts. Comments added by the scripts are top-level ones with no thread entry:
answering a comment or marking it resolved is done in Word.

## When markers go missing

A comment whose reference or range marks lost their partner, or a reference to a comment that isn't in
`comments.xml`, is what `docx_tool.py check` looks for: errors for a reference with no comment, warnings for a start
without an end or a comment anchored nowhere. The scripts move anchors out of the text and paragraphs they remove
(rejected insertions, emptied paragraphs) so their results keep every comment in place; a whole table row that goes
takes any comment marks inside it, so run `check` after rows were rejected.
