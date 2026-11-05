# Cua skills (bundled)

Skills for [Cua](https://github.com/trycua/cua), which gives agents eyes and hands on a computer:

- `cua-driver` (in `driver/`): see and use the apps on this computer (read a window, click, type, menus),
  mostly in the background, with the `cua-driver` command or its MCP server
- `cua-sandboxes` (in `cli/`): make, use and delete disposable Linux or macOS computers (containers or VMs on
  this machine) with the `cua` command, and browse the web inside one
- `gui-automation` (in `cli/`): look, click, type and check again on a sandbox's screen (or this computer's) with
  `cua do`

Copied from [trycua/cua](https://github.com/trycua/cua) at commit
`23404c7f51ed6b9f15e5fc953ddc8ae555bae0bb` (MIT, see `LICENSE`): `cli/` holds `libs/cua/skills` and `driver/`
holds `libs/cua-driver/rust/Skills`. The files are unchanged.

The skills need Cua's command line tools, which aren't part of the dashboard: `cua-driver` for the first, `cua`
for the other two. The matching ready-made MCP servers are **Control this computer (Cua Driver)** and
**Sandbox computers (Cua)** in Settings › MCP servers (`server/mcp.ts`).

Not included: `cua-spaces` and `cua-volume` (Cua Spaces only, under FSL-1.1-MIT), the older copy of
`cua-driver` in `libs/cua/skills`, `jev-use` (needs Cua's TypeSafe Jev), and the repo's own tooling skills.
`skills/gui-automation` at the repo's top is the same file as the one in `libs/cua/skills`.

The dashboard adds each one to the skill library the first time it starts (`server/skills.ts`,
`ensureBuiltinSkills`). A skill the user deletes stays deleted. Each skill remembers where it came from, so
**Download again** on the Skills page brings it up to date from GitHub.

To update the copies here, replace these folders with the ones from a newer commit and change the commit above.
