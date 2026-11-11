# Line and word times from a voiceover

Where the beat table's times come from, best first. Whatever the source, `DURATION` in the page is the voiceover's
length from `film.mjs voice`, to three decimals: the render refuses a page that runs shorter or longer.

## 1. Times the user gave

They win. Check them against the phrases from `voice` (below) anyway: a time that falls in the middle of a pause, or
past the end, is a typo worth asking about.

## 2. Line times from the pauses

```
node <this skill's folder>/scripts/film.mjs voice <voiceover> > <name>-film/work/voice.json
```

It prints the length, every pause and every phrase (the speech between two pauses), in seconds:

```json
{ "duration": 41.873, "pauses": [{ "start": 3.12, "end": 3.71 }], "phrases": [{ "start": 0.18, "end": 3.12 }], ... }
```

Lay the phrases next to the script's lines, in order. When the counts match, each line starts at its phrase's start.
When they don't:

- **More phrases than lines**: a speaker took a breath inside a line. Merge the phrases that fall inside one line
  (the sentence's commas are where to expect it), or raise `--min-pause` (0.5) so short breaths stop counting. A
  soft-spoken voice whose quiet words count as pauses needs a lower `--noise` (`--noise=-45`).
- **Fewer phrases than lines**: two lines run together. Lower `--min-pause` (0.2). When there's music or room noise
  under the voice, nothing is quiet enough to count: raise `--noise` (`--noise=-25`) above that noise.
- Still ambiguous: give the user your best match and the lines you aren't sure of, and ask.

## 3. Word times from a transcription

A hit on one word (a circle drawn as a name is said, a stamp on "approved") needs that word's time. A transcription on
this computer gives every word's start and end. It means installing OpenAI's Whisper (`pip install openai-whisper`;
it needs FFmpeg, and downloads a large speech model the first time), so ask the user first, and it is slow on a
computer without a graphics card:

```
whisper <voiceover> --model turbo --word_timestamps True --output_format json --output_dir <name>-film/work
```

For speech that isn't English, add `--language <language>`. The JSON's `segments` each hold `words`, and each word
has `word`, `start` and `end`. Find the script's words in it in order; a misheard name still has the right time.
Checked in November 2026 against Whisper v20250625.

A paid transcription service (the ElevenLabs server on the dashboard's MCP page, for one) only when the user chooses
it: it sends their recording away and costs money.

## Without word times

Place the hit where the word falls in its phrase, by its share of the phrase's syllables, then show the user the
draft and ask them to confirm the hits: a sheet with `--every 0.0333` around a hit shows the frames, but only
listening tells whether it lands.
