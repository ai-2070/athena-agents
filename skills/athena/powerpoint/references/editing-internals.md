# How a deck is built, and what the scripts do inside

Open this when a step can't do what's needed, when a result looks wrong, or before writing your own python-pptx code.
Checked in November 2026 against python-pptx 1.0.2 (its current release) and LibreOffice 24.8.

## The package

A `.pptx` is a zip of XML parts tied together by relationship files.

- `ppt/presentation.xml` holds the slide size and `p:sldIdLst`, the list that decides the slide order. A slide part's
  file name (`slide7.xml`) says nothing about where the slide shows.
- `ppt/slides/slideN.xml` holds a slide's shapes; its notes are a separate part (`ppt/notesSlides/`).
- `ppt/slideLayouts/` and `ppt/slideMasters/` hold the design, and `ppt/theme/` the colours and the two theme fonts
  (one for headings, one for body text).
- A chart is `ppt/charts/chartN.xml` plus an embedded workbook holding its numbers; a picture is a file in
  `ppt/media/` that any number of slides can point to.
- The main part's content type says what kind of file it is. python-pptx opens only presentations (`.pptx`,
  `.pptm`) and refuses a template or a slide show with "is not a PowerPoint file, content type is ...". The scripts
  read those with the content type changed and save a `.pptx`, so `pptx_deck.py edit template.potx empty.json -o
copy.pptx` with the plan `[]` turns a template into a deck your own code can open.

## Placeholders and layouts

Every placeholder has a type (title, body, picture, chart, date, footer, slide number...) and an `idx`. A slide's
placeholder takes its position, size and text style from the layout placeholder with the same idx, and that one from
the master's placeholder of the same type, until something on the slide sets its own. So text written into an
untouched placeholder looks like the template, and a position set on the slide stays put when the layout changes.

python-pptx's `add_slide` copies a layout's placeholders onto the new slide, except the date, footer and slide
number: those show only once a slide has its own copy, which is what PowerPoint's Header and Footer box makes. The
`footer` step copies them from each slide's layout. A layout without them can't show them; a text box is the way out
there.

A placeholder left empty is invisible in the slide show but shows its prompt ("Click to add text") while editing,
and a filled-in deck that still has them looks unfinished. `check` lists them.

## Text

A shape's text is paragraphs (`a:p`), each made of runs (`a:r`, text with one formatting) and line breaks and fields
(`a:fld`: the slide number, a date). PowerPoint cuts runs wherever an edit or the spell checker touched the text, so
"Acme" can be stored as "Ac" + "me" with the same look, differing only in marks like `lang`, `err` or `dirty`.
`replace` and `fill` first join neighbouring runs that look the same (ignoring those marks), then replace. A match
across runs that look different (half bold) is still replaced: the new text takes the look of the first part, and
the step's `look_check` names the slide. Matches never cross a line break or a field, and fields are left alone.

`a:normAutofit fontScale="70000"` on a text box is PowerPoint's record that it shrank the text to 70% to make it fit
when it last laid the slide out. python-pptx doesn't lay text out, so after new text goes in, only the rendered
picture shows whether it fits.

SmartArt keeps its words twice: in its data part and in a drawing PowerPoint saved for showing it. `replace` changes
both, but nothing re-lays the diagram, so longer words can overflow its boxes: render the slide. Adding or removing
SmartArt items needs PowerPoint, or the `deckcraft` skill when the user has DeckCraft.

## Charts

python-pptx can only replace a chart's data whole (`chart.replace_data`), rewriting the chart XML and its embedded
workbook together. It matches series by position: the first series in the new data takes the first series'
formatting, and so on; extra series are copies of the last one, colours included. So the `chart` step reads the data
back, applies the changes, and handles what position matching gets wrong: a removed series' XML goes first (so the
series after it keep their own colours), and an added series loses the copied colour so the theme gives it the next
one. Each series keeps its number format; categories stored as numbers or dates stay numbers with their format, so a
date axis stays a date axis.

Out of reach: changing a chart's type (rebuild it with an `add` step), bubble charts, small changes to charts whose
categories are in several levels, and the newer chart kinds (waterfall, histogram, treemap, sunburst, box and whisker,
funnel). Those are stored in a newer format python-pptx can't read; `outline` lists them as a newer kind of chart or
as "newer content", with any text they hold.

## Slide order, deleting and copying

- Moving a slide moves its entry in `p:sldIdLst`. Deleting removes the entry and the relationship to the slide, and
  the slide, its notes and anything only it used are left out when the file is saved.
- python-pptx names a new slide part after the slide count, which can clash with a part still in use once slides
  have been deleted. The scripts renumber the slide parts before every new slide and before saving.
- Sections live in presentation.xml (`p14:sectionLst`) as lists of slide ids. The scripts keep them in step: a moved
  or new slide joins the section of the slide before it, a deleted one leaves its section. Custom shows that listed
  a deleted slide drop it.
- `duplicate` copies the slide's XML, background and animations included, points the copy at the same picture and
  video files, copies the speaker notes' text and gives the copy a new `p14:creationId` (PowerPoint's own id for a
  slide). Comments aren't copied. Anything else a slide owns (a chart and its workbook, SmartArt, an embedded file,
  add-in tags) would end up shared by both slides, so the step refuses.
- Slides can't be copied into another deck: layouts, masters and themes belong to their deck. Rebuild the slides in
  the target from its layouts.

## Fonts and rendering

`render` has LibreOffice turn the deck into a PDF (through `soffice.py`, which uses a throwaway LibreOffice profile,
so a LibreOffice the user has open doesn't get in the way), with hidden slides included through the PDF filter's
`ExportHiddenSlides` option; a LibreOffice too old for that option leaves them out, and the result lists them under
`not_drawn`. pypdfium2 then draws each page as a picture.

A font the computer lacks is drawn with a substitute. LibreOffice's substitution table maps some Microsoft fonts to
fonts with the same letter widths, so lines break in the same places: Calibri to Carlito, Cambria to Caladea, Arial
to Liberation Sans, Times New Roman to Liberation Serif, Courier New to Liberation Mono, Arial Narrow to Liberation
Sans Narrow. LibreOffice's installers bring these fonts; on Linux they come as separate font packages. Fonts with no
such twin (Aptos, Office's newer default, Segoe UI, most brand fonts) are drawn in whatever LibreOffice picks, so
text can wrap, overflow or fit differently from PowerPoint. `render` reports each substitution with `same_widths`;
when it's false, say so, and suggest the user installs the font or checks those slides in PowerPoint.

LibreOffice's picture is close to PowerPoint's but not the same. In LibreOffice 24.8 the footer and slide number
copied onto slides of python-pptx's plain design came out in a serif font though the deck sets none: judge footers by
their place and words. When the exact look matters (a print run, a brand review), ask the user to check the slides in
PowerPoint.

## Writing your own python-pptx code

For what the steps don't cover (a slide background, gradient fills, a new slide size for an existing deck), write a
short script in `pptx-work`, open the deck, save to a new file, then `outline`, `check` and `render` the result.
What's easy to get wrong:

- Sizes are EMU: 914400 to the inch, 12700 to the point; use `Inches()`, `Pt()` and `Cm()` from `pptx.util`.
- `slide.shapes.title` is `None` on a slide with no title placeholder.
- Shapes in a group have positions in the group's own units, not the slide's (`outline` converts them).
- A slide object keeps the shape list it first read: replacing a slide's XML after touching `slide.shapes` leaves
  python-pptx writing to the old, detached shapes. Build the XML first, or get the slide object again.
- After deleting slides, call `prs.part.rename_slide_parts([s.rId for s in prs.slides._sldIdLst])` before
  `add_slide`, or a new slide can take the name of one in use and the saved file is broken.
- `part.drop_rel(rId)` counts only `r:id` references, not `r:embed`, so it can drop a picture still shown elsewhere
  on the slide. Check the slide's XML for the id first.
- Setting `text_frame.text` replaces the paragraphs with plain new ones, so bullets' levels and the runs' fonts go;
  the `text` step keeps them. There `"\n"` starts a paragraph and `"\v"` breaks the line; `paragraph.text` makes
  both a line break; `run.text` keeps `"\n"` as it is and writes `"\v"` as the text `_x000B_`.
- Changing `prs.slide_width` moves nothing: slides and layouts keep their positions. python-pptx's own plain design
  is drawn for 4:3, which is why `pptx_deck.py new` stretches its layouts.
