# Passwords, redaction, sharing safely, PDF/A and big files

The commands here are `python <skill folder>/scripts/pdf_tool.py <command>`; `--help` on each shows every option.

## Passwords

```
pdf_tool.py encrypt report.pdf --user-password-file pw.txt -o report-locked.pdf
pdf_tool.py encrypt report.pdf --user-password-file pw.txt --owner-password-file owner.txt --allow print,copy -o out.pdf
pdf_tool.py decrypt report-locked.pdf --password-file pw.txt -o report-open.pdf
```

- **The open password does the work.** With a user (open) password the file is encrypted with AES-256 and can't be
  read without it. AES needs the `cryptography` package, both to encrypt and to open such files.
- **Restrictions are requests.** An owner password with `--allow` (choices: `print`, `print-high`, `modify`, `copy`,
  `annotate`, `fill-forms`, `accessibility`, `assemble`) asks viewers to block the rest. Viewers that respect it do;
  many tools, pypdf among them, open the file and ignore it. A file with restrictions and no open password opens for
  anyone. Describe restrictions as "asks viewers not to print", never as protection.
- **Passwords stay out of commands.** A password typed into a command line stays in the chat and the shell's history.
  For a real one, have the user save it in a file (one line) and pass `--password-file`, `--user-password-file` or
  `--owner-password-file`; delete the file afterwards if the user agrees. The password travels to the recipient some
  other way than the file itself.
- **Removing a password** is only for a file the user has the right to open and change. Never guess passwords, try
  lists of them or use cracking tools. `decrypt` on a file that opens without a password but carries restrictions
  needs `--lift-restrictions`, as a deliberate step after the user confirms it's theirs to change.
- **Copies come out unprotected.** Any other command run on a protected file (rotate, stamp, merge, fill…) writes
  an unprotected result and says so in `unprotected_copy`. Encrypt it again when it should stay locked, writing the
  open copy into `pdf-work` so that it goes with that folder.

## Redaction

Covering text with a black box, a white box or a stamp hides it from the eye only: the text is still in the file,
and selecting, copying or `pdf_tool.py text` brings it back. The same goes for pictures under a box. Real redaction
removes the content itself:

- The best route is the source document: remove the information there and make the PDF again.
- Storytold's `pdfcraft` skill redacts properly in an installed app and can check a file for fake redactions.
- Without either: render the pages (`pdf_tool.py render`), black out the areas on the images, and make a new PDF
  from the images. The result has no text layer at all (OCR it afterwards if it must be searchable), and it looks
  softer than the original; tell the user both. The rendered pages still show what was removed, so they stay in
  `pdf-work` and go with it.

Then check: `pdf_tool.py text` on the result and search it for every redacted word, name and number.

## Before a PDF is shared

A PDF can carry more than its pages show. Check with `pdf_tool.py info` and `pdf_forms.py fields`:

- **Metadata**: author, title, the program that made it, sometimes a user name or a file path. `pdf_tool.py meta
  in.pdf --clear -o clean.pdf` removes both kinds (the document information and the XMP stream). `meta` without
  `--clear` changes only the document information, and its result notes when the file also has an XMP stream, which
  may still hold the old values.
- **Attachments**: files embedded in the PDF (`attachments` lists and saves them).
- **Form values**: filled fields keep their values; flatten or clear them as the user wants.
- **Hidden text**: white text, text under pictures, cropped-off content. Extracted text shows it.
- **Comments**: notes and highlights from a review travel with the file and show in viewers' comment panes.

Sending, uploading or emailing the file is the user's call, and so is putting it into an online converter.

## Signatures

A picture of a signature placed with `stamp --image` is just a picture. A digital signature is made with a
certificate, proves who signed and that nothing changed since, and is the signer's own act: route it to the user, or
to `pdfcraft` with them. Running these scripts on a signed PDF makes a new file whose signature no longer checks out.

## PDF/A for archiving

PDF/A is the archival form of PDF: fonts embedded, colours defined, no encryption, nothing that depends on the outside
world. Some archives, courts and public bodies require it. pypdf and reportlab can't make or check it; Ghostscript
converts and veraPDF checks.

**Ghostscript** (it supports PDF/A-1, -2 and -3 at conformance level b). Copy `PDFA_def.ps` from Ghostscript's `lib`
folder into `pdf-work`, edit its `/ICCProfile` line to the full path of an ICC colour profile (Ghostscript ships
`srgb.icc` in its `iccprofiles` folder), then:

```
gs -dPDFA=2 -dBATCH -dNOPAUSE -dPDFACompatibilityPolicy=1 -sColorConversionStrategy=RGB -sDEVICE=pdfwrite --permit-file-read=<full path of the .icc file> -sOutputFile=report-pdfa.pdf pdf-work/PDFA_def.ps report.pdf
```

On Windows the program is `gswin64c` instead of `gs`. `-dPDFACompatibilityPolicy=1` drops what PDF/A doesn't allow and
warns about it; read those warnings and tell the user what was dropped. Decrypt an encrypted file first.

Install, after asking: Windows from the official installer on ghostscript.com, or `choco install ghostscript`, or
`scoop install ghostscript` (it isn't on winget); macOS `brew install ghostscript`; Linux the `ghostscript` package.

**veraPDF** validates: `verapdf --flavour 2b report-pdfa.pdf` (on Windows `verapdf.bat`; add `--format text` for a
short report). It needs Java 8, 11, 17 or 21; install it with the installer from verapdf.org or `brew install
verapdf`. A file counts as PDF/A when veraPDF says it passes, not because Ghostscript produced it.

For scans, `ocrmypdf --output-type pdfa` makes a searchable PDF/A in one step (`references/extraction-and-ocr.md`).

## Big files

- `pdf_tool.py compress in.pdf -o smaller.pdf` compresses page content and merges duplicate objects without changing
  how anything looks. `--jpeg-quality 75` also re-saves colour and grey photos as JPEG at that quality (lossy); it
  leaves transparent pictures, palette images and black-and-white scans alone, which get worse as JPEG.
- When photos or scans are the bulk, Ghostscript lowers their resolution:

  ```
  gs -sDEVICE=pdfwrite -dPDFSETTINGS=/ebook -dBATCH -dNOPAUSE -sOutputFile=smaller.pdf in.pdf
  ```

  `/ebook` brings pictures down to 150 dpi and `/screen` to 72 dpi (visibly rough on screen, poor in print).
  Ghostscript rebuilds the whole file, so check that what matters survived (form fields, links, bookmarks), render a
  few pages to compare with the original, and keep the original.
- Report the sizes before and after. If the file barely shrinks, say why (already compressed, or mostly text).
