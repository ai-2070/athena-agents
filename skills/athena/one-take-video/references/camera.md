# The camera, the look, and new kinds of prop

How `templates/world.html` moves its camera and finishes each frame, what each setting does, and how to add a kind
of prop. Open it when a move feels wrong, when the style asks for a different finish, or when the story needs a prop
the template doesn't draw.

## Where the camera looks

A pose is a point in the world, a view height and a turn. The view height is how many world units the frame shows
from top to bottom; the camera works with its logarithm, so a push-in from 1000 to 500 units takes as long and feels
as even as one from 500 to 250.

Each beat gives the camera a framing:
- by default, its hero, sized so the hero's box (turned with the prop) takes `fill` of the frame's height, or of its
  width when it's wide: `cam: { fill: 0.6 }`. `dx` and `dy` nudge the centre (room for a caption beside it), and
  `rot` turns the frame in degrees;
- or `cam: { on: '<id>' }` frames another prop than the hero (the document while its stamp is the hero, say);
- or `cam: { x, y, view }` frames a place.

Text needs more room around it than a photo does: a hero word at a `fill` of 0.5 or less leaves the eye somewhere to
rest.

## The path

`buildPath()` turns the framings into one path, once, when the page is ready:

1. **Moves.** The move into beat *k* takes `move` seconds (1.6 by default) and is placed so 60% of it happens before
   the line starts and 40% after: the hero is mostly there for the first word, and the camera settles during it.
   When two beats are too close for both moves, the moves meet halfway. A beat shorter than its move is usually a
   line that should share the framing before it: give it the same hero, or a shorter `move`.
2. **Holds.** Between arriving and leaving, the camera drifts towards the next framing (`DRIFT`, 3.5% of the way
   each second, 10% at most) and pushes in slowly (`CREEP`). That's what keeps a hold alive, and it makes the next
   move feel like it was already under way.
3. **Smoothness.** Each piece of the path is a cubic Hermite curve, and each one starts at the speed and direction the
   piece before it ended with. Speed never jumps, so nothing jerks, and it never reaches zero, so nothing stops dead.
4. **Pull-backs.** On a move whose ends wouldn't both fit in the frame, the view widens in the middle of the move,
   enough to show where it left and where it's going, then dives in again. `lift: 0` on a beat turns it off for the
   move into that beat (for a short hop between neighbours that should feel like a pan).

To check a move, look at a frame sequence across it (`sheet --from <start> --to <end> --every 0.1`): the distance
the picture travels from one still to the next should grow and shrink smoothly. A sudden jump is a move too short
for its distance (give it a longer `move`), and two identical stills during a hold mean the drift is too small.

## Handheld and shake

The handheld sway is a sum of slow sine waves at unrelated frequencies, the same every render: `LOOK.handheld` (a
fraction of the frame's height) and `LOOK.handheldTurn` (degrees). Too much reads as nervous; it should be felt more
than seen. Each stamp adds a short shake that dies away within half a second of its hit.

## Motion blur

For each frame the page measures how far the picture moves in one frame (camera travel, zoom and turn, in pixels).
When the blur would be longer than a few pixels, it draws the world several times across the open shutter and blends
the results: up to 12 sub-frames, and at least 6 while a prop is falling or a stamp is slamming (each kind lists
those moments in `fast`). `LOOK.shutter` is the fraction of the frame the shutter stays open: 0.5 is film's
180-degree shutter; less is crisper and more stuttery, more is smeared. Blur multiplies the drawing work, which is
why fast moves are the slowest frames to render.

## Dimming

The current beat's hero, and every prop with `on: '<hero id>'`, stays at full strength; everything else sits under a
dark veil of strength `LOOK.dim`. At each new line the old hero fades down as the new one comes up, starting a quarter
of a second before the line. A beat with `dim: 0` dims nothing (a wide shot of the whole world), and a beat with no
hero does the same.

## Finishing

After the world is drawn, three passes over the whole frame, each set to 0 to turn it off:
- **Glow** (`LOOK.glow`): a quarter-size copy of the frame, with its darks pushed down and blurred, laid over the
  frame in "screen" mode, so only bright things bloom.
- **Vignette** (`LOOK.vignette`): a radial darkening from the middle to the corners.
- **Grain** (`LOOK.grain`): one of eight fixed noise tiles, chosen and shifted by the frame number, laid over in
  "overlay" mode. It changes every frame, the way film grain does, and renders the same every time.

## Adding a kind of prop

Add an entry to `KINDS` with three parts:
- `bounds(o)`: its box in the world, `{ cx, cy, w, h, rot }`, for framing;
- `fast(o)`: the time spans in which it moves fast, `[[start, end], ...]`, for motion blur;
- `draw(ctx, o, t, k)`: draw it at time `t`, in world units (the camera has already been applied). `k` is screen
  pixels per world unit, for what canvas measures in screen pixels: shadows (`shadow()`), and line widths that
  shouldn't scale with the zoom.

Keep `draw` a function of `t` alone, and make its `at` the moment it lands, hits or starts, so it can go on the
spoken word. `dropState()` gives any flat prop the drop and settle that prints and papers use; `seeded(hash(o.id))`
gives it its own fixed randomness.

## Speed

The slow frames are the blurred ones. When a whole render is too slow, look first at photos much larger than they
appear on screen, big soft shadows on many props at once, and many props drawn far outside the frame (skip a prop in
`draw` when its box is nowhere near the camera).
