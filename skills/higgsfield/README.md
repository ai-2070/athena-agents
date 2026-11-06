# Higgsfield skills (bundled)

Skills for [Higgsfield AI](https://higgsfield.ai), which generates images, video, 3D and audio, through its `higgsfield`
command line tool:

- `higgsfield-generate`: images, video, 3D models and audio from a prompt across its models, branded ad videos
  (Marketing Studio: avatars, products, UGC, unboxing, TV spots) and scoring a finished video's hook (Virality
  Predictor)
- `higgsfield-soul-id`: train a Soul Character, a reusable model of one person's face for `higgsfield-generate`
- `higgsfield-product-photoshoot`: product photos in ten modes (studio, lifestyle, Pinterest pin, hero banner, ad
  pack, virtual try-on…)
- `higgsfield-marketplace-cards`: marketplace listing images (main image, secondary images, A+ style modules)
- `higgsfield-brandkit`: a whole visual identity (palette, SVG logo marks, type, mockups, packaging, signage, decks)
  and a PPTX/PDF brandbook
- `higgsfield-youtube-thumbnail`: YouTube thumbnails and Shorts or Instagram video covers
- `higgsfield-faceless-video`: narrated explainers, documentaries, illustrated stories and children's music videos,
  assembled on this computer
- `higgsfield-video-explainer`: the old name of `higgsfield-faceless-video`, which it hands every request to
- `higgsfield-websites`: build and deploy websites, web apps and browser games on Higgsfield's hosting

Copied from [higgsfield-ai/skills](https://github.com/higgsfield-ai/skills) at commit
`27000402070db19d958789d05b3b52b6f4718d7c` (version 0.14.0; MIT, see `LICENSE`). The files are unchanged.

`higgsfield-video-explainer` is kept even though it only redirects: `higgsfield-generate` sends explainer requests to
it by that name, and its own description keeps it out of new requests. Not included: the repo's `setup` script, its
update check and plugin manifests (other ways of installing the same skills), and its evals and brand assets. The
Skills page's icon for these skills (`public/app-icons/higgsfield.png`) is the repo's `assets/icon.svg`.

The skills need the Higgsfield command line tool, which isn't part of the dashboard, and a Higgsfield account: every
generation spends the account's credits.
- **Install**: on macOS and Linux, `curl -fsSL https://raw.githubusercontent.com/higgsfield-ai/cli/main/install.sh
  | sh` (or `sh -s -- --prefix=$HOME/.local` without sudo). On Windows, download `hf_<version>_windows_amd64.tar.gz`
  from [its releases](https://github.com/higgsfield-ai/cli/releases), and put `hf.exe` on the PATH as
  `higgsfield.exe`: the skills call `higgsfield`.
- **Sign in**: the user runs `higgsfield auth login`, which opens a browser; `higgsfield account status` shows the
  account and its credits.
- `higgsfield-faceless-video` also needs FFmpeg, Python 3, `curl` and `awk`, and assembles the video with bash
  scripts: on Windows, that means Git Bash or WSL.

Claude Code agents can also reach Higgsfield through the connector on the user's Claude account, when it's signed in
there; these skills use the command line tool instead, so any agent with a shell can use them.

The dashboard adds each one to the skill library the first time it starts (`server/skills.ts`,
`ensureBuiltinSkills`). A skill the user deletes stays deleted. Each skill remembers where it came from, so
**Download again** on the Skills page brings it up to date from GitHub.

To update the copies here, replace these folders with the ones from a newer commit and change the commit above.
