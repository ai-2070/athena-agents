# Anatomy skill (bundled)

[Anatomy](https://github.com/wheresryan22/anatomy) makes detailed, interactive isometric SVG figures that explain a
technical idea as a real physical object (a test rig, a dial gauge, a lock, a rocket engine), framework-free or in
React, with optional WebGL effects inside the drawing. It can also print a figure as an A4 PDF, and share one in
the Anatomy community gallery when the user asks.

Copied from [wheresryan22/anatomy](https://github.com/wheresryan22/anatomy) at commit
`1482e8469b0a9e0d8cc18ea2740a01423d29ae80` (MIT, see `anatomy/LICENSE`). The whole repo is the skill, so it sits in
`anatomy/`. The files are unchanged, but not all of them are here:

- Left out: the built example pages and PDFs (`examples/*/*.html` and `*.pdf`, 24 MB). The kit's own scripts write
  them again, next to the script: `node examples/<name>/build.mjs` makes an example's page (`--light` for the light theme),
  `node examples/turning-dial/build.mjs --light --verify` makes `turning-dial-verify-light.html`,
  `node examples/turning-dial/stress.mjs --light` makes `turning-stress-light.html`, and
  `node scripts/print.mjs examples/<name>/sheet.mjs --format all` makes the A4 PDFs, once the page is built.
- The kit's own tests (`node --test scripts/`, from `anatomy/`) need one of those pages: `scripts/orbit-sampling.test.mjs`
  reads `turning-dial-verify-light.html`, so build it first, and delete it again before committing.
- Left out: the hidden files (`.github/`, `.gitignore`, `.gitattributes`), as the skill installer does. This repo's
  own `.gitattributes` keeps LF line endings in `skills/`, as upstream's did, so a Windows checkout has the same bytes
  (`scripts/fingerprint.mjs` hashes the kit, and publishing to the gallery compares that hash).

Agents read the examples rather than build them in the library: the skill's folder is shared by every project, so
`read_skill` tells them to put what its scripts make in the project instead. Their own figures are built there too.

The skill needs Node.js 20.10+, and Chrome or Chromium for its checks. Its React examples go into the user's own
React or Next.js app.

The dashboard adds it to the skill library the first time it starts (`server/skills.ts`, `ensureBuiltinSkills`). A
skill the user deletes stays deleted, and a skill of the user's called `anatomy` stays theirs. It comes without a link
back to GitHub (`noLink`), so there's no **Download again**: the whole repo is over the installer's limits (10 MB a
skill, 2 MB a file), so downloading it again would fail. It updates with the dashboard instead: when this copy changes,
the next start replaces the library's copy, unless someone changed that one (the old one stays in its History).

To update the copy here, replace `anatomy/` with a newer commit's files, leaving out the same ones, and change the
commit above.
