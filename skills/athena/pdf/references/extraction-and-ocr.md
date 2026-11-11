# Getting text out: extractors, scans and OCR

Start with `python <skill folder>/scripts/pdf_tool.py info file.pdf`. Pages in `no_text_pages` have no text layer;
those in `scanned_pages` also carry a picture, so they're scans or photos. Everything else has text to read directly.

## Picking an extractor

| Tool                                              | Good for                                                                  | Keep in mind                                                                                                                           |
| ------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| pdfplumber (`pdf_tool.py text`, `tables`)         | the text layer with sensible spacing, tables, word positions              | text layer only; MIT licence                                                                                                           |
| pypdf (`text --engine pypdf`)                     | fast plain text from long files                                           | text layer only; looser spacing; BSD licence                                                                                           |
| PyMuPDF (`pip install pymupdf`, `import pymupdf`) | speed on very large files; Markdown output with `to_markdown()`           | version 2 needs Python 3.11 or newer; AGPL-3.0 or a paid licence from Artifex, so tell the user before it goes into anything they ship |
| OCRmyPDF                                          | scanned PDFs: adds a searchable text layer under each page picture        | a separate program; needs Tesseract                                                                                                    |
| Tesseract                                         | OCR of single page images                                                 | a separate program                                                                                                                     |
| marker (`pip install marker-pdf`)                 | hard layouts: Markdown or JSON with tables, equations, reading order, OCR | heavy: PyTorch, and in version 2 a local model server; licence and privacy notes below                                                 |

Default to pdfplumber for anything with a text layer and OCRmyPDF for scans. Reach for the others only for a reason:
PyMuPDF when speed on thousands of pages matters, marker when the layout defeats the rest and the user agrees to the
setup.

## Pages without a text layer

For a page or two, render them and read the images:

```
python <skill folder>/scripts/pdf_tool.py render scan.pdf --pages 3-4 --dpi 200 --out-dir pdf-work/pages
```

For more than a few pages, or when the user wants a searchable PDF, run OCR. Either way, say in the reply which pages
were read from images or OCR: their text is a reading, not a copy, and numbers in particular can be wrong.

## OCRmyPDF

It adds an invisible, searchable text layer under each page picture and keeps the pictures. It needs
Tesseract (version 4.1.1 or newer), and either Ghostscript or pypdfium2 to handle the PDF. It runs on Python 3.11 or
newer, so it's installed as a tool of its own rather than into the skill's Python. Installing is the user's call; ask
first.

| System         | Install                                                                                                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Windows        | `winget install -e --id tesseract-ocr.tesseract`, then `uv tool install ocrmypdf` (uv itself: `winget install -e --id astral-sh.uv`; `pipx install ocrmypdf` also works) |
| macOS          | `brew install ocrmypdf` (brings Tesseract and Ghostscript)                                                                                                               |
| Debian, Ubuntu | `sudo apt install ocrmypdf` (the packaged version can lag; `pipx install ocrmypdf` gives the newest)                                                                     |
| Fedora         | `sudo dnf install ocrmypdf tesseract-osd`                                                                                                                                |

Open a new shell after installing and check with `tesseract --version` and `ocrmypdf --version`.

```
ocrmypdf -l eng --skip-text scan.pdf scan-searchable.pdf
```

- `-l` names the languages, joined with `+` (`-l eng+deu`); each needs its Tesseract language pack (Homebrew's
  `tesseract-lang`, Debian's `tesseract-ocr-deu` and so on). English is the default.
- `--skip-text` leaves pages that already have text alone: the safe choice for mixed files.
- `--redo-ocr` replaces an earlier, poor OCR layer without touching the pictures. `--force-ocr` turns every page into
  a picture and OCRs it, which loses the quality of real text and vector drawings: use it only when the existing text
  layer is garbage.
- `--rotate-pages` turns sideways pages upright; `--deskew` straightens pages scanned at a slant.
- The output aims to be PDF/A (archival) by default and falls back to a plain PDF when it can't; `--output-type pdf`
  asks for a plain PDF, `--output-type pdfa` insists on PDF/A and fails when it can't make one. Since 17.13 OCRmyPDF
  tries its own conversion first and hands files that fail it to Ghostscript, when that's installed.
- Version 17 also has `--mode skip|redo|force` for the same three choices; the older flags still work.

Afterwards, `pdf_tool.py text scan-searchable.pdf` reads the new layer.

## Tesseract on its own

For a few page images (rendered at 300 dpi for OCR):

```
tesseract pdf-work/pages/scan_p3.png stdout -l eng
tesseract pdf-work/pages/scan_p3.png page3 -l eng pdf
```

The first prints the text; the second writes `page3.pdf`, the picture with a searchable layer. Install: Windows
`winget install -e --id tesseract-ocr.tesseract`; macOS `brew install tesseract` (and `tesseract-lang` for other
languages); Debian and Ubuntu `sudo apt install tesseract-ocr` plus `tesseract-ocr-<lang>` packs.

## Poppler's pdftoppm

`pdf_tool.py render` uses pypdfium2, and falls back to Poppler's `pdftoppm` when pypdfium2 isn't installed. To get
it: macOS `brew install poppler`; Debian and Ubuntu `sudo apt install poppler-utils`; Windows `scoop install poppler`
or `choco install poppler`. Check with `pdftoppm -v`.

## marker

marker turns hard documents (papers with equations, multi-column reports, forms) into Markdown, JSON or HTML:
`marker_single file.pdf --output_format markdown --output_dir out`, with `--force_ocr` to OCR every page and
`--page_range` for part of a file. Before suggesting it:

- **Setup is heavy.** It needs PyTorch, and version 2 starts a local model server on first use, which needs vLLM
  (NVIDIA GPU, through Docker) or llama.cpp (CPU or Apple Silicon).
- **Licence.** The code is Apache-2.0, but the model weights have a modified OpenRAIL-M licence: free for research,
  personal use, and organisations under 5 million US dollars in revenue or funding. Larger companies need a paid
  licence from Datalab. Tell the user before using it for their business; terms change, so check the README.
- **Privacy.** `--use_llm` sends page content to Google Gemini by default (it needs a Gemini API key; other services,
  including a local Ollama, can be chosen). Sending a user's document to an outside service needs their permission
  first, every time.

## Tables that come out wrong

- `--strategy lines` (the default) follows ruled lines. Tables without lines need `--strategy text`, which lines up
  words instead. `lines_strict` uses drawn lines but not the sides of rectangles, which helps when shaded rows (drawn
  as rectangles) add borders that aren't there.
- A table that spans pages comes back as one table per page, often with the header only on the first: join them
  yourself.
- Merged cells come back as empty strings next to the filled one. Wrapped cells may arrive split over two rows.
- In your own code, pdfplumber's `page.extract_tables(table_settings={...})` takes more settings (snap and join
  tolerances, explicit line positions) for tables the strategies miss.
- Scanned tables need OCR first; even then, check every number against the image.

## Text that comes out wrong

- **`(cid:12)` codes or gibberish**: the font has no map back to Unicode. Use OCR on those pages.
- **Columns interleaved**: try `--layout`, or in your own code crop each column with pdfplumber's
  `page.crop((x0, top, x1, bottom))`. pdfplumber measures `top` and `bottom` down from the top of the page, unlike the
  PDF points the scripts report.
- **Words run together or split**: try the other engine; the two space letters differently.
- **Ligatures** (`ﬁ`, `ﬂ`) can arrive as single characters: replace them before searching.
- **Hyphenated line ends** stay hyphenated: rejoin words broken across lines before quoting.
