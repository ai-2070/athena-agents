# Reading each kind of source

Get the source into text in `learn-work/`, a piece at a time, before you write anything. Commands are given for a
POSIX shell and for PowerShell where they differ; `<skill folder>` is the folder `read_skill` names.

## This conversation

What to take, in order of value:

- what the user asked for and what they were happy with in the end;
- the steps that worked, with the exact commands, settings, file layouts and names as finally used;
- what failed, why, and what fixed it (these become "Watch out for", not steps);
- the user's corrections and stated preferences ("use the brand blue", "never post on Fridays");
- the decisions made and their reasons.

Leave out the dead ends as steps, the chat's back-and-forth, one-off values (today's date, a file named for this
job), and anything private: keys, passwords, personal details.

## PDF

The `pdf` skill reads it: `python <pdf skill folder>/scripts/pdf_tool.py text <file> --out learn-work/<name>.txt`
writes the text page by page, with a marker before each page, so you can cite pages. `pdf_tool.py info <file>` first
says whether it's encrypted and which pages look scanned; a scanned PDF needs the OCR route in that skill. A big PDF
is a knowledge base: read it a chapter (a range of pages) at a time with `--pages`.

## EPUB

`python <skill folder>/scripts/learn_source.py epub <book.epub> -o learn-work/<book>` writes one Markdown file per
chapter in reading order, and `index.json` with each chapter's heading and length. Read `index.json` first to plan.
A book with DRM is reported, not read: ask the user for a copy without it, or the text their reader can export.

## Word, Excel and PowerPoint

The `docx` skill's `docx_tool.py text <file> --out learn-work/<name>.txt` gives the text in order, tables and notes
included; the `xlsx` and `powerpoint` skills read workbooks and decks. Older `.doc` and `.ppt` files: convert them
with those skills' LibreOffice helper first.

## Web pages and docs sites

Read a page with your page-reading tool. For a whole docs site, find its map first: a contents page or sidebar, its
`sitemap.xml`, or `/llms.txt` (some docs sites publish one listing their pages for agents). Read the pages in the order
the docs teach, not alphabetically, and note each page's address for the skill's sources. A page saved to disk:
`learn_source.py html <page.html> -o learn-work/<name>.md`. A page that refuses you or needs a login: say so and ask
the user for the text; don't try to get round it.

## YouTube

The `youtube-content` skill fetches the transcript with timestamps:
`python <youtube-content skill folder>/scripts/youtube_transcript.py get <link> -o learn-work/<name>.txt`. Cite moments
by their timestamp. Automatic captions mishear names, numbers and code: check those against the slides, the
description or the video itself before they go in the skill.

## Video and audio files

1. **Subtitles in the file.** List them (`ffprobe` and `ffmpeg` come with FFmpeg; the dashboard's media tools run
   them too):

   ```
   ffprobe -v error -select_streams s -show_entries stream=index:stream_tags=language -of csv=p=0 <video>
   ffmpeg -i <video> -map 0:s:0 learn-work/subs.srt
   python <skill folder>/scripts/learn_source.py subs learn-work/subs.srt -o learn-work/talk.md
   ```

   A `.srt` or `.vtt` file beside the video works the same way.
2. **No subtitles: transcribe it on this computer**, with the user's OK, since it means installing OpenAI's Whisper
   (`pip install openai-whisper`; it needs FFmpeg and downloads a speech model the first time, which is large) and it
   takes a while on a computer without a graphics card:

   ```
   whisper <video or audio> --model turbo --output_format srt --output_dir learn-work
   ```

   `--model turbo` transcribes but doesn't translate; for speech that isn't English add `--language <language>`. Then
   `learn_source.py subs` as above.
3. **A paid transcription service** (the ElevenLabs server on the dashboard's MCP page, for one) only when the user
   chooses it: it sends the recording away and costs money.

Slides or a screen recording carry what the speech doesn't: when the talk shows code or a diagram, look at those
frames (FFmpeg can save one at a timestamp: `ffmpeg -ss 00:12:30 -i <video> -frames:v 1 learn-work/frame.png`).

## A folder of code or notes

Start with the README, the docs folder and the layout; then the entry points and the parts the request is about.
Tests and examples show how the code is meant to be used, and config files hold the settings worth recording. Take
the commands to build, test and run it, the conventions (naming, folders, how changes are made) and the gotchas the
comments and commit messages mention. Don't copy code into the skill beyond a short example; point to the file.

## Pasted text and attached files

Read them as they are, attached files by their type above. Pasted text with odd invisible characters:
`learn_source.py clean <file> -o learn-work/<name>.md` after saving it to a file.
