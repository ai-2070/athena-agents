# Teach by showing: learn a skill from a screen recording

5 November 2026. Plan from the research note
[How Grok Bot learns a skill from a screen recording](../GROK_BOT_TEACH_BY_DEMONSTRATION_2026-11-05.md):

1. **Learn from a recording you already have**: `/learn` with a silent screen recording attached. Build now, on
   `LZL0/learn`.
2. **Record from the dashboard**: a "Record your screen" item in the chat's paperclip menu. **Deferred to later next
   week (11 to 13 November).** It builds on step 1, so step 1 lands first.
3. **Later, not scheduled: narration and exact actions.** Talking while you record, and logging the exact clicks and
   typed values in the browser (the note's third option). Steps 1 and 2 don't support narration.

Recordings the dashboard makes are kept, and go into backups once
[Backups: no size limits, with the chats' files](BACKUPS_NO_LIMITS_2026-11-05.md) lands. That plan should land before
step 2.

## Status (5 November, later)

Step 1 is built on `LZL0/learn`, with `main` merged in.

- **What's there:**
  - `probe` and `frames` in `learn_source.py`;
  - `references/demonstration.md`, and the `SKILL.md`, `sources.md` and docs changes;
  - 6 new tests in `tests/skills/learn/`;
  - FFmpeg installed in CI's "Skill scripts" job.
- **The merge** brought `main`'s tool-list budget test. `find_skills` is gone: `read_skill` with a name that is no
  skill now lists the library's matching skills. `save_skill`'s text is shorter, and the core budget was raised on
  purpose by what's left: 13,800 to 14,700 characters, and 12,200 to 13,100 for what every agent carries.
- **Tuned on three real screencasts**, public and silent (Wikimedia Commons: VisualEditor adding a link, editing a
  table, a CSV table):
  - **The change level is 0.02, not 0.05.** Interface changes such as a dialog opening or a table cell changing score
    0.01 to 0.03, so 0.05 found 1 change where there were 4.
  - **`--every` fills any gap between kept frames**, not only still stretches, so a long run of small changes
    (scrolling, slow typing) can't leave a hole.
  - **The result:** 5, 6 and 26 frames for 10, 15 and 52 seconds, each in under 1.5 seconds, and the frames tell each
    task's steps.
- **Still to do:** the trial with agents (it waits for your OK).

## What we want

You show an agent how you do something once, on your own computer, in any app: a Blender product shot, an expense
report in a web app, a release in the dashboard. The agent turns it into a skill:

- the steps as a recipe, with the values that change pulled out as inputs;
- the stable things to click or type.

It tells you it's a draft from one example, and asks for what one run can't show (what to do when something goes
differently). Without narration, the request's one line ("I'm about to show how I…") is the only statement of intent,
which is why step 3 matters later.

## What we have already

- **`/learn` with attachments** in agent chats, team chats and the Brain (`LZL0/learn`, `d7d7499`). Attached files are
  saved in the project's Brain folder (`uploads/<batch>/…`), and the message carries their paths (`describeAttachments`
  in `server/uploads.ts`).
- **The learn skill** (`skills/athena/learn/`) reads speech from a video: its subtitles, or a local Whisper
  transcription after asking. It can save single frames with FFmpeg, but has no route for a recording without speech.
- **`view_image`** (on `main` since `d2c8484`, not yet on `LZL0/learn`): an agent looks at a PNG, JPEG, WebP or GIF of
  up to 5 MB, in a folder it may read, one picture a call.
  - The MCP bridge hands its pictures to Claude Code and Codex, and Eve passes them to its model.
  - Claude Code and Codex can also open pictures with their own tools.
- **FFmpeg**: the `ffmpeg` and `ffprobe` tools (media group; `ffmpeg` is high risk) and the shell. The Programs page
  detects it.

**The constraint that shapes step 1 is pictures, not video.** Each picture costs the model a lot of context: the
dashboard budgets about 4,800 tokens a picture for Eve (`fileTokens` in `server/eve/media.ts`). Forty frames is about
190,000 tokens, which is more than many models hold. So the method must choose frames well, look at them in rounds,
and write notes as it goes rather than hold everything in mind.

## Step 1: learn from a recording you already have (build now)

### Start from a current base

Merge `main` into `LZL0/learn` first: it's 105 commits behind, and `view_image` is on `main`. Run `bun run check`
after the merge.

### The method (`skills/athena/learn/references/demonstration.md`, new)

Written in our own words. Grok Bot's skill is a leaked prompt: take its ideas, not its text (the standard's
no-copied-runs rule).

1. **What is it a recording of?** A video counts as a demonstration when the request says so ("watch how I…", "learn
   this from my recording"). It also counts when it shows a screen and nobody explains it.
   - The request should say what result it shows. If it doesn't, and the first frames don't make it plain, ask in one
     line.
   - A talk or a tutorial someone narrates is still a talk: the existing video route.
2. **Check it cheaply first.** `learn_source.py probe` reports the length, size and frame rate, and whether there's
   sound. It also saves the frames at 20% and 70%. Look at those two. A blank screen, the wrong window or a video under
   a second means a bad recording: say so and stop before spending more pictures.
3. **Sound isn't used yet.** If the user talked while recording, learn from the pictures and say in the report that
   the narration wasn't used. Step 3 adds it.
4. **The pictures, chosen.** `learn_source.py frames` splits the recording into stretches between screen changes.
   - It keeps the **last frame of each stretch**, when the page has loaded and the typing is finished: that's the
     frame that shows what was done.
   - It adds one frame every so often inside long stretches, then thins the set to a cap, always keeping the first and
     last frames.
   - It writes `frames.json` with each frame's time and why it was kept.
5. **Look in two rounds.**
   - **Overview:** contact sheets (`--sheet 2x2`) to learn the shape: which apps, which pages, how many steps. Small
     text is lost on a sheet, since models shrink big pictures.
   - **Detail:** single frames where something happens, and `--at <time>` for a full-size frame to read a field, a
     menu or a typed value.

   Write each step into `learn-work/steps.md` as you go:
   - the time, the app or page, the action, and what it was done to (a button's label, a menu path, a field's name);
   - the value typed;
   - "unsure" where the picture doesn't settle it.

   The notes, not the pictures, carry the work forward if the context fills.

6. **Exact values.** Pixels misread URLs, file names and numbers. For each value the skill depends on, check it
   against a sharper frame, anything else the agent can read (the browser's history, the app's own files), or the
   user. List what's still unsure in the report.
7. **Inputs or fixed.** Decide which demonstrated values change from run to run (the product, the recipient, the
   date) and which are part of the method (the export settings, the folder layout). Ask only when the choice would
   change the skill a lot.
8. **Write the skill**, with the learn skill's usual rules and these on top:
   - a recipe with named inputs (`{product}`, `{month}`) and a list of them at the top;
   - stable targets (menu paths, button and field labels, URLs, keyboard shortcuts), never screen positions;
   - a tool, MCP server or command line in place of clicking through an app, wherever the agent has one (the
     dashboard's Blender, ComfyUI or GitHub tools, an MCP server);
   - a short "Not shown in the recording" section: the cases one run can't show, for the user to fill in.
9. **Clean up and report.**
   - Delete `learn-work/` (the frames and the notes). The recording itself is the user's: never delete, move or copy
     it.
   - Report the numbered steps, the inputs, the assumptions, what couldn't be read, and that it's a draft from one
     example.

**No extra safety rules.** Grok Bot's (confirm-first steps, placeholders for anything private, a dry run, never
running the skill unprompted, no reading browser history) aren't carried over. The learned skill follows the learn
skill's usual rules, nothing more.

**Tools the agent needs:** a shell, or the `ffmpeg` and `ffprobe` tools, to run the script, and a way to see pictures
(`view_image`, or the engine's own). If the agent lacks them, it says which it's missing. The Brain hands the
recording to an agent that has them, as `/learn` already does for sources it can't read.

### The script: `probe` and `frames` in `learn_source.py`

Standard library only, as now. It calls `ffprobe` and `ffmpeg` with `subprocess` (no shell), and follows the script
rules:

- UTF-8 JSON out;
- exit 0 done, 1 done with warnings, 2 couldn't (one line on stderr);
- `os.replace` for what it writes;
- Python 3.10.

**`probe <video> -o learn-work/probe`** gives the length, size, frame rate, and whether there's a sound track. It also
saves two check frames, `check-20.png` and `check-70.png`.

- Browsers' recorders write WebM files with no length in them, so `ffprobe` reports none. The script then reads the
  last packet's time, with a warning (exit 1).
- Not a video: exit 2.
- No FFmpeg: exit 2, with a line on getting it (the Programs page shows whether it's found).

**`frames <video> -o learn-work/frames [--max 30] [--every 20] [--change 0.02] [--width 1280] [--sheet 2x2] [--at 12.4,30]`**:

1. **Find the changes:** one decoding pass,
   `ffmpeg -i <video> -vf "select='gt(scene,<change>)',showinfo" -f null -`. The change times come from `showinfo`'s
   `pts_time` on stderr.
2. **Choose:**
   - Split the recording into stretches between changes. A burst of changes less than a second apart counts as one
     (scrolling, an animation).
   - Keep each stretch's last frame, plus one every `--every` seconds inside long stretches.
   - Thin to `--max`, evenly, keeping the first and last frames, and say how many were dropped.
3. **Save:** each frame with input seeking (`ffmpeg -ss <t> -i <video> -frames:v 1 -vf scale=<width>:-2`).
   - PNG, so text stays sharp. If a frame comes out over view_image's 5 MB, it's saved again as JPEG.
   - Names are Windows-safe and carry the time (`f012-02m31.4s.png`).
4. **Sheets** (with `--sheet`): the chosen frames tiled in time order with FFmpeg's `tile` filter. No text is drawn on
   them (that needs a font file, which is fragile on Windows); `frames.json` lists what each sheet holds.
5. **Moments** (with `--at`): full-size frames at those times only, for reading small text.

The defaults are 30 frames, at least one every 20 s, a change level of 0.02 and 1280 px wide. They were tuned on real
recordings (see Status); the change level started at 0.05.

### Changes to the learn skill

- `SKILL.md`:
  - The description gains "screen recording" (259 characters now, about 280 after).
  - A table row: "Screen recording (you doing the task)", pointing to `references/demonstration.md`.
  - A line under "Before you start": a demonstration needs to say what result it shows.
  - The Files list gains the new reference and the two commands.
- `references/sources.md`: the video section points a screen recording to `demonstration.md`. Its frame line uses
  `frames --at`.
- `skills/athena/README.md`, `docs/guide.md` and `README.md`: `/learn` can learn from a recording of you doing the
  task (without sound for now).

### Tests

`tests/skills/learn/test_learn_source.py`, on videos the test makes with FFmpeg's built-in test sources:

- **A clean video.** About 8 s of three still screens, the middle one "typing" (text growing in small steps).
  - `probe` reports the length and no sound, and writes both check frames.
  - `frames` finds the two changes and keeps the last frame of each screen, with the full text on the middle one.
  - Its times in `frames.json` are within a frame of the truth.
- **The options.**
  - `--max` thins, keeps the first and last frames, and says so.
  - `--at` gives full-size frames.
  - `--sheet 2x2` gives sheets that list their frames.
- **A WebM with no length** (written to a pipe, the way a browser's recorder leaves it) still works, with exit 1 and a
  warning.
- **Failures.** A text file is exit 2. No FFmpeg on `PATH` is exit 2, with one line.
- **Output** goes through the shared `run` fixture's cp1252 pipe.

Elsewhere:

- **CI:** the "Skill scripts" job installs FFmpeg on Linux and Windows. Locally, the FFmpeg tests skip when it's
  missing.
- `tests/server/athena-skills.test.ts` checks the skill's format and Files list, as it does now.

**A trial before calling it done:** three real silent recordings, learned by an agent on the Claude engine and by one
on an Eve model that sees pictures.

- The recordings: a desktop app, a web app, and one near the 10-minute length.
- Read the skills cold. Do they run as written? Are the inputs right?
- The trial runs agents, so it waits for your OK.

### Building it, in order

1. Merge `main` into `LZL0/learn`; `bun run check`.
2. Write `probe` and `frames`, with their tests, and the CI install.
3. Run them on the three recordings and tune the defaults.
4. Write `demonstration.md` and the `SKILL.md` and `sources.md` changes; then the docs.
5. The trial (with your OK), fixes, `bun run check`, commit and push.

## Step 2: record from the dashboard (deferred to later next week)

### What you see

1. The paperclip menu in any chat (agent, team, Brain) gains **Record your screen**.
2. A small dialog asks what you're about to show, in one line; it becomes the `/learn` request. Then **Start**.
   **Only you start a recording**: your click on Start, then your choice in the browser's picker. No agent tool, chat
   command or routine can start one.
3. The browser's own picker opens: a screen, a window or a tab. The browser shows its own "sharing" sign the whole
   time. Nothing records sound.
4. While you work, a small bar shows the time out of 10:00, with **Stop and save** and **Discard**.
   - In Chrome and Edge the bar can float above other apps (Document Picture-in-Picture). Elsewhere it stays in the
     dashboard.
   - The browser's own "Stop sharing" works as Stop and save.
   - It stops and saves by itself at 10 minutes, with a warning a minute before.
5. On save, the recording goes into the chat's attachment tray, like any file. The text box then reads `/learn <what
you said you'd show>`, and Enter sends it: you can add to it first, and it goes through the `/learn` path step 1
   built.

**Recordings are kept** in the project's Brain folder until you remove them. The agent's report says where, and they
go into the project's backups.

### How it works

- **Capture.**
  - `getDisplayMedia` captures video only (`audio: false`) at 15 frames a second. It asks for the pointer to be drawn
    where the browser supports it.
  - `MediaRecorder` records it in MP4 where the browser can, and WebM otherwise. It uses a set bitrate, tuned so a
    10-minute recording stays modest, since recordings are kept and backed up. It takes one-second pieces.
  - The page is local (`127.0.0.1`), which browsers treat as secure, so they allow this.
- **Saving.**
  - The pieces become one file, `screen-recording-<date>-<time>.webm` (or `.mp4`), added with `tray.add`. It uploads
    through the existing route with its checks.
  - If the upload fails, the tray's retry works as for any file, and **Save a copy** downloads it, so nothing is lost.
  - Leaving the page while recording asks first.
- **Server.** One change: `describeAttachments` labels video files as such, so the agent reads "(video, 84 MB)".
- **Code.**
  - `web/recorder.tsx` (new): the dialog, the bar and the recording.
  - `web/attachmenu.tsx`: the menu item.
  - The three composers: the text after saving (`web/chat/ChatView.tsx`, `web/teamchat.tsx`, `web/dock.tsx`).

### The desktop app

The app shows the page in the system's webview:

- **Windows (WebView2):** supports screen capture. The app may need to handle WebView2's screen-capture event; check
  whether wry lets it.
- **macOS (WKWebView):** support for `getDisplayMedia` has been patchy: reports from the macOS 13 and 14 era, and
  [a 2024 WebKit fix](https://bugs.webkit.org/show_bug.cgi?id=274896). The app would also need the system's Screen
  Recording permission.
- **Linux (WebKitGTK):** capture goes through the desktop's portal, and may need the webview's media settings turned
  on.

**The first half-day goes to trying all three.** Wherever the app can't record, the item reads **Record in your
browser**. It opens this chat in the default browser, at the same local address, to record there. That fallback is
enough: no work to make every webview record.

### Tests

`tests/web/recorder.test.tsx`, with `getDisplayMedia` and `MediaRecorder` faked:

- **The request:** it asks for video only.
- **Stop and Discard:** Stop and save puts one file in the tray and the `/learn` text in the box. Discard leaves
  neither.
- **The other endings:** the browser's Stop sharing saves, and so does the 10-minute cap.
- **The fallbacks:**
  - Without `getDisplayMedia`, the item offers the browser.
  - A failed upload keeps the recording and offers Save a copy.

Also a server test for the video label. Then `bun run check`, and a hand run in Chrome, Edge, Firefox, Safari and the
desktop app on each system.

## Step 3: narration and exact actions (later, not scheduled)

Not planned in detail yet. What it would cover:

- **Talk while you record.** A microphone switch, off by default. The desktop app would then need a microphone usage
  string on macOS, and the audio-input entitlement under the hardened runtime.
- **Transcribing it**, and lining the words up with the frames by time, so the skill records why each step was done,
  and what to do when something differs.
  - Whisper needs installing, and the agent asks first.
  - Whether the dashboard should offer to set it up once (a Programs entry) is a question for then.
- **Exact actions in the browser:** URLs, typed values and the elements clicked, logged through
  Playwright or the Chrome DevTools tools, so the skill doesn't rely on reading pixels.

## Decisions

1. **Step 1 is skill text and one script.** No new tool or route: `/learn`, `view_image`, FFmpeg and the shell
   already do the rest.
2. **No narration until step 3.** Steps 1 and 2 learn from pictures only. Step 2 records no sound.
3. **One safety rule from Grok Bot, no more: a recording starts only when you start it.** Its other rules
   (confirm-first steps, placeholders for anything private, dry runs, never running the skill unprompted, no reading
   browser history) aren't carried over.
4. **Recordings are kept.** The agent deletes only its own working files. Recordings the dashboard makes stay in the
   Brain folder until you remove them, and go into backups.
5. **Ten minutes at 15 frames a second**, as Grok Bot does. A longer task is several recordings, each learned into the
   same skill.
6. **Recording ends in the text box, not in a sent message**, so you see what's about to happen and can add to it.
7. **The browser is the desktop app's fallback** wherever its webview can't record.
