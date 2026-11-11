# Hermes skills: rewrite them as Athena's own

4 November 2026. The user answered the open questions the same day (see [Settled](#settled)).

## Status (4 November, end of day)

**30 of the 39 skills are written and ship; `skills/hermes/` is deleted.** Nine are skipped for now (below), and the
review pass that the five samples had was skipped for the other 25.

Done:

- **Step 1:** `skills/athena/` with its standard (`README.md`), `replaced.json` (where each of the 51 went), the format checks in `tests/server/athena-skills.test.ts`, the script
  tests in `tests/skills/` (about 750, Python 3.10) and a "Skill scripts" CI job on Linux and Windows.
- **The 5 samples**, written, tried, reviewed and fixed: systematic-debugging, pdf, financial-models, humanizer, comfyui.
  In blind trials (two real tasks each, Claude Code on Sonnet, old skills against new, judged with the run folders'
  names masked) **the new skills won 9 of 10**: pdf, humanizer, financial-models and comfyui won both their tasks,
  systematic-debugging split one-one. What the trials and the two reviewers taught went into the README's standard.
- **25 more, written to the updated standard**, each passing the format checks and its own script tests:
  - coding: test-driven-development, spike, requesting-code-review, github, dogfood, ast-grep, grill-me,
    rest-graphql-debug, docker-management, jupyter-notebook, fastmcp (with mcporter);
  - documents and finance: docx, xlsx, powerpoint (the three copy financial-models' LibreOffice helper), stocks;
  - research: arxiv, grounded-citations, llm-wiki, rss-feeds (with reddit-reading), youtube-content, maps;
  - everyday work: email (with email-inbox-triage and himalaya), action-items, weekly-review-planning, decisions.
- **The switch (step 2):** `BUNDLED` ships `skills/athena` (private, no link back) in place of the Hermes copies, and
  `skills/hermes/` is deleted. No migration: the dashboard is pre-release, so copies already in a library are left as
  they are (decided after the PR opened; the update-on-start code that was written for it was removed).
- **Follow-ups done:** the dashboard's ComfyUI tools (pictures and masks with a run, `node_errors` in a 200 answer, 3D
  outputs, prompts in SDXL, Flux, SD3 and BasicGuider graphs, V3 inputs and subgraphs in the editor-format converter,
  the new Comfy Desktop's folders and ports, what `comfyui_start` does when Desktop won't launch a server);
  `PYTHONUTF8=1` in the shell tool; a note on the Connections page that Reddit reviews new apps since November 2025.

Skipped for now:

- **Nine skills not written yet**, so they don't ship until they are: **obsidian**, and the creative ones
  **design-md**, **concept-diagrams** (taking in architecture-diagram), **excalidraw**, **sketch**, **p5js**,
  **manim-video**, **pixel-art** and **hyperframes**. Their audits are in this plan's list. People who already have the
  Hermes copies keep them (nothing removes a skill from a library); new installs don't get them. The format test
  fails any shipped skill that names one of these in backticks.
- **The batch reviews**: the second agent that checked the samples' text and scripts against the standard and the
  facts (and found real bugs in the samples' scripts) didn't run for the 25 later skills, and they weren't tried
  against the old ones. Each passed the mechanical checks and its own tests; the writers checked facts against current
  docs and package sources and listed what they couldn't confirm.
- **Windows runs**: the scripts' Windows-only paths (jupyter-notebook's kernel launch and interrupt, the LibreOffice
  helper's Windows lookup, PowerShell quoting in the skills' commands) haven't run on Windows; the "Skill scripts" CI
  job is their first test there.

## In short

The dashboard ships 51 skills copied unchanged from NousResearch/hermes-agent (`skills/hermes/`). They were written for
Hermes: its tool names, its folders, a bash shell, and a 60-character description. Many are out of date, a few have
bugs that break the result, and a few act without asking or get around a site's terms. We rewrite them to our own
standard into a new folder, `skills/athena/<id>/`, so they work on every engine and on Windows. At the end `skills/hermes/`
is deleted.

Where skills overlap they merge, and one is cut, so **51 become 39**. Ids stay
the same wherever a skill survives, because the agent library's files (being rewritten in parallel on `LZL0/skills`),
people's agents, teams and routines all name skills by id.

Decided with the user:

| Question                 | Answer                                                                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape                    | One folder per skill, as today: `SKILL.md` plus reference files and scripts. Same ids where a skill survives                                                                 |
| Where                    | `skills/athena/<id>/`, flat. `skills/hermes/` stays unchanged until the switch, then is deleted                                                                              |
| Merges                   | All seven: finance 6 → 1, action items 2 → 1, email 2 → 1, decisions 2 → 1, mcporter into fastmcp, architecture-diagram into concept-diagrams, reddit-reading into rss-feeds |
| Cuts                     | duckduckgo-search only. stocks is rebuilt on official and keyed sources, jupyter-notebook on Jupyter's own client; youtube-content stays, with a terms note                  |
| Scripts                  | **Every script is written fresh.** The old ones are a description of what's needed, not code to carry over. Each new script has tests, run in CI on Linux and Windows        |
| Copies already installed | Replaced if the user hasn't changed them; the old version stays in the skill's History. Changed copies, and copies of ids that go away, are left alone                       |
| Link back                | None. The repo is private, so these come without "from …" or **Download again**, like the subagent skills                                                                    |
| Review                   | 5 samples first for the user to approve the style, then batches. A second agent checks each batch and the user skims it                                                      |

## What's wrong with the current skills

Four reviewers read every file of the 51 (33,796 lines of Markdown, 76 Python scripts, 10 shell scripts) and checked
the load-bearing facts against current docs, package sources and live requests.

- **Written for Hermes.** About 300 lines name Hermes's own tools (`terminal` 90, `execute_code` 32, `web_extract` 30,
  `search_files` 24, `write_file` 21, `read_file` 20, `browser_exec` 19, `web_search` 15, `patch` 13, `delegate_task` 13,
  `vision_analyze` 12). Others use `~/.hermes/…`, `$HERMES_HOME`, Hermes's package manager, or a `HermesAgent/1.0`
  User-Agent sent to other people's servers. 19 links point at skills we don't ship. `read_skill` rewrites two Hermes
  paths, but can't fix the rest (github's scripts point at an old folder that doesn't exist even in Hermes).
- **Descriptions too short to choose from.** Hermes caps them at 60 characters ("4-phase root cause debugging: understand
  bugs before fixing."). Our agents decide whether to open a skill from its description alone.
- **Broken on Windows.** The dashboard's shell tool is Windows PowerShell 5.1, non-interactive, with a 300-second limit:
  `curl` is `Invoke-WebRequest`, `&&` doesn't exist, quotes inside native arguments are stripped, and `-it`, `logs -f`,
  server starts and browser sign-ins hang. The skills assume bash throughout (heredocs, `python3`, `mkdir -p`,
  `command -v`), 10 scripts are bash, Python scripts print non-ASCII text without switching to UTF-8 (a crash on a
  cp1252 pipe), and the Office skills don't look for LibreOffice where Windows installs it.
- **Out of date.** p5.js is on 2.x (most of the skill's examples break), Manim CE 0.22 (seven examples raise errors or do
  nothing), FastMCP 4, Himalaya 2 (new config and commands), HyperFrames 0.9, ast-grep 0.51, design.md 0.4, comfy-cli
  1.25. Docker 23 changed what `prune` removes. `gh repo edit --visibility` needs a new flag. The humanizer's upstream is
  at 3.1 and fixed the bad advice ours still has.
- **Bugs, reproduced or read in the code.** arXiv multi-word searches run as OR (533,277 hits, none about the query).
  Maps returns car routes for walking and cycling, and garbage timezone offsets. `pdf_fill_form --flatten` doesn't
  flatten. RSS `discover` prints guessed URLs as feeds. Every bundled ComfyUI workflow carries a `_comment` key that
  `/prompt` rejects. The finance skills' sample formulas give `#REF!` or aren't valid.
- **Acts without asking.** requesting-code-review commits with `git add -A`. github merges, approves, closes issues in
  bulk and pushes CI fixes on a loop. test-driven-development tells the agent to delete code written before its test.
  jupyter-notebook turns off Jupyter's sign-in. comfyui installs custom nodes (other people's code). nano-pdf (in the pdf
  skill) uploads pages to a paid AI service and replaces them with generated images.
- **Gets around a site's terms.** duckduckgo-search scrapes several search engines' result pages ("for educational
  purposes only", per the package). stocks collects Yahoo's anti-scraping cookie and crumb. youtube-content uses an
  undocumented endpoint whose library suggests rotating residential proxies.
- **Invented numbers and contradictions.** The finance skills are full of "typical" ranges and contradict themselves
  (three terminal-value thresholds; a comps example where EBITDA margin beats gross margin). The humanizer's "after"
  examples add facts that weren't in the "before", the worst habit a humanizer can teach. The 3-statement model credits
  stock compensation to retained earnings.
- **Too long, and the same thing several times.** dcf-model's SKILL.md is 1,270 lines and the agent reads all of it on
  every use. The superpowers-derived skills (debugging, TDD, code review) are about half persuasion: Iron Laws, excuse
  tables, made-up impact statistics.

What's good, and sets the bar for the new scripts: the Office and PDF scripts (argparse, JSON out, about 86 tests;
`xlsx_restructure.py` shifts formulas, names, merges and tables correctly, tested), the citation ledger (`sources.py`),
the feed reader and the pixel-art pipeline. The rewrites keep their features and their honest lists of what isn't
handled, and a lot of real know-how from the text as topics.

## The new standard

The full version goes into `skills/athena/README.md`, so whoever writes or edits one of these skills later follows it.
It shares its rules with the agent library's (`library/athena-agents/README.md` on `LZL0/skills`): no invented numbers,
no tool names that might not exist, facts checked, fresh text, nothing about the model's limits.

### Frontmatter

`parseFrontmatter` reads one `key: value` per line. Two keys only:

```markdown
---
name: Systematic debugging
description: Use when a bug, failing test or wrong output needs fixing and the cause isn't known yet. Builds a check that fails on the bug before any fix, finds the cause, then proves the fix.
---
```

| Key           | What it's for                                                                                                                                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`        | Sentence case, plain words ("Systematic debugging", "PDF files"). The Skills page and the agent's list show it                                                                                                                      |
| `description` | **When to use it** first, then what it does; at most about 300 characters. Every agent with the skill reads it on every message and decides from it alone whether to open the skill, so it names the situations, not just the topic |

The id is the folder name.

### SKILL.md

40 to 250 lines; most land between 100 and 160. The agent reads all of it each time it opens the skill, so it holds what's
needed on every use and depth goes into reference files.

- **Opening paragraph (no heading).** What it's for and what good work looks like.
- **Before you start.** What it needs (programs, Python packages, keys, an account) and how to check. Installing or
  signing in is the user's call: the agent asks first.
- **How to do it well.** The judgment: what an expert weighs, trade-offs, rules of thumb. Most of the value.
- **Steps**, only where the order matters (back up before editing, check before sending).
- **Done means.** How to check the result before handing it in.
- **Watch out for.** The usual ways it goes wrong.
- **Files.** One line per reference file and script: what it holds and when to open or run it. Every file in the folder
  is named here; a file nothing points to is deleted.

Headings are a guide, not a form.

### Rules for every skill

1. **Tool-neutral.** The same text runs on Claude Code, Codex, Hermes, Eve and pi, and the dashboard tells every agent its
   real tools. So: "run it in a shell", "fetch the page", "search the code", "if you can start a helper agent". Real
   programs (`git`, `gh`, `python`, `ffmpeg`, `npx`) are fine. Where a dashboard tool group does the job (ComfyUI, media,
   social, programs), the skill says so in plain words.
2. **Works on Windows, macOS and Linux.** Scripts are Python or Node, never `.sh`. Commands that differ are given for
   PowerShell and for a POSIX shell, or avoided. For the PowerShell 5.1 shell: JSON, code and message bodies go in files
   (`--body-file`, `--data-binary @file`, rule files), `curl.exe` not `curl`, long-running servers start in the
   background (the programs tools or `Start-Process`), nothing interactive. Paths come from the workspace, never `/tmp`.
3. **No invented numbers.** A number appears only when it's a real standard, limit or convention, correct and current.
   Taste is written as a default with its reason, not as a law.
4. **Facts that change get checked** when written: library calls, CLI flags, endpoints and their limits, site rules.
   Code examples are checked against the current package (its type definitions or source), or run. Each batch's review
   lists what was checked and where. What can't be confirmed is left out.
5. **Judgment over ritual.** No ALL-CAPS laws or excuse tables. Say why a practice matters; firm wording is kept for
   what's risky.
6. **Safety.** Anything that deletes, sends, posts, publishes, merges, spends, uploads or signs in asks the user first,
   and the skill says where. Commits only when asked, staging named files. Nothing that gets around a site's
   protections or terms; requests identify the dashboard honestly and keep to the service's published limits.
7. **Names only skills that ship**, by id.
8. **Nothing about the model's limits** ("you can't see images"): what an agent can do comes from its tools.
9. **Fresh text.** The old skills are topics and know-how, not text to copy. Credit goes in the README.

### Scripts

Written fresh. A writer reads the old script for what it does and what it gets wrong, then writes a new one; no code is
copied.

- Python 3.10 or newer (Node where the field is JavaScript), standard library plus named packages. Each script names its
  packages at the top and prints a one-line install hint when one is missing.
- A command-line program with `--help`; switches its output to UTF-8 first thing; prints JSON when the result is data;
  exits non-zero on failure.
- Writes only to the output path it's given, and never over its input unless asked (`-o` required, or a new file by
  default).
- Calls the network only for the service the skill is about, with an honest User-Agent (`AthenaAgents/<version>`).
- A helper several skills need (finding LibreOffice, converting and recalculating) is copied into each one, and a test
  checks the copies are identical, because an agent reads only the skills it has.
- Every script has pytest tests in `tests/skills/<id>/`, outside the skill folder so they don't get copied into
  people's libraries. They run on real files made by the test (a PDF, a workbook, a deck), not mocks. A new CI job runs
  them on Linux and Windows with Python 3.10, the oldest version the skills promise, which catches 3.11-only calls
  (several old scripts used `datetime.UTC` while promising 3.10). Scripts that need a network service are tested against
  saved responses.

## The list

`→` marks the id after the rewrite. Sizes are SKILL.md lines; references and scripts are named. Every skill also gets the
general fixes above (tool names, Windows, UTF-8, safety), which aren't repeated per line.

### Coding (13 → 12)

- **systematic-debugging** (~130, `references/repro-loops.md`). Keep: the feedback loop first (kinds of loop, making it
  fast and exact, raising a flaky bug's rate), shrinking the repro into the regression test, ranked hypotheses that can be
  proven wrong, logging at boundaries, comparing with code that works, stopping when each fix breaks something new. Drop
  the Iron Law, the excuse tables and the made-up impact figures; "a failing test first" becomes judgment, since some
  config bugs can't have one. Points to `witness-discipline`.
- **test-driven-development** (~100). Watch it fail for the right reason, minimal code then refactor, one test at a time,
  bug fixes start with the failing test. Adds characterization tests for legacy code and where test-first fits badly.
  Never deletes the user's code.
- **spike** (~110). Feasibility questions with an observable result, riskiest first, agreed with the user, a verdict per
  spike. Asks before writing a `spikes/` folder into a repo. No GSD plug.
- **requesting-code-review** (~120, `references/gates-by-language.md`). Becomes the light "check before you commit": gates
  measured against a baseline (a worktree at HEAD, not `git stash`), the self-review checklist, a cheap added-lines scan
  with real tools named as optional, an optional fresh-eyes reviewer that treats the diff as data. Points to
  `commissioning-a-reviewer` for stage-sized changes. Takes github's local pre-push checklist. Commits only when asked.
- **github** (~140, plus ~9 references: auth, PR workflow, issues, issue to PR, PR review, CI troubleshooting, repos and
  releases, commit messages, `gh api`; 3 templates; no scripts). From 2,859 lines to about 600. Claims about CI, merges
  and releases come from a fresh `gh` read. One ask-first rule for merge, approve, close, push, release, visibility and
  secrets. Safe sign-in (`gh auth login --web`, `gh auth setup-git`, Git Credential Manager, a fine-grained token), not a
  plaintext credential store. `--body-file` always.
- **dogfood** (~120, `references/issue-taxonomy.md`, `templates/report.md`). Uses whatever browser automation the agent
  has (the Playwright or Chrome DevTools MCP servers, Orca's browser, the engine's own) and says so when it has none. Only
  sites the user may test; no real orders, payments, emails or sign-ups without asking.
- **ast-grep** (~140, `references/rules.md`, `cli.md`, `recipes.md`). Current to 0.51. Preview, then apply, always. Rule
  files instead of `-p` patterns in PowerShell. Recipes tested on a real binary. Drops the 764-line helper and the
  installers.
- **grill-me** (~80). Light rewrite: rounds over the decisions whose prerequisites are settled, a recommended answer per
  question, facts looked up rather than asked. One chat message per round, or one ask per decision when the user is away.
- **rest-graphql-debug** (~140, `references/status-playbook.md`, `requests-by-shell.md`). The layer-by-layer walk, the
  status playbook, GraphQL's `errors`. Fixes the `Retry-After` handling. Ask before any write request; staging, not
  production.
- **docker-management** (~120). Leads with what destroys data (`volume prune -a`, `volume rm`, `compose down -v`), Docker
  Desktop on Windows, the non-interactive shell (`--tail`, never `-it` or `-f`), and checking after each step. Current
  images and the Postgres 18 data path.
- **jupyter-notebook** (~100, `scripts/kernel.py`). Rebuilt on Jupyter's own pieces: `jupyter kernel` started in the
  background, a small client of our own on `jupyter_client` (BSD), `nbconvert --execute` for the top-to-bottom check. No
  web server with its sign-in turned off, no unlicensed third-party script.
- **fastmcp** (~150, `references/fastmcp-cli.md`, `calling-servers.md`, 3 templates). Current to FastMCP 4. Takes in
  **mcporter** as `calling-servers.md`. Installing a server means adding it on the dashboard's MCP page; writing other
  apps' configs or running unvetted `npx -y` servers asks first. The file-processor template gets an allowed-folder check.
- ~~mcporter~~ → fastmcp.

### Documents and finance (11 → 6)

- **pdf** (~150, `references/forms.md`, `extraction-and-ocr.md`, `archival-and-security.md`; new scripts to create,
  read, fill and build forms, merge, split, stamp, secure and render pages). Flattening that flattens, text escaped; local OCR (Tesseract, ocrmypdf) next to marker, with marker's `--use_llm` (sends pages to
  Gemini) and its model licence named. nano-pdf goes. Says when Storytold's pdfcraft (an installed app) is the better route.
- **docx** (~130, `references/revisions-and-comments.md`, `create-spec.md`; new scripts to create, read, edit, fill templates,
  and handle tracked changes and comments). Edits write a new file by default. Finds LibreOffice on Windows; Word itself when installed.
- **xlsx** (~150, `references/restructuring.md`, `create-spec.md`; new scripts to create, read, edit, convert CSV, and
  insert or delete rows and columns without breaking references). One recalculate-and-check script (finds LibreOffice,
  throwaway profile, scans every cell for errors) replaces three. Notes that restructuring leaves chart ranges
  behind.
- **powerpoint** (~140, `references/deck-spec.md`, `editing-internals.md`; new scripts to create, read, edit, fill templates and
  render). Text in grouped shapes, rendering
  with pypdfium2 instead of poppler, and what makes a good slide. Renders every slide and looks at it.
- **financial-models** (new, ~180; `references/conventions.md`, `dcf.md`, `lbo.md`, `three-statement.md`, `comps.md`,
  `merger.md`, `filings.md`; the shared recalc script). Replaces **excel-author, dcf-model, lbo-model,
  3-statement-model, comps-analysis, merger-model**. Formulas, never typed results; inputs blue with a dated source; a
  Checks sheet; sensitivity grids whose centre equals the model. Fixes the accounting errors, drops the invented ranges,
  and works from scratch, since the example workbooks the old skills require don't exist even upstream. Filings through
  SEC EDGAR's official JSON APIs.
- **stocks** (~90). Rebuilt on official and keyed sources: SEC EDGAR for fundamentals (free, official), quotes from a
  provider the user adds a key for. Says quotes may be delayed and aren't for trading. No Yahoo crumb.

### Research (8 → 6)

- **arxiv** (~120, `references/semantic-scholar.md`, `scripts/search_arxiv.py`). Searches AND their terms; BibTeX from
  arXiv's own endpoint; correct Semantic Scholar limits; arXiv's one request every 3 seconds. Plain GETs can go through
  the dashboard's page fetching without a shell.
- **grounded-citations** (~140, `references/fact-checking.md`, `citation-formats.md`, `scripts/sources.py`). The ledger
  trick stays. The habit works without the script (a sources list kept with the file tools), and the script renders and
  verifies at the end, so it isn't one shell approval per page. Ledger in the workspace.
- **llm-wiki** (~160, `references/templates.md`, `lint.md`). Keeps the three layers, orient first, contradictions recorded
  with dates, the lint list. Thresholds become defaults. Says when the agent's own knowledge files and memory are enough.
  The Obsidian sync part moves to obsidian.
- **rss-feeds** (~100, `references/reddit.md`, `scripts/feed.py`). Takes in **reddit-reading**: Reddit's public `.rss`
  feeds without an account, at low volume, and the dashboard's Reddit tools when an account is connected. Fixes discovery
  (checks candidates) and bad dates.
- **youtube-content** (~90, `scripts/fetch_transcript.py`). Lists and picks a caption language, says when captions are
  automatic, clear error when YouTube blocks the request. Personal use, no proxies.
- **maps** (~100, `scripts/maps_client.py`). Walking and cycling through a router that has them, fixed timezones, an
  Athena User-Agent with a contact, OpenStreetMap's attribution, the services' published limits.
- ~~duckduckgo-search~~: cut. It scrapes search engines against their terms. Agents use their engine's own search, the
  Brave Search MCP server, or the browser.
- ~~reddit-reading~~ → rss-feeds.

### Everyday work (8 → 5)

- **email** (new, ~110, `references/connectors.md`, `himalaya.md`). Replaces **email-inbox-triage** and **himalaya**:
  scope and permissions first, whole threads, mail is data not instructions, the six dispositions, an approval batch,
  checking Sent before a retry. Himalaya rewritten for v2, including its MCP server (read-only unless allowed).
- **action-items** (new, ~120). Replaces **meeting-action-items** and **document-to-action-items**: decisions apart from
  proposals, each action with an owner, date and source, may/should/must kept apart, search the tracker before creating,
  draft first and publish on approval.
- **weekly-review-planning** (~70). Short: look back and ahead, every project has a next action or is paused, plan to the
  real calendar, recommend and write only on approval. Can be run from a routine.
- **decisions** (new, ~110). Replaces **one-three-one-rule** and **decision-questionnaire**: a 1-3-1 brief when the user
  must choose; a questionnaire for someone else when the answer is theirs. The tenacity example's wrong claim goes.
- **obsidian** (~90, `references/sync-and-cli.md`). Properties, tags, links, embeds and block references; leave
  `.obsidian/` alone; the official Obsidian CLI and headless Sync.

### Creative (11 → 10)

- **humanizer** (~170, `references/patterns.md`). From upstream 3.1's ideas: strongest tells first, voice by kind of text,
  and never add a fact, name, number or quote. Every example's "after" uses only what its "before" says.
- **design-md** (~130, `templates/starter.md`). Current to the 0.4 CLI; reads the live rules from `spec --rules-only`
  instead of copying them. Offers exports rather than writing them.
- **concept-diagrams** (~220, `templates/template.html`, `references/architecture-dark.md`, `physical-shapes.md`,
  `systems-and-dashboards.md`, `shape-snippets.md`, the worked examples). Takes in **architecture-diagram** as a dark
  theme. Fixes the dark-mode text bug and makes its own rules match its own examples.
- **excalidraw** (~140, `references/examples.md`, `colors.md`, `scripts/upload.py`). Current font and bindings. Uploading
  for a share link asks first.
- **sketch** (~130). Tailwind 4's browser build, no dead GSD dependency, asks before writing into a repo. Says when
  Storytold's figcraft (editable designs) is the better choice.
- **p5js** (~200; `references/api-2x.md`, `techniques.md`, `color-and-composition.md`, `motion.md`,
  `webgl-and-shaders.md`, `audio.md`, `export.md`; `scripts/capture.mjs`, `templates/viewer.html`). For p5.js 2.x, the
  version pinned in one place. Frame capture with the Edge or Chrome already installed.
- **manim-video** (~170; `references/design-and-pacing.md`, `api-cookbook.md`, `equations.md`, `graphs-and-data.md`,
  `camera-and-3d.md`, `paper-explainer.md`, `narration.md`, `troubleshooting.md`). For Manim CE 0.22: every example
  checked against its source, Typst as the no-LaTeX route on Windows, paid voices ask first.
- **pixel-art** (~120, `references/palettes.md`, 3 scripts). Fixes the palette padding, odd video sizes and particle
  scale; an ImageMagick-only route with the dashboard's media tools.
- **hyperframes** (~140; `references/composition.md`, `features.md`, `troubleshooting.md`). A thin, current layer over the
  0.9 CLI that defers to the skills its own `init` installs. Publishing to HeyGen asks first.
- **comfyui** (~140; `references/workflow-format.md`, `setup-and-deps.md`, `api.md`, `scripts/check_deps.py`). Starts from
  the dashboard's ComfyUI tools and adds only what they leave out: input images and masks, reading `node_errors`, finding
  missing nodes and models (installing custom nodes asks first: they're code), install choices on Windows, Comfy Cloud
  as a paid option that asks first. Drops about 10 scripts and the broken workflow files.
- ~~architecture-diagram~~ → concept-diagrams.

### Ids that go away

16 ids, and where each went. People who already have these keep their copies, which go on working; new installs don't
get them.

| Old id                                                                              | Now              |
| ----------------------------------------------------------------------------------- | ---------------- |
| excel-author, dcf-model, lbo-model, 3-statement-model, comps-analysis, merger-model | financial-models |
| email-inbox-triage, himalaya                                                        | email            |
| meeting-action-items, document-to-action-items                                      | action-items     |
| one-three-one-rule, decision-questionnaire                                          | decisions        |
| mcporter                                                                            | fastmcp          |
| architecture-diagram                                                                | concept-diagrams |
| reddit-reading                                                                      | rss-feeds        |
| duckduckgo-search                                                                   | cut              |

The agent library's writers on `LZL0/skills` list 10 of these ids (excel-author, 3-statement-model, dcf-model,
comps-analysis, reddit-reading, duckduckgo-search, meeting-action-items, one-three-one-rule, decision-questionnaire,
architecture-diagram). Once the list is settled, that session gets this table, and whichever branch merges second
updates the agent files so its test (every skill an agent names exists) passes.

## How the writing goes

1. **The plan is approved.**
2. **The new folder and its checks** (step 1 below).
3. **5 samples** across very different kinds of skill: systematic-debugging (method, half boilerplate today), pdf
   (scripts kept and fixed), financial-models (six long skills into one), humanizer (writing), comfyui (shrunk onto the
   dashboard's own tools). Each gets two tasks, run through Claude Code (Sonnet) once with the old skills and once with
   the new, in a throwaway folder: the run sees a "Your skills" list the way the dashboard writes it (all five samples'
   skills plus three unrelated ones), opens a skill by reading its SKILL.md, and may run only Python and read-only git.
   No task names a skill, so the runs also show whether the description gets it opened. A script checks what each run
   made (the filled form, the merged PDF, the workbook after recalculating), and a judge compares each pair blind. The
   user sees the results and the files and says what to change; then the standard is fixed in the README.
4. **Batches**, in this order: coding (11 left), documents (docx, xlsx, powerpoint, stocks), research (6), everyday work
   (5), creative (two batches). For each batch:
   - one writer subagent per skill, all at once. Each gets the standard, the old skill's files as topics, the reviewer's
     audit of it, and the rule to check facts against current docs and package sources. Writers with scripts write them
     fresh with their tests, and run both in a throwaway Python 3.10 environment under the scratch folder;
   - one reviewer subagent per batch, checking every skill against the rules and the facts, and listing anything that
     acts without asking;
   - I fix what it found, run `bun run check`, and commit. The user skims the batch.
5. **The switch** (step 2) once all are in.

## Code changes

Until the switch, `skills/athena/` is read only by its tests: the Hermes skills keep shipping as they are.

### Step 1: the new folder and its checks

- `skills/athena/`: one folder per skill, and `README.md` (the standard, where each of the 51 went, the credit). Nothing
  upstream is copied, text or code, so no upstream licence travels with the files; Hermes's MIT `LICENSE` is kept as
  `LICENSE-hermes-agent` all the same, as the agent library keeps The Agency's, since the list and the topics came from
  there. The README also credits the skills' own sources (obra/superpowers, blader/humanizer, anthropics/financial-services,
  mattpocock/skills and the others named in the old frontmatter).
- `tests/server/athena-skills.test.ts` (see Tests).
- `tests/skills/`: the scripts' pytest tests, a `requirements.txt` with the packages they need, and a `conftest.py` that
  makes each test's files in a temp folder.
- `.github/workflows/ci.yml`: a "Skill scripts" job on ubuntu and windows: Python 3.10, `pip install -r
tests/skills/requirements.txt`, `python -m pytest tests/skills`.

### Step 2: the switch

One commit, once all are written:

- `server/skills.ts`: in `BUNDLED`, `{ dir: 'athena', …, private: true }` replaces the Hermes entry, so the skills come
  without a link back. `nested` goes if nothing else uses it.
- `server/skills.ts`, `ensureBuiltinSkills`: **bring untouched copies up to date.** `.builtin.json` also records the hash
  of each Athena skill's SKILL.md as it was added. On start, a copy whose SKILL.md still has the recorded hash, or the hash
  of the Hermes version we shipped (a list of 51, made from git before `skills/hermes/` is deleted), is replaced by the new
  version; its old text stays in the skill's History (`keepVersion`), and a `.source.json` pointing at NousResearch is
  removed. A copy the user changed or downloaded again stays as it is. Copies of ids that went away are left alone. This
  also means later edits to these skills reach people who haven't changed their copy.
- `server/tools.ts`: `read_skill`'s Hermes path rewriting stays, for Hermes skills people install from GitHub themselves.
- Delete `skills/hermes/`.
- `scripts/build-desktop.ts` copies all of `skills/`, so nothing changes there; `bun run desktop:smoke` confirms it.

## Tests

- `tests/server/athena-skills.test.ts` (step 1):
  - every folder has a SKILL.md with only `name` and `description`, a sentence-case name, and a description of 60 to 300
    characters;
  - SKILL.md is 40 to 250 lines;
  - every other file in the folder is named in SKILL.md or in a reference it names; no `.sh` files, no `tests/` folders;
  - no Hermes tool names or paths (`terminal(`, `execute_code`, `web_extract`, `delegate_task`, `vision_analyze`,
    `skill_view`, `browser_exec`, `~/.hermes`, `HERMES_`), no "Hermes" outside the hermes engine's own mentions;
  - any skill named in backticks as an id ships (Athena's, the other bundles, or built-in);
  - none of the old template's tells: an "Iron Law", ALL-CAPS MUST/NEVER runs, "Violating the letter";
  - every script has a test folder in `tests/skills/`, and the shared helper's copies are identical;
  - the ids are the planned list.
- At the switch, `tests/server/bundled-skills.test.ts`: the count (85 becomes 73), no Hermes origins, the private
  bundle has no link back; and new cases for bringing an untouched copy up to date (old text in History, link removed),
  leaving a changed copy alone, and leaving a gone id alone.

## Words to update

- `docs/guide.md` (the Hermes skills paragraph at line 214 and the `read_skill` note at 218) and `README.md` where it
  describes the skills that come with the dashboard.
- `AGENTS.md`: the `skills/` row (`hermes` and `nested` become `athena`).

## Commits

Each passes `bun run check` on its own.

1. `Plans: rewrite the Hermes skills as Athena's own`
2. `Skills: a new folder for the rewritten skills, with checks on how each is written`
3. `Skills: five rewritten skills to settle the style`
4. One per batch (`Skills: rewrite the coding skills`…)
5. `Skills: switch to Athena's skills and retire the Hermes copies`

## Settled

Answered on 4 November: all seven merges (39 skills, new ids `financial-models`, `email`, `action-items`, `decisions`);
only duckduckgo-search is cut, so stocks and jupyter-notebook are rebuilt and youtube-content stays; every script is
written fresh, with tests in CI; untouched installed copies are brought up to date.

Follow-ups noticed on the way, not part of this plan:

- Done in this branch: the ComfyUI tools, `PYTHONUTF8=1`, and the Reddit note (see Status).
- **Himalaya's MCP server** (`himalaya mcp`) isn't in any release yet (2.2.1 has no such command; it's in Himalaya's
  development version). It was added to the MCP catalogue and taken out again; add it when a release ships it.
- **The Programs page doesn't show ComfyUI's `node_errors`** (the run tool reports them; `server/index.ts` doesn't pass
  them on).
- **`www.sec.gov` refuses the dashboard's page reader**, which sends no contact in its User-Agent (`data.sec.gov`
  answers). A User-Agent with the user's contact would let agents read filings pages without a shell.
- **The agent library being rewritten on `LZL0/skills`** names ten skill ids that are gone (excel-author,
  3-statement-model, dcf-model, comps-analysis, reddit-reading, duckduckgo-search, meeting-action-items,
  one-three-one-rule, decision-questionnaire, architecture-diagram; see "Ids that go away") and some of the nine
  skipped ones. Whichever branch merges second updates the agent files.
- **maps uses the public Nominatim**, whose usage policy has clauses about AI tools: the skill paces itself, tells the
  user it's Nominatim and links the policy, and never builds the public services into an app. A user decision whether
  that's acceptable, or whether to point it at a self-hosted Nominatim.
- `tests/skills/docx/conftest.py` puts the real python-docx back ahead of the test folder named `docx` (pytest's import
  mode registers the folder under that name).
