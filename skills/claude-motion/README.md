# claude-motion skills (bundled)

Skills from [claude-motion](https://github.com/whaleyxbt/claude-motion), a motion design toolkit for coding agents
on [Remotion](https://remotion.dev):

- `motion-design`: taste rules with numbers (easing, springs, timing, type, colour, texture, transitions)
- `review-loop`: render a draft, look at contact sheets of its frames, fix, repeat
- `sound-design`: sound for a video with the toolkit's `sfx` engine (plain Python, no samples), mastered to −14 LUFS
- `web-sims`: simulations and 3D pieces as one web page, captured frame by frame to 60 fps video

Copied from [whaleyxbt/claude-motion](https://github.com/whaleyxbt/claude-motion) (`.claude/skills`) at commit
`e627941543d9988b155dc610bb9cc0115a5e365e` (MIT, see `LICENSE`). The files are unchanged.

The skills are written for working inside a copy of the toolkit: they run its npm scripts and use its files
(`timeline.json`, `src/lib.ts`, `sfx/`, `sims/`). The toolkit isn't part of the dashboard. The dashboard's own
**claude-motion** skill (`BUILTIN` in `server/skills.ts`) has the agent fetch it into the project at the commit above,
install it, keep it out of the project's git, and then follow these four as the copy has them, so they match its
scripts. The toolkit needs git, Node 20+, Python 3 and ffmpeg; Remotion has its own license (free
for individuals and small teams).

The dashboard adds each one to the skill library the first time it starts (`server/skills.ts`,
`ensureBuiltinSkills`). A skill the user deletes stays deleted. Each skill remembers where it came from, so
**Download again** on the Skills page brings it up to date from GitHub.

To update the copies here, replace these folders with the ones from a newer commit and change the commit above and
`CLAUDE_MOTION_COMMIT` in `server/skills.ts` (a test checks they match).
