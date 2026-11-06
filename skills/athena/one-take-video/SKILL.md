---
name: One-take videos
description: Use when someone wants a narrated video drawn entirely in code, with no AI video or stock footage: one continuous camera move over one world, timed to their voiceover, with their photos as props. Plans the beats with them first, then builds, checks and renders it.
---

A one-take video is a single camera move over one big world (a map, a desk, a pinboard, whatever the story lives on)
that glides from detail to detail in time with a voiceover. The real photos and documents lie in that world as
prints and papers. Every frame is drawn in code on an HTML canvas and rendered to an MP4, so any part can be changed
and rendered again exactly. Good work reads at a glance on a phone: one idea per line, one hero per idea, motion that
eases and never stops dead, and every visual hit landing on its spoken word.

## Before you start

- **From the user**, asked for when missing, never invented: the voiceover (an audio file) and its script; the line
  times if they have them; photos of the real people, places and objects; style references; and the format, as width
  × height and frame rate (3840×1646 at 30 fps is 21:9 in 4K). The length is the voiceover's, exactly.
- **Look at every photo and style reference** before planning: the palette, the type, the texture, how much is on
  screen at once, what kind of world they suggest. The film should feel like them, not like the template.
- **Programs:** Node.js 22 or newer (`node --version`), FFmpeg (`ffmpeg -version`), and Chrome, Edge or Chromium.
  Installing one is the user's call: say what's missing and ask.
- **Folders:** the film lives in `<name>-film/` in the workspace: `film.html` (a copy of the template), `photos/`,
  `fonts/` and the voiceover. Copy the user's photos in; their originals stay untouched. Sheets, drafts and other
  working files go in `<name>-film/work/` and are deleted before you report. In a git repository, `work/` holds a
  `.gitignore` of `*`, written with the file tools.

## The beat table comes first

Before drawing anything, write the beat table and show it to the user, with one sentence on the world and the path
the camera takes through it:

| Time | Narration | The one hero on screen | Text on screen |
|---|---|---|---|
| 0.00 | "It started with a photograph." | The print of the farmhouse | none |
| 3.00 | "Taken in a town nobody had heard of." | The words *Harrow Creek* | Harrow Creek (rises in) |

Times come from the voiceover (next section). Ask about whatever is unclear: who is in which photo, how a name is
spelled, what a document should say, which moment matters most. Wait for their OK: a change costs a minute now and a
render later.

## Timing the voiceover

The user's line times win. Otherwise `film.mjs voice` finds the pauses, and the phrases between them map in order
onto the script's lines. A hit on one word (a circle drawn as the word is said) needs word times: with the user's OK,
a local transcription gives them. `references/timing.md` has both, and how to settle a mismatch.

## How to do it well

**One world, one move.** Choose a world the story could really lie on: a map for a journey, a desk for an
investigation, a board for a plan. Lay the props out in story order, so the camera's path is the story's path:
neighbours in the story are neighbours in the world, and a jump in time or place becomes a long move that pulls back,
travels and dives in again. Nothing cuts, and nothing changes like a slide: every transition is the camera moving.

**Readability decides everything else.**
- One idea per line of narration, and one hero for it: a photo, a word or a document. Everything else dims back
  (`LOOK.dim`), and the camera frames the hero by itself.
- Every phrase appears on screen once. If the narrator says it, show it on a real document or type it on screen,
  not both, and don't bring it back in a later beat.
- No filler text. Body copy on documents is soft grey lines that read as paper; nobody tries to read them, so nobody
  is pulled away from the voice.
- Big type. A video on a phone held upright is about 390 points wide, so a 16:9 frame is about 220 points tall and a
  21:9 frame about 167. Type smaller than about 11 points there doesn't read at a glance: that's a twentieth of a 16:9
  frame's height and a fifteenth of a 21:9 one, as a floor for labels. Hero words go far above it. The phone sheet
  (`--tile 390`) shows the result at that size: what doesn't read there is too small, or there's too much.
- Less is more. Tape, stamps, memos and labels that aren't part of the story are clutter. Every prop answers to a
  line of narration.

**Motion that feels filmed.** Every start and stop eases. During a hold the camera keeps drifting slowly towards
where it goes next and pushes in a little, so it never stops dead. A small handheld sway, motion blur on fast moves,
fine grain, a soft glow and a vignette make it feel shot rather than rendered; keep them subtle, and turn them down if
the style references are clean and flat. The template does all of this; `references/camera.md` explains the camera's
path and every setting.

**Props are physical.** Photos are prints with a white border and a shadow; documents are paper. They drop onto the
world where their part of the story happens, land, and stay. A slight turn and the odd overlap look real; a pile
doesn't.

**Hits land on the word.** A circle drawn, a stamp slamming, a print landing, a route drawing on: each starts or lands
on the word that calls for it (`at` on the prop). Land it on the word or a frame or two before it: people notice
sound running ahead of the picture much sooner than the picture running ahead of the sound.

**Arrive before the line.** The camera's move into a beat ends just after the line starts, so the hero is there for
the first word; the template's beats do this. Give each readable state time to be read twice at a calm pace before
the camera leaves; if it can't, the line has too much on screen.

## Steps

1. **Gather and look**: the inputs above, and every photo and reference.
2. **Time the voiceover** and **write the beat table**; get the user's OK.
3. **Build.** Copy `templates/world.html` to `<name>-film/film.html`. Set `FORMAT`, `VOICE` and `DURATION` (the
   voiceover's length from `voice`, to three decimals), then `LOOK` and `FONTS` from the style references, `PHOTOS`
   and `WORLD`, and `BEATS` from the table. Photos from a phone are often far bigger than they'll ever appear: copy
   them in at about twice the largest size they'll show (`ffmpeg -i <photo> -vf scale=2400:-1 photos/<name>.jpg`),
   or every frame draws the full-size file.
4. **Check, fix, check again.** Look at every sheet:
   - every beat: `node <this skill's folder>/scripts/film.mjs sheet film.html -o work/beats.png`;
   - the same at phone size: add `--tile 390 --cols 6`;
   - every camera move and every hit, as a frame sequence: `--from 2 --to 4.4 --every 0.1`, and `--every 0.0333`
     (one frame at 30 fps) around a hit.
   Fix what's cluttered, hard to read, overlapping or clipped at the frame's edge, a frame with nothing in it, a move
   whose spacing jumps from one still to the next, and a hold where two stills in a row are the same (the camera
   stopped). Stop when a full pass finds nothing.
5. **Draft**: `node <this skill's folder>/scripts/film.mjs render film.html -o work/draft.mp4 --audio <voiceover>
   --scale 0.5`. Show the user the draft. They can also open `film.html` in a browser, with the voiceover beside
   it, to watch it live; click to play.
6. **Final render**, at full size into the user's folder: `render film.html -o <name>.mp4 --audio <voiceover>`.
   Renders take minutes (a 1080p frame took about a quarter of a second with heavy motion blur in testing, and 4K
   has four times the pixels), so raise the shell's time limit for that call.
7. **Check the file**: `ffprobe -v error -show_entries stream=codec_type,width,height,r_frame_rate:format=duration
   <name>.mp4` shows the format asked for, a video and an audio stream, and the voiceover's length.

## Done means

- The MP4 has the format asked for, its length is the voiceover's, and the voice is in it, in sync: sheets at the
  word times show each hit landing.
- `sheet` and `render` exit 0, with no warnings (a photo that didn't load, a hero missing from the world).
- Every beat passed the phone sheet; every move passed a frame sequence.
- `work/` is gone; the film's folder stays, since a change next week starts from it, unless the user wants only the
  MP4.

## Watch out for

- **Anything that isn't a function of `t`** flickers or drifts: `Math.random()`, `Date`, state kept between frames,
  CSS animations. Frames render out of order. The template's `seeded()` gives the same numbers for the same seed.
- **Fonts**: the render uses the fonts on this computer, and a missing one falls back silently. Load the user's
  brand font from a file (`FONT_FILES`) rather than trusting a name.
- **Negative options** take `=`: `film.mjs voice voice.wav --noise=-40`.
- **The live preview** can't play the voiceover until it's clicked: the browser blocks sound before a click.

## Files

- `templates/world.html`: the starter film. Sections 1 to 4 are what you edit: format and voiceover, look, the world
  (props: `print`, `paper`, `word`, `circle`, `stamp`, `route`) and the beat table. The rest is the camera, the
  dimming, motion blur, glow, vignette and grain, and the live preview.
- `scripts/film.mjs`: the tool. `voice <audio> [--noise=<dB>] [--min-pause <s>]` prints the voiceover's length,
  pauses and phrases. `sheet <page.html> -o <sheet.png> [--at <t,t,...> | --from <s> --to <s> --every <s>] [--cols
  <n>] [--tile <px>] [--browser <path>]` draws labelled stills (one per beat by default; at most 100).
  `render <page.html> -o <video.mp4> [--audio <voiceover>] [--scale <s>] [--from <s>] [--to <s>] [--crf <n>]
  [--browser <path>] [--timeout <minutes>]` renders an H.264 MP4, and refuses a full render whose page doesn't last
  as long as the voiceover. JSON on stdout; exit 0 done, 1 done with warnings, 2 couldn't (one line on stderr).
  `--help` has every default.
- `references/camera.md`: how the camera's path is built, the settings in `LOOK`, motion blur and finishing, and
  adding a kind of prop.
- `references/timing.md`: line and word times from a voiceover, and settling a mismatch with the script.
