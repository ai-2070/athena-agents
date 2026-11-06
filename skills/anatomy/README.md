# Anatomy skill (bundled)

[Anatomy](https://github.com/wheresryan22/anatomy) makes detailed, interactive isometric SVG figures that explain a
technical idea as a real physical object (a test rig, a dial gauge, a lock, a rocket engine), framework-free or in
React, with optional WebGL effects inside the drawing. It can also print a figure as an A4 PDF, and share one in
the Anatomy community gallery when the user asks.

Copied from [wheresryan22/anatomy](https://github.com/wheresryan22/anatomy) at commit
`1482e8469b0a9e0d8cc18ea2740a01423d29ae80` (MIT, see `anatomy/LICENSE`). The whole repo is the skill, so it sits in
`anatomy/`. The files are unchanged, but not all of them are here:

- Left out: the built example pages and PDFs (`examples/*/*.html` and `*.pdf`, 24 MB). Each example's `build.mjs`
  writes them again (`node examples/<name>/build.mjs`, `--light` for the light theme), which is what the skill
  tells the agent to do anyway.
- Left out: the hidden files (`.github/`, `.gitignore`, `.gitattributes`), as the skill installer does.

The skill needs Node.js 20.10+, and Chrome or Chromium for its checks. Its React examples go into the user's own
React or Next.js app.

The dashboard adds it to the skill library the first time it starts (`server/skills.ts`, `ensureBuiltinSkills`). A
skill the user deletes stays deleted, and a skill of the user's called `anatomy` stays theirs. It comes without a link
back to GitHub (`noLink`), so there's no **Download again**: the whole repo is over the installer's limits (10 MB a
skill, 2 MB a file), so downloading it again would fail. It updates with the dashboard instead: when this copy changes,
the next start replaces the library's copy, unless someone changed that one (the old one stays in its History).

To update the copy here, replace `anatomy/` with a newer commit's files, leaving out the same ones, and change the
commit above.
