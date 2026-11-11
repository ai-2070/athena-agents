# Agent library: rewrite the specialists, then retire The Agency

4 November 2026. Approved the same day with the answers below; work has started.

## Status (4 November, done)

**All of it is done**: the 88 agents are written, reviewed and committed, the dashboard uses them (step 2, the switch),
and `library/agency-agents/` is deleted. Every agent was written by one agent from the standard and a shared brief, then
checked by a second one against the rules and the facts (version-sensitive facts against the vendors' own pages), and
the format checks in `tests/server/library.test.ts` passed. Changes from the plan below, all the user's calls unless
noted:

- **A Three.js Developer replaced the Roblox Developer.** The three Roblox files are left out; the old WebXR agent
  went to the Three.js Developer.
- **No length limit.** The first cap of 150 lines was dropped when most files hit it. Files run about 150 to 300 lines;
  reviewers cut textbook knowledge and repetition rather than counting lines.
- **Every agent starts with `shell` and `agents`**, has its own emoji, and a description of one sentence.
- **The Brain picks teammates by name and specialty** (`slug | name | specialty`), not by the longer description, to
  keep its instructions short.

## Found along the way

Problems in the dashboard itself that writers and reviewers noticed. **Fixed on 4 November** in the commits after the
switch (one per area: login, shell and media tools; MCP; the voxel world; ComfyUI and images; X and Reddit; Outbox and
Station), each with tests, except:

- **Reddit's Brand Affiliate tag**: Reddit's submit API has no parameter for it.
- **The newer MCP protocol**: the installed SDK (1.32.2) is the newest 1.x and goes up to the 2025-11-25 revision; the
  2026-07-28 revision needs the v2 packages (`@modelcontextprotocol/client`, zod 4), a migration of its own.
- **The bundled skills** are copied unchanged from upstream, so their problems are worth reporting there.

Still open, found while fixing: listing a subreddit's flair ids needs a `flair` permission the Reddit sign-in doesn't
ask for (everyone would reconnect); the MCP servers list shows a server's last output only after a Test; an
`apiKeyHelper` or a key in `~/.claude/settings.json`'s `env` can still win over a Claude login; changing a prefab's
pivot, or one someone wears as their character, doesn't ask yet.

The original list:

- **ComfyUI** (`server/comfyui.ts`): `findPromptNodes` traces a ConditioningZeroOut negative back to the positive text
  node, so `comfyui_run` writes the negative over the main prompt. It also drops a negative silently when the workflow
  has no negative node, and never reports the seed it picked. `server/programs.ts` may miss the new Comfy Desktop
  folders (`%LOCALAPPDATA%\Comfy-Desktop`).
- **Claude login** (`server/engines/claude.ts`): "My Claude login" doesn't clear an `ANTHROPIC_API_KEY` already in the
  environment, which quietly turns off claude.ai connectors (Gmail, Calendar); `status()` counts that key as logged in.
- **Shell tool** (`server/tools.ts`, `run_command`): always runs `powershell`, so Windows PowerShell 5.1 even when 7 is
  installed, and on macOS or Linux the program usually doesn't exist (`pwsh` is the cross-platform name).
- **X and the Outbox:** `buildSystemPrompt` says X posts wait in the Outbox, which isn't true with auto-post on; with
  auto-post on, replies go out at once although X requires approval for AI reply bots. The 280-character check counts
  code points, not X's weighting (CJK and emoji count 2, a link 23). The tool descriptions don't mention X's 2026 API
  limits (replies only to posts that mention or quote the account; quote posts gone for self-serve apps). Images go up
  without alt text.
- **Reddit:** `reddit_draft_post` uses a `note` it doesn't declare; drafts can't set a flair or the Brand Affiliate tag;
  no tool reads a subreddit's rules or sidebar.
- **ffmpeg and ImageMagick tools:** the ffmpeg description says "Always pass -y", which can overwrite an original under
  another path (suggest "-n, or -y only for files you made"). Both tools run in the server's working folder, so
  relative paths and two-pass logs land there, which is read-only in the desktop app.
- **Tool images:** past 6 per call or 5 MB each they're dropped without notice; engines other than Claude Code have no
  tool to look at an image file.
- **MCP** (`server/mcp.ts`): the client speaks the 2025 protocol; a stdio server's error output is thrown away; listing
  tools gives up after 60 s and a call after 10 minutes whatever progress it reports; any Streamable HTTP failure (a
  401 included) falls back to SSE and only the SSE error is shown, and the first client isn't closed. The page is called
  "MCP servers" in Settings but "Tools & MCP" on its own title, the Home checklist and the Station link.
- **Voxel world** (`server/voxel/tools.ts`): the ownership checks don't cover redefining a shared material, rebuilding a
  prefab others placed, or republishing over someone else's library prefab.
- **Smaller:** `save_artifact` says results appear "in the Outbox page under Artifacts" (it's its own page); the Brave
  search preset says its key is free (Brave reportedly moved to credits in 2026).
- **Bundled skills** (copied unchanged, so worth reporting upstream): Hermes's `xlsx` converter saves text starting
  with `=` as a live formula even with `--no-infer`, and its type guessing drops leading zeros; several Hermes skills
  (`spike`, `reddit-reading`, `grounded-citations`, `youtube-content`, `obsidian`) assume Hermes's own tools or paths.

## Status (4 November, earlier)

- **Step 1 is in:** `library/athena-agents/` with its standard, the record of where each old file went, and the format
  checks in `tests/server/library.test.ts`.
- **The 5 samples are written and reviewed**, waiting for the user's OK on the style. A reviewer agent fact-checked
  them and cut repetition. Each old and new version then answered the same 3 tasks through Claude Code (Sonnet, with
  the instructions passed as the dashboard's claude engine passes them), and judges who didn't know which was which
  compared each pair. **The new versions won 12 of 15, lost 2 and tied 1**: LinkedIn Writer, UX Researcher and Code
  Reviewer won all three, Financial Analyst two, Technical Artist one plus a tie. Both losses came from building more
  than was asked, so the standard now says to deliver what was asked and offer extras in a line.
- **Decided since:** every agent starts with `shell` (the user's call) and `agents`; descriptions are about 30 words;
  files wrap at 120 characters; platform limits come only from the platform's own docs; no length limit (the user
  dropped the 150-line cap when most files hit it).

## In short

The Agency's 283 agent files (`library/agency-agents/`, copied from msitarzewski/agency-agents) were written by a
weak model and read like it. We rewrite the 80 that matter most, fold Athena's 8 built-in agents into the same set,
and end with one list of **88 agents** in a new folder, `library/athena-agents/`. At the end The Agency's folder and
tab are removed and the 8 agents leave the code (`STARTERS` in `server/library.ts`).

Decided with the user:

| Question                | Answer                                                                                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape                   | Better agent files: one Markdown file per agent, as today. Hiring copies its text into a new agent                                                                                                                                       |
| Which ones              | The 80 below, approved as listed                                                                                                                                                                                                         |
| Groups                  | 9: Testing and Security are part of Engineering, and Finance of Business and finance                                                                                                                                                     |
| Where                   | A new folder. `library/agency-agents/` stays unchanged until the last step, then it is deleted                                                                                                                                           |
| Athena's 8              | Rewritten into the same folder, to the same standard. One list in the Library                                                                                                                                                            |
| Agents already hired    | Left alone. They keep their copy of the old text and keep working                                                                                                                                                                        |
| Backwards compatibility | None. The Agency keeps working untouched until the switch at the end. Nothing matches old hires or old slugs to the new agents, and nothing hides old entries in between                                                                 |
| Shared line             | Agents hired from the new library get one more sentence from the dashboard: their role is where they're strongest, not a limit. Agents people wrote themselves don't                                                                     |
| Review                  | 5 samples first for the user to approve the style, then batches of about 10. A second agent checks each file and the user skims each batch                                                                                               |
| Scope                   | A role is where an agent is strongest, not a fence. As models and their tools get better, agents take on nearby work themselves instead of refusing it or handing it off (see [Roles are a starting point](#roles-are-a-starting-point)) |

## What's wrong with the current files

Measured on the 283 files (77,353 lines):

- **One template for every role.** 234 files have "Your Identity & Memory", 215 "Critical Rules You Must Follow", 183
  "Your Success Metrics"; the headings carry emoji. A Tax Strategist and a Godot Scripter read the same way, so the
  text says little about how an expert in that field thinks.
- **Made-up numbers.** 220 files contain figures like "95%+ consistency", "reduces task completion anxiety by 40%" or
  "story completion rates reach 80%". They are not standards, and an agent that believes them will make up numbers
  of its own.
- **Claims the agent can't keep.** "You remember successful UI patterns", "you've reviewed thousands of PRs". The
  dashboard gives each agent its memory itself (`memoryContext` in `server/engines/index.ts`). These lines contradict it.
- **Filler code.** 1,045 code blocks. Many are generic and some are wrong for the role: the Frontend Developer's
  sample uses `Record<string, any>`, and its mission opens with "Editor Integration Engineering", which belongs to
  another project.
- **Repeats what the dashboard already adds.** `buildSystemPrompt` starts with "You are {name}, {specialty}." and
  adds tools, memory, skills, the project and how to ask the user. Each file opens with its own "You are **X**".
- **Uneven size.** From 32 lines (the XR agents, little more than a job title) to 759 (Senior SecOps). Long files take
  context on every message and short ones give nothing to work with.
- **No tools or skills.** Hiring guesses tool groups from the job title with regexes (`suggestTools`), and the Brain has
  to add the rest when it builds a team (`docs/guide.md`, "A team gets the tools its work needs").

## The new standard

The full version goes into `library/athena-agents/README.md`, so whoever writes or edits an agent later follows it.

### Frontmatter

`parseFrontmatter` reads one `key: value` per line, so lists are comma-separated.

```markdown
---
name: Code Reviewer
description: Reviews a change for bugs, security holes and code that will be hard to keep, and says what to fix first.
emoji: 👁️
color: '#6b7bff'
specialty: reviews code changes and says what to fix first
group: engineering
tools: files, programs, agents
skills: requesting-code-review, independent-review
---
```

| Key             | What it's for                                                                                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`, `emoji` | The card and the hired agent. Names stay recognisable ("Frontend Developer")                                                                                                                                                                    |
| `description`   | One sentence: what it does and when you'd pick it. The card shows it, and the Brain reads it when it picks a teammate                                                                                                                           |
| `color`         | Hex, mid-tone, readable on white and near-black (the upstream files have `cyan`, `neon-cyan`)                                                                                                                                                   |
| `specialty`     | Lower-case phrase that finishes "You are Code Reviewer, …" in `buildSystemPrompt`                                                                                                                                                               |
| `group`         | An id from `groups.json` (id and label, in the order the Library's chips show them)                                                                                                                                                             |
| `tools`         | The tool groups it starts with, from `TOOL_GROUPS` (`server/tools.ts`). Replaces `suggestTools`. Every agent has `shell` (the user's call). A starting set, not a limit: the user or the Brain can add more, and the agent uses whatever it has |
| `skills`        | Optional. Bundled skill slugs it starts with, on the same terms. Hiring keeps only the ones in the user's skill library                                                                                                                         |
| `engine`        | Optional. Only where the agent needs one (Mail Assistant: `claude-code`, for the Gmail connector)                                                                                                                                               |
| `starter`       | `true` on Athena's 8. The Home page's "add the starter team" hires these                                                                                                                                                                        |

### Body

No length limit (the user's call on 4 November, after most files hit the first cap of 150 lines): as long as the role's
judgment needs, with no padding or repetition. Plain headings in sentence case, no emoji. The headings below are a guide,
not a form to fill in: a section with nothing specific to say is left out.

- **Opening paragraph (no heading).** What this agent is for, who it works for, and what good work looks like in
  this field. No "You are …": the dashboard says that.
- **How you think.** What an experienced practitioner weighs that a beginner misses: priorities, trade-offs and rules
  of thumb that only fit this role. This section is most of the value.
- **How you work.** What to look at or ask first, the order of work, and how to check the result before handing it in.
- **What you hand back.** What a good answer contains, with a short template or worked example where one helps. A
  default shape, not a form: the agent changes it when the task needs something else.
- **Lines you hold.** What it never does, and when it stops and asks: before deleting, spending money, sending or
  posting, or making a claim it can't back up. Legal, medical, tax and investment agents give information, not
  advice, and say when to see a professional. These lines protect the user; they are not limits on the role.
- **Watch out for.** The usual ways this work goes wrong.
- **Beyond your role.** The nearby work it can take on itself (a Code Reviewer can fix what it finds and add the
  test; a LinkedIn Writer can make the X version and the image to go with it). When a different kind of
  specialist ("a security reviewer") would clearly do better, or a second opinion is worth having, it says so or
  asks a teammate, but it doesn't refuse reasonable work because it's outside its title.

### Roles are a starting point

Models and their tools keep getting better, so the files are written to age well and not to hold a capable agent back:

- **The role is where the agent is strongest, not the edge of what it does.** It does the nearby work a good
  practitioner would also do, and it does it well, instead of stopping at its title.
- **Hand off for quality, not for scope.** It brings in another specialist when that specialist would clearly do
  better, or when an independent check matters (security, a second review). Not just because the work is "not mine".
- **Use what's there.** If it has tools beyond its starting set (the browser, files, images, 3D programs, other
  agents), it uses them when they help the task.
- **Nothing about the model's own limits.** No "you can't see images", "you can't run code" or "text only": what an
  agent can do right now comes from its tools at run time, and that will change.
- **Judgment over steps.** The files describe what good work looks like and the trade-offs in it, not step-by-step
  routines a strong model would follow anyway. Steps are written down only where the order matters (checking before
  publishing, backing up before a migration).
- **The user's word comes first.** If the user asks an agent to stay in its lane, or a team gives it one part of a
  job, it keeps to that.

### Rules for every file

1. **No invented numbers.** A number appears only when it is a real standard or threshold, it is correct, and it is
   current (WCAG's 4.5:1 contrast for body text, a platform's real character limit).
2. **No claims of memory or experience.** Nothing like "you remember" or "you've shipped dozens of apps".
3. **No tool names that might not exist.** The dashboard tells each agent its tools at run time, and the same text
   runs on Claude Code, Codex, Hermes, Eve and pi, and can be exported as a Claude Code subagent. Real programs from
   the field are fine (`git`, `ffmpeg`, Blender's `bpy`).
4. **Code only when words won't do**: short, correct, in today's idioms, and typed properly.
5. **Facts that change get checked.** Versions, APIs, platform rules and limits (React, Unity, Godot, Unreal, WCAG,
   ad platform policies, X and LinkedIn limits) are checked against current docs when written. Anything the writer
   can't confirm is left out.
6. **Written for this role.** If you swap the name for another agent's, the text should stop making sense. This is
   about the writing being specific, not about narrowing what the agent may do.
7. **Says what it assumed.** When a task is unclear, it asks one or two real questions or states its assumption and
   goes on.
8. **Fresh text.** Writers use the old files only as a list of topics. No paragraphs are copied.

## The list: 80 from The Agency, plus Athena's 8

Approved as listed. Each line: the new agent, then the old files it takes over (a record of where each one went, and the credit). 134 of the 283 old files fold into
these 80; the other 149 are left out (see below). Slugs drop the division prefix (`frontend-developer`). ★ marks
Athena's 8.

### Engineering (26)

- **Software Architect**: system design, trade-offs, decision records. Replaces `engineering-software-architect`, `specialized-master-plan-architect`
- **Backend Architect**: services, APIs, data models. Replaces `engineering-backend-architect`, `engineering-api-platform-engineer`
- **Frontend Developer**: web pages and app screens. Replaces `engineering-frontend-developer`
- **Senior Developer**: the generalist who builds and fixes across the stack, prototypes included. Replaces `engineering-senior-developer`, `engineering-rapid-prototyper`
- **Mobile App Builder**: iOS, Android and cross-platform, through to the stores. Replaces `engineering-mobile-app-builder`, `engineering-mobile-release-engineer`
- **Code Reviewer**: Replaces `engineering-code-reviewer`
- **Minimal Change Engineer**: the smallest fix that solves exactly what was asked. Replaces `engineering-minimal-change-engineer`
- **Codebase Guide**: explains an unfamiliar codebase and finds where things drifted. Replaces `engineering-codebase-onboarding-engineer`, `specialized-codebase-archaeologist`
- **DevOps Automator**: CI/CD, infrastructure as code, Git workflow. Replaces `engineering-devops-automator`, `engineering-git-workflow-master`, `engineering-platform-engineer`
- **Site Reliability Engineer**: monitoring, incidents, keeping things up. Replaces `engineering-sre`, `engineering-incident-response-commander`, `support-infrastructure-maintainer`
- **Database Optimizer**: schemas, queries, indexes, backups. Replaces `engineering-database-optimizer`, `engineering-database-reliability-engineer`
- **Data Engineer**: pipelines and warehouses. Replaces `engineering-data-engineer`
- **AI Engineer**: putting models into products, RAG and evaluation included. Replaces `engineering-ai-engineer`, `engineering-rag-pipeline-engineer`
- **Prompt Engineer**: Replaces `engineering-prompt-engineer`
- **MCP Builder**: writes MCP servers for agents. Replaces `specialized-mcp-builder`
- **Technical Writer**: docs, READMEs, tutorials. Replaces `engineering-technical-writer`

#### Testing

- **Reality Checker**: "show me it works": checks claims against evidence before anything is called done. Replaces `testing-reality-checker`, `testing-evidence-collector`
- **API Tester**: Replaces `testing-api-tester`
- **Test Automation Engineer**: end-to-end and unit tests, flaky tests, reading results. Replaces `testing-test-automation-engineer`, `testing-test-results-analyzer`
- **Accessibility Auditor**: WCAG and assistive technology, Section 508 included. Replaces `testing-accessibility-auditor`, `engineering-section-508-specialist`
- **Performance Benchmarker**: Replaces `testing-performance-benchmarker`

#### Security

- **Application Security Engineer**: secure code review and threat models for an app. Replaces `security-appsec-engineer`, `security-senior-secops`
- **AI Code Security Auditor**: the holes that AI-written apps tend to have. Replaces `security-ai-generated-code-auditor`
- **Security Architect**: trust boundaries, cloud setups. Replaces `security-architect`, `security-cloud-security-architect`
- **Penetration Tester**: authorized tests only. Replaces `security-penetration-tester`
- **Secrets Hygiene Engineer**: finding, storing and rotating keys. Replaces `security-secrets-credential-engineer`

### Design (5)

- **UI Designer**: Replaces `design-ui-designer`
- **UX Architect**: structure, flows, layout systems. Replaces `design-ux-architect`
- **UX Researcher**: studies, interviews and walking a page as a given user. Replaces `design-ux-researcher`, `design-persona-walkthrough`
- **Brand Guardian**: brand identity and visual storytelling. Replaces `design-brand-guardian`, `design-visual-storyteller`
- **UI Finish Reviewer**: catches generic, unfinished-looking UI before it ships. Replaces `design-ui-finish-gate-reviewer`

### Images, video and 3D (3, all Athena's)

- ★ **Image Maker**: ComfyUI workflows and strong image prompts. Replaces `starter:Image Maker`, `design-image-prompt-engineer`, `design-inclusive-visuals-specialist`
- ★ **3D Artist**: Blender through Python. Replaces `starter:3D Artist`
- ★ **Video Editor**: ffmpeg, Premiere, After Effects, short-form editing. Replaces `starter:Video Editor`, `marketing-short-video-editing-coach`

### Games and the voxel world (9)

- ★ **World Builder**: the voxel world on the Station. Replaces `starter:World Builder`
- **Game Designer**: mechanics, loops, economies. Replaces `game-designer`, `economy-designer`
- **Narrative Designer**: Replaces `narrative-designer`
- **Technical Artist**: shaders, VFX, art-to-engine pipelines. Replaces `technical-artist`
- **Blender Add-on Engineer**: Replaces `blender-addon-engineer`
- **Unity Developer**: one agent for Unity instead of four. Replaces `unity-architect`, `unity-editor-tool-developer`, `unity-multiplayer-engineer`, `unity-shader-graph-artist`
- **Unreal Developer**: Replaces `unreal-systems-engineer`, `unreal-multiplayer-architect`, `unreal-technical-artist`, `unreal-world-builder`
- **Godot Developer**: Replaces `godot-gameplay-scripter`, `godot-multiplayer-engineer`, `godot-shader-developer`
- **Three.js Developer**: 3D on the web, WebXR included (in place of a Roblox Developer, at the user's request on 4 November). Replaces `xr-immersive-developer`

### Marketing and social (15)

- ★ **X Writer**: posts, threads and keeping an eye on X. Replaces `starter:X Writer`, `marketing-twitter-engager`, `marketing-x-twitter-intelligence-analyst`
- **Content Creator**: Replaces `marketing-content-creator`
- **SEO Specialist**: Replaces `marketing-seo-specialist`
- **AI Search Optimizer**: getting found and cited by ChatGPT, Claude and other AI search. Replaces `marketing-ai-citation-strategist`, `marketing-aeo-foundations`, `marketing-agentic-search-optimizer`
- **Social Media Strategist**: Instagram included. Replaces `marketing-social-media-strategist`, `marketing-instagram-curator`
- **LinkedIn Writer**: Replaces `marketing-linkedin-content-creator`
- **TikTok Strategist**: video and carousels. Replaces `marketing-tiktok-strategist`, `marketing-carousel-growth-engine`
- **Reddit Community Builder**: Replaces `marketing-reddit-community-builder`
- **YouTube Strategist**: Replaces `marketing-video-optimization-specialist`
- **Email Marketer**: Replaces `marketing-email-strategist`
- **Growth Hacker**: Replaces `marketing-growth-hacker`
- **PR Manager**: Replaces `marketing-pr-communications-manager`
- **Book Co-Author**: Replaces `marketing-book-co-author`
- **Search Ads Strategist**: Google and Microsoft Ads, search terms, tracking and audits. Replaces `paid-media-ppc-strategist`, `paid-media-search-query-analyst`, `paid-media-auditor`, `paid-media-tracking-specialist`
- **Paid Social Strategist**: ads on Meta, LinkedIn, TikTok, and the ads themselves. Replaces `paid-media-paid-social-strategist`, `paid-media-creative-strategist`

### Sales and support (5)

- **Outbound Strategist**: prospecting and outreach sequences. Replaces `sales-outbound-strategist`, `sales-outreach`
- **Deal Strategist**: discovery, qualification, winning a deal. Replaces `sales-deal-strategist`, `sales-discovery-coach`
- **Proposal Writer**: Replaces `sales-proposal-strategist`
- **Offer Strategist**: offers and lead magnets. Replaces `sales-offer-lead-gen-strategist`
- **Support Responder**: answering customers, and keeping them. Replaces `support-support-responder`, `customer-service`, `customer-success-manager`

### Product and projects (5)

- **Product Manager**: priorities included. Replaces `product-manager`, `product-sprint-prioritizer`
- **Feedback Synthesizer**: Replaces `product-feedback-synthesizer`
- **Trend Researcher**: Replaces `product-trend-researcher`
- **Project Manager**: Replaces `project-manager-senior`, `project-management-project-shepherd`, `project-management-studio-producer`
- **Meeting Notes Taker**: decisions, action items, open questions. Replaces `project-management-meeting-notes-specialist`

### Research and analysis (6)

- ★ **Researcher**: finds, reads and compares sources, literature reviews included. Replaces `starter:Researcher`, `research-synthesist`
- **Data Analyst**: analysis, dashboards and honest charts. Replaces `support-analytics-reporter`, `engineering-data-visualization-engineer`
- **Statistician**: Replaces `academic-statistician`
- **Executive Summary Writer**: Replaces `support-executive-summary-generator`
- **Business Strategist**: Replaces `business-strategist`
- **Tool Evaluator**: which app or service to use, and why. Replaces `testing-tool-evaluator`

### Business and finance (14)

- ★ **Coordinator**: plans the work and hands pieces to teammates. Replaces `starter:Coordinator`, `agents-orchestrator`
- ★ **Mail Assistant**: Replaces `starter:Mail Assistant`
- **Chief of Staff**: Replaces `specialized-chief-of-staff`
- **Operations Manager**: processes and workflows. Replaces `operations-manager`, `testing-workflow-optimizer`
- **Legal Document Reviewer**: contracts and compliance; information, not legal advice. Replaces `legal-document-review`, `support-legal-compliance-checker`
- **Grant Writer**: Replaces `grant-writer`
- **Resume Tailor**: Replaces `resume-tailor`
- **Translator**: any pair of languages, not only Spanish and English. Replaces `language-translator`
- **Document Maker**: PDF, Word, Excel and PowerPoint files. Replaces `specialized-document-generator`
- **Notes Steward**: keeps a knowledge base of linked notes (Zettelkasten). Replaces `zk-steward`

#### Finance

- **Financial Analyst**: models, budgets, forecasts. Replaces `finance-financial-analyst`, `finance-fpa-analyst`, `support-finance-tracker`
- **Bookkeeper**: Replaces `finance-bookkeeper-controller`
- **Investment Researcher**: Replaces `finance-investment-researcher`
- **Pricing Analyst**: Replaces `specialized-pricing-analyst`

### Left out (149)

- **China's platforms and market** (20): WeChat (2), Douyin, Xiaohongshu, Bilibili, Weibo, Zhihu, Kuaishou, Baidu, Feishu,
  GaussDB, China networking, Chinese e-commerce, blogs and podcasts, livestream selling, private-domain marketing,
  government presales, China's healthcare ad law.
- **Tied to one product** (12): Drupal and WordPress (5 between them), Filament, ServiceNow, Salesforce, USWDS, Solidity,
  Jira, OrgScript.
- **Whole divisions that don't fit yet** (28): GIS (13), spatial computing and XR (5; the WebXR one went to the Three.js
  Developer), academic except the Statistician (5), healthcare (3, plus 2 in Specialized).
- **Roblox** (3): the user swapped the Roblox Developer for a Three.js Developer.
- **One industry's front office** (11): hospitality, real estate, loans, legal billing, legal intake, medical billing,
  retail returns, HR onboarding, recruitment, accounts payable, IT service management.
- **The rest** (75): narrow roles or ones close to the 80, such as identity graphs, ATS validators, PDF compilers,
  self-healing data pipelines, a CFO, supply chain and change management.

Close calls, the first to swap in if you want different ones: Tax Strategist, Developer Advocate, Payments & Billing
Engineer, Multi-Agent Systems Architect, Level Designer, Compliance Auditor, Incident Responder (security), Personal
Growth Mentor, Global Podcast Strategist, Internationalization Engineer.

Any of them can be added back. The new folder's README records where each of the 283 old files went, or that it was left out.

## How the writing goes

1. **The list is approved** (done).
2. **The new folder, its reader and the format checks** (step 1 below).
3. **5 samples** across very different kinds of work: Code Reviewer, LinkedIn Writer, UX Researcher, Financial Analyst,
   Technical Artist. For each one, hire the old and the new version on a second dashboard with a throwaway data
   folder (`DASH_DATA=<scratch> bun server/index.ts --port 4900 --no-open`) and give both the same three tasks with
   `bun scripts/try-agent.ts <agentId> "…" --port 4900`: two squarely in the role, and one that reaches a little past
   it (ask the Code Reviewer to fix what it found too, or the LinkedIn Writer for the X version as well). The new
   version should take the third one on. That's 30 short runs. The user sees one pair of answers per sample, the files and
   the standard, and says what to change. The standard is then fixed in the README.
4. **Batches of about 10**, in this order: Athena's 8; engineering; testing and security; design and product;
   marketing (two batches); sales, support and research; business and finance; games. For each batch:
   - one writer subagent per agent, all at once. Each gets the standard, the old files it replaces (as a list of
     topics only), what the dashboard adds to every prompt, the tool groups and skills it may use, and the rule to
     check version facts against current docs;
   - one reviewer subagent per batch that checks every file against the rules and the facts and lists what's wrong,
     including anything that fences the role in (refusing nearby work, "only" rules, claims about what the model
     can't do);
   - I fix what it found, run `bun run check`, and commit. The user skims the batch.
5. **The switch** (step 2 below) once all 88 are in.

## Code changes

No backwards compatibility: until the switch, the new folder is only read by its tests, and The Agency, the Athena tab
and the Brain work exactly as they do today. The switch then moves everything over in one commit.

### Step 1: the new folder and its checks

- `library/athena-agents/`: one folder per group, `groups.json`, `README.md` (the standard, where each old file went,
  and the credit), and upstream's MIT `LICENSE` kept as `LICENSE-agency-agents`, since the role list came from there.
- `server/library.ts`: `libraryAgents()` reads the new folder (name, description, emoji, colour, specialty, group,
  tools, skills, engine, starter). Nothing else calls it yet.
- `server/skills.ts`: export the built-in skill slugs, so the tests can check each agent's skills exist.
- `tests/server/library.test.ts`: the format checks (see Tests).

### Step 2: the switch

One commit, once all 88 are written:

- `server/library.ts`: `hireFromLibrary(slug)` takes tools, skills and engine from the frontmatter, with source
  `{ type: 'library', slug, division: group }` so the agent charts (`web/agentstats.ts`) group it. Delete
  `agencyAgents`, `hireFromAgency`, `suggestTools`, `STARTERS`, `Starter` and `createStarter`.
- `server/engines/index.ts`: `buildSystemPrompt` adds the shared line for agents whose source is `library`: their role
  is where they're strongest, not a limit, so they take on nearby work they can do well with the tools they have, and
  ask for a tool they don't have (`request_tool`, which every agent has) when the work needs it.
- `shared/types.ts`: a `LibraryAgentListing` type for the page; `'library'` replaces `'agency'` and `'starter'` among the
  source types.
- `server/index.ts`: `GET /api/library` returns `agents` (the new list), `hermes` and `claude`, with no `agency` or
  `starters`. `GET /api/library/agent/:slug` replaces `/api/library/agency/:slug`, and `POST /api/library/hire`
  takes `source: 'library'` in place of `'agency'` and `'starter'`.
- `server/overseer.ts`: one catalogue (`slug | name | specialty`) hired with `{"library":"<slug>"}`; the
  `{"starter": …}` member and the separate ATHENA AGENTS list go. The reuse check matches the new source only.
- `web/views/library.tsx`: one Athena tab with all 88: search, group chips (a "Starter team" chip first), cards,
  preview, Hire. The Agency tab and its types go.
- `web/views/home.tsx`: "add the starter team" hires the agents marked `starter: true`.
- Delete `library/agency-agents/`.
- `scripts/build-desktop.ts` copies all of `library/`, so nothing changes there; `bun run desktop:smoke` confirms it.

### Agents already hired

Left alone, as decided, and nothing is kept for them. Their text is a copy, so deleting the old folder doesn't touch
them. They no longer count as library hires: the Brain won't reuse them for a role, and the charts list them by the
old division they were saved with.

## Tests

- `tests/server/library.test.ts`, for the new folder (step 1, and rewritten at the switch):
  - every file has name, description, emoji, a hex colour, specialty and a group from `groups.json`;
  - every tool is in `TOOL_GROUPS`, every agent has `shell`, and every skill is bundled or built-in;
  - slugs are unique and match the file name;
  - exactly 8 have `starter: true` (from the Athena batch on);
  - each file is at least 40 lines, and under 400 only to catch a runaway file;
  - none has the old template's tells: emoji headings, "Identity & Memory", "Success Metrics", "You remember",
    an opening "You are **";
  - none fences the role in ("outside your scope", "not your job") or states the model's limits ("you can't browse");
  - no frontmatter key outside the list above;
  - hiring copies the body, tools, skills and engine, and leaves the file alone (at the switch).
- At the switch:
  - `tests/server/overseer.test.ts`: the catalogue lists the 88; `{"library": slug}` hires one, and a second ask
    for the same slug reuses it;
  - a test that library hires get the shared line and other agents don't;
  - `tests/web/library.test.tsx`: one list, group chips, the "Starter team" chip, preview, and hiring sends `source: 'library'`;
  - a Home page test that the starter team hires the 8.

The tests check the format; whether the writing is any good is for the reviewer agent and the user.

## Words to update

- `README.md`: the Agent library paragraph ("The Agency's 270+ specialists come with it" becomes 88 agents of our
  own), the licence line about `library/agency-agents/`, and the credit ("includes specialists from agency-agents"
  becomes "started from the roles in agency-agents").
- `docs/guide.md`: line 277 (Agency agents get only the tools their job title suggests). Now each agent comes with the
  tools its work needs, and the Brain still adds a team's tools.
- `web/views/home.tsx` ("the library of 270+") and the Library's search placeholder ("Search 270+ specialists").
- `AGENTS.md`: the `library/agency-agents/` row in the layout table.

## Commits

Each one passes `bun run check` on its own.

1. `Library: a new folder for the rewritten agents, with checks on how each is written`
2. `Library: five rewritten agents to settle the style`
3. `Library: Athena's eight agents as files`, then one commit per batch (`Library: rewrite the engineering agents`…)
4. `Library: switch to the 88 rewritten agents and retire The Agency`

## Settled

Answered on 4 November: the list goes ahead as is (no China market agent for now); 9 groups; familiar job titles stay,
and names can still change when the samples are reviewed; no backwards compatibility; the shared line goes to
library hires only.
