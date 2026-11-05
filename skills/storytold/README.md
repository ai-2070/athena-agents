# Storytold skills (bundled)

Skills for the [storytold Crafting Apps](https://github.com/storytold): seventeen free creative apps
(VectorCraft, PhotoCraft, FilmCraft, …, and SolidCraft from [Tangency Labs](https://github.com/tangency-labs/solidcraft)),
each with a desktop app, a CLI and an MCP server. There is one
skill per app, plus `storytold` (which app fits a task) and `storytold-install` (install the apps and
wire up their MCP servers).

Copied from [hermes-pro/storytold-skills](https://github.com/hermes-pro/storytold-skills) at commit
`7cd83887800508c3f6f0dd1efa2fc7601b3753ca` (MIT, see `LICENSE`). The files are unchanged.

The dashboard adds each one to the skill library the first time it starts (`server/skills.ts`,
`ensureBuiltinSkills`). A skill the user deletes stays deleted. Each skill remembers where it came from, so
**Download again** on the Skills page brings it up to date from GitHub.

To update the copies here, replace these folders with the ones from a newer commit and change the commit above.
