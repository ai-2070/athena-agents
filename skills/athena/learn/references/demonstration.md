# Learning from a screen recording

A screen recording of someone doing a task shows the steps, in pictures, but not the reasons. The pictures are what it
costs: every frame you look at takes a large share of your context. So look at few frames, chosen well, and keep what
you learn in notes as you go, not in mind.

## Is it a demonstration?

- **It is** when the request says so ("watch how I…", "learn this from my recording"), or when the video shows a screen
  being used and nobody talks it through. A talk, a lecture or a narrated tutorial is read by its words instead
  (`sources.md`).
- **Know what result it shows.** The request usually says ("how I file an expense", "my export settings"). If it
  doesn't and the first frames don't make it plain, ask in one line before going further.
- **Narration isn't used yet.** If the recording has sound, learn from the pictures, and say in the report that what
  was said wasn't used.

## 1. Check it

```
python <skill folder>/scripts/learn_source.py probe <video> -o learn-work/probe
```

This reports the length, size, frame rate and whether there's sound, and saves `check-20.png` and `check-70.png`, the
frames a fifth and seven tenths of the way through. Look at both. A blank or frozen screen, the wrong window, or a
recording under a second long means it didn't record what was meant: say so and stop there.

## 2. Choose the frames

```
python <skill folder>/scripts/learn_source.py frames <video> -o learn-work/frames --sheet 2x2
```

It reads every frame once and measures how much each differs from the one before. Then it keeps:

- the first and the last frame;
- the **last frame before each change of screen**: by then the page has loaded and the typing is done, so it shows
  what was done there;
- enough others that no 20 seconds go without a frame (`--every`), for long stretches of typing, scrolling or
  waiting.

It keeps at most 30 (`--max`): the first and last always, then the frames before a change, spread evenly. Each frame's
name carries its time (`f012-02m31.4s.png`), and `frames.json` lists the frames with their times and why each was kept.
`--sheet 2x2` also tiles them, four to a picture in time order, and `frames.json` says which frames each sheet holds.

- **Too few changes found** (a big screen where only a small part changes, like one cell of a spreadsheet): lower
  `--change` from its 0.02, say to `0.01`.
- **Too many** (a video playing, an animation, a busy page): raise it, say to `0.05`.
- **Exit 1** means read the warnings: the file had no length in it (usual for recordings made in a browser), frames
  were dropped to keep to `--max`, or no change was found.
- The output folder must be new or empty, or hold an earlier run's frames, which are replaced.

## 3. Look in two rounds

1. **Overview**, from the sheets: which apps and pages, how many steps, where it ends. Small text can't be read on a
   sheet, since big pictures are shrunk before you see them.
2. **Detail**, from single frames (`view_image`, or your own way of opening pictures) wherever something happens. When
   text is too small even there (a field's value, a menu item, an address), save that moment at full size:

   ```
   python <skill folder>/scripts/learn_source.py frames <video> -o learn-work/frames --at 2:31.4
   ```

   Several at once: `--at 12,45.5,2:31`. These are added beside the other frames.

What happened between two frames is worked out from them: the screen before a change and the one after usually say
what was clicked or typed. When they don't, look at a moment between them with `--at`.

**Write each step into `learn-work/steps.md` before moving on**: the time, the app or page, the action, what it was
done to (a button's text, a menu path, a field's label), the value typed, and "unsure" where the picture doesn't settle
it. The notes, not the pictures, carry the work forward if your context fills.

## 4. Pin down exact values

Pictures misread: `l` and `1`, `O` and `0`, an address cut off by the window's edge, a shortened file name. For every
value the skill depends on, confirm it from a full-size frame (`--at`), from something you can read directly (the page
itself, the app's files or settings, the browser's history), or from the user. What stays unsure goes in the report.

## 5. Inputs or fixed

For each value in the recording, decide whether it changes from one run to the next (the product, the customer, the
month: an **input**) or is part of the method (the export preset, the folder layout, the report's template: **fixed**).
When it isn't clear and the choice would change the skill a lot, ask; otherwise choose, and say what you chose.

## 6. Write the skill

The usual rules in SKILL.md apply, and for a demonstration also:

- **Inputs first**: a short list at the top (`{product}`: the product to photograph), used by name in the steps.
- **Steps by what stays put**: menu paths (File › Export › PNG), the text on buttons, field labels, addresses and
  keyboard shortcuts. Positions on the screen ("the third button", "top right") move with the window's size and the
  app's version.
- **A direct route where there is one**: a tool, an MCP server, a command line or an API that does a step beats clicking
  through the app (the dashboard's Blender tools for a render, the GitHub command line for a release). Keep the clicks
  as the way when that route isn't there.
- **How each step shows it worked**: the message, the new row, the file that appears, so whoever follows the skill
  knows when to go on, and what to wait for (not how long).
- **A "Not shown in the recording" section**: what one run can't show (a field that's missing, an error, the item
  already existing), for the user to fill in.

## 7. Finish

- Delete `learn-work/`. The recording is the user's: leave it where it is.
- Report the steps as learned (numbered), the inputs, what you assumed, what couldn't be read, and that it's a draft
  from one run. Say what would make it better: a second recording of a different case, or answers to "Not shown in the
  recording".

## Watch out for

- **A step between two frames**: a dialog that opened and closed between two kept frames. When the screen after a
  change doesn't follow from the one before, look between them.
- **Menus and tooltips** last a moment: a menu path may show in one frame only, or none. Look around the change with
  `--at`.
- **What was there already**: a value on the screen may not have been typed. The frames before it say.
- **Detours**: a wrong click undone, a typo corrected. Leave the detour out; keep the fix only if it teaches something.
