# How Grok Bot learns a skill from a screen recording

Research note, 5 November 2026. Nothing here changes our code. Follows
[How Grok Bot's bots work together](GROK_BOT_ORCHESTRATION_2026-10-31.md), which has the background on Grok Bot (xAI's
agent product, built on Cursor's runtime) and on how far to trust each source.

**Sources.**

- xAI's own docs: [Skills, routines and automations](https://docs.x.ai/grok-bot/skills-routines-and-automations).
- The community rebuild of the Grok Bot 0.18 app ([eurekaffeine/grok-bot-0.18-reconstructed](https://github.com/eurekaffeine/grok-bot-0.18-reconstructed)):
  - `source/host/extensions/teach-recording/` (the recording service);
  - `source/shared/agents/teach-recording.ts`;
  - `frontend/src/recovered/features/computer/teach-recording/`.
- The leaked bundled skill [`learn-from-demonstration.md`](https://github.com/asgeirtj/system_prompts_leaks/blob/main/xAI/grok-bot/skills/learn-from-demonstration.md),
  and the main prompt `grok-bot.md` (its `watchVideo` and `videoReview` subagents), in asgeirtj/system_prompts_leaks.

The rebuild's names are inferred from a compiled app; the leaked skill is a verbatim capture and newer than 0.18.

## In short

"Teach a task" is a plain screen recording followed by an ordinary agent turn. The app records the Bot's own cloud
desktop with ffmpeg: video only, at most ten minutes. When the user stops, the app sends the Bot one message: "The
recording is finished. Learn the task from it." The message points it at a bundled skill, `learn-from-demonstration`,
and that skill does all the learning:

1. Claim the recording safely.
2. Check two frames.
3. Have a video model write a play-by-play.
4. Cross-check URLs against Chrome's history.
5. Decide what's an input and what's fixed.
6. Write a skill.
7. Delete the video and report.

No special "learning engine" exists: the know-how lives in a skill, which is the same design as our `/learn`.

## What the user sees (xAI's docs)

1. In a one-to-one chat with a Bot, open its computer view and choose **Teach a task**.
2. Describe the result you're about to demonstrate.
3. Do the workflow once. The controls are **Start recording**, **Stop & save** and **Discard recording**.
4. Stop. The Bot creates a skill; review it.
5. Test it on a safe example before scheduling it.

The docs set four rules around this:

- The recording is the visible computer interaction only, up to ten minutes, with **no microphone audio**.
- Don't show secrets while recording; credentials go through the secure hand-off flow.
- "The learned skill is a draft": the user should add decision rules, failure handling and approval limits that one
  example can't show.
- The feature rolls out gradually (feature gate `sand_teach_by_demonstration`). Without it, the user asks the Bot to
  write a skill from written instructions and a finished task.

## How the recording works (the 0.18 app)

**Where.** Only on the Bot's own private desktop in its cloud computer. Each Bot has its own X display (a "fork
window"); with none free, the app refuses with "Teach recording requires a private desktop monitor." The user
demonstrates on the Bot's computer, through the app's live view of it, not on their own PC.

**The capture.** A shell command in the cloud computer:

```
ffmpeg -y -v error -f x11grab -video_size <W>x<H> -i :<display>.0 -framerate 15 -t 600 \
  -c:v libx264 -preset ultrafast -g 75 -pix_fmt yuv420p -an /workspace/teach-sessions/teach-<time>-<uuid>/demo.mp4
```

That's 15 frames a second, a keyframe every 5 seconds, no audio (`-an`), and a hard stop at 600 seconds. A timer stops
it 2 seconds after that too. `session.json` beside the video records the start time, the display, the video path and
ffmpeg's process id.

**Stopping and saving.**

- The app sends ffmpeg an interrupt so it finishes the file, and writes the end time and reason into `session.json`.
- It adds a queue entry under `/workspace/teach-sessions/queues/<sha256(agent id)>/pending/`, signed with an HMAC key
  kept on the user's machine (`teach-queue-key.json`, mode 600). The Bot can write to its own computer, so the
  signature stops a forged queue entry from triggering learning. On start-up, entries whose signature doesn't check are
  moved to `rejected/`.
- It makes sure the managed skill `learn-from-demonstration` is installed, then sends the Bot the message. The message
  carries a reference to that skill and the queue's scope, and a fixed id so it's never delivered twice. Discard
  kills ffmpeg (after checking the process really is that ffmpeg) and deletes everything.

**Recovery.** At start-up, signed recordings whose message never went out get it then. A recording that failed to
start is cleaned up before the next one.

## How the learning works (the `learn-from-demonstration` skill)

The skill is long and procedural. In order:

0. **Claim and wait.** The Bot claims the oldest recording in its queue, with a lock and a 12-hour lease so two turns
   never take the same one. It takes the video path and ffmpeg's process id only from `session.json`, never from the
   user's message. It waits up to about 30 seconds for ffmpeg to finish writing, without stopping it, then reads the
   video's length with ffprobe. If that fails or the video is under half a second, the recording is unusable.
1. **Sanity check, cheaply.** Save the frames at 20% and 70% of the video and look at them. An idle desktop or the
   wrong surface means a bad capture: don't spend the video model on it, rebuild what's possible from the browser,
   tell the user and offer a redo.
2. **Watch it, through a video model.** The main model "can't watch videos". It hands the recording to a `watchVideo`
   subagent, described as an expert video description model. Attachments are capped at 15 MB, so a long recording
   is split losslessly into parts of about 12 MB (`ffmpeg -c copy -f segment`, which splits on keyframes) and sent in
   order. It asks for a structured play-by-play:
   - the starting state;
   - every meaningful action in order (clicks, typing, navigation, URL changes, menus, scrolling);
   - the ending state, and approximate timing;
   - the exact text typed, never passwords, codes or other credentials (only that one was entered);
   - specific URLs, page titles, names and the elements clicked.

   It can ask the same subagent follow-up questions about unclear steps.
3. **Cross-check with the browser.** While the video model works, it reads Chrome's open tabs (the DevTools
   `/json/list` endpoint) and a copy of Chrome's History database, limited to the recording's time window. It does
   this strictly read-only: no new tabs, no DevTools socket, no navigation, no cookies, and never when running a
   learned skill later. "Where video and history disagree, trust history for URLs and the video for in-page actions":
   pixels miss exact strings.
4. **Decide what the skill is.** It works out the goal, the steps, and which demonstrated values are **inputs** (the
   search term, the recipient, the date) and which are fixed. It goes ahead when it's clear, even if the user didn't
   ask for a skill, and asks only when the ambiguity would change the skill.
5. **Write the skill** ("create by default"; not a summary or an offer):
   - **Name and description:** a short, imperative name, and one line saying when to use it.
   - **Body:** a generic recipe with parameters ("search for {item}"), using stable targets (URLs, labelled buttons
     and fields) rather than screen coordinates.
   - **Connectors first:** a connector or MCP tool for a step where one exists; the browser only where nothing else
     works.
   - **Consequential steps** (orders, messages, payments) are marked confirm-first.
   - **No credentials:** "assumes signed in to X".
   - **No mechanics:** no harness details such as debugging ports or automation snippets.
6. **Clean up and report.**
   - It deletes the video and parts and completes the claim.
   - It sends the learned steps as a numbered list, which values are inputs, its assumptions, and a link to the skill.
   - It offers a dry run, and never runs the skill unprompted. It offers a routine only when the task looks recurring.

**Sensitive information.** Anything on screen may be in the recording. Passwords, codes, API keys, account numbers
and personal details become placeholders. A demonstration that was mostly entering credentials makes no skill.

## What's good, and what's thin

**Good:**

- **The learning is a skill, not code.** It can be improved without an app release, and it's the same tool any learning
  uses. Our `/learn` is built the same way.
- **Pixels and history together.** The video model gives the actions; Chrome's history gives the exact URLs.
- **Inputs versus constants** is the step that turns one demonstration into something reusable.
- **A cheap check before an expensive one:** two frames before the video model.
- **Safety:**
  - the recording is treated as sensitive, and credentials are never transcribed;
  - consequential steps become confirm-first;
  - the learned skill is never run unprompted, and a dry run is offered;
  - the video is deleted afterwards.
- **Robustness:** signed queue entries, leases, delivering the message exactly once, and recovering after a crash.

**Thin:**

- **One example, no narration.** The docs admit the skill is a draft: decision rules and failure handling can't be
  seen in one run, and without audio the user can't say *why* they clicked something. The only intent captured is
  the sentence typed before recording.
- **Browser workflows on the Bot's computer only.** Nothing on the user's own desktop, and nothing outside Chrome
  gets the history cross-check.
- **Pixels for in-page actions.** Exact field values come from the video model reading the screen. No input events
  (the clicks and keys themselves) are recorded, so the elements clicked are inferred.
- **The video model is a separate subagent**, at 15 MB a part, so a long recording costs several calls.

## What it would mean for us

Our `/learn` already reads video files: subtitles, or a local Whisper transcription, then the learn skill. A screen
recording usually has no speech, so it needs what Grok Bot has: frames looked at by a model that sees images, plus
exact strings from somewhere other than pixels. Options, roughly in order of effort:

1. **Teach from a recording the user already has.** `/learn` with an attached screen recording. The learn skill gains a
   "screen recording" route:
   - check two frames, then sample frames: one at every scene change plus a few a minute, rather than all 15 a
     second (for example `ffmpeg -i <video> -vf "select='gt(scene,0.1)'" -fps_mode vfr learn-work/frames/%04d.png`;
     the threshold needs trying on real recordings);
   - read them with the agent's own image-reading tool (the models our engines usually run read images, but few
     take video directly);
   - separate inputs from constants, and write the skill as Grok Bot does: a parameterised recipe with stable
     targets.

   No new code beyond the skill text.
2. **Record from the dashboard.** The browser app can capture a screen or a window with `getDisplayMedia` (a page
   served from `127.0.0.1` counts as secure, so browsers allow it), record it with `MediaRecorder`, upload it, and
   start `/learn` with it attached. The desktop app's webviews (WebView2 on Windows, WKWebView on macOS) need checking
   before relying on this there. Unlike Grok Bot:
   - **Their own desktop and apps.** It records whatever the user chooses: their own Blender, Photoshop or browser,
     not a cloud computer.
   - **Narration, with permission.** We can let the user talk through it ("say what you're doing and why"); the
     transcript carries the intent and the decision rules Grok Bot's docs say one silent example misses.
   - **The same limit.** A ten-minute cap, which keeps the frame count sensible.
3. **Exact strings without pixels.** Where the work is in a browser, an extension or the Playwright or Chrome DevTools
   MCP servers could log URLs, typed values (never passwords) and the elements clicked. That's the strongest
   evidence, and the most work and the most privacy weight. Grok Bot settles for Chrome's history file, read-only,
   which on the user's own PC means asking first.

Of Grok Bot's safety rules we keep one: a recording starts only when the user starts it. The others aren't carried
over: placeholders for secrets, deleting the video, confirm-first steps, never running the skill unprompted. The
agent still tells the user it's a draft from one example, and asks for the decision rules it can't show.

These are planned in [Teach by showing](plans/TEACH_BY_DEMONSTRATION_2026-11-05.md):
- option 1 now, without narration;
- option 2 later in the week of 9 November, also without narration;
- narration and option 3 as a later step, not yet scheduled.
