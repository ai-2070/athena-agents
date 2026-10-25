// Built-in tools. Every agent gets the groups switched on in its settings.
// Risk decides when you're asked first: autonomy "ask" checks low + high, "auto" checks high only, "full" never asks.
import fs from 'node:fs';
import path from 'node:path';
import { HOME, ROOT, dataPath, ensureDir, run, truncate, tmpFile, openWithShell, launchDetached, exists, which } from './util.js';
import { agents as agentStore, getSettings, emit, log } from './store.js';
import { requestApproval } from './approvals.js';
import { discoverPrograms, launchProgram, programExe, startMenuApps } from './programs.js';
import * as comfy from './comfyui.js';
import * as social from './social.js';
import * as reddit from './reddit.js';
import * as kb from './knowledge.js';
import { ensureBrain } from './projects.js';

export const TOOL_GROUPS = [
  { id: 'programs', label: 'Programs', description: 'See what is installed and start programs, files and folders.' },
  { id: 'browser', label: 'Browser', description: 'Open pages in your browser and read web pages.' },
  { id: 'comfyui', label: 'ComfyUI', description: 'Run your ComfyUI workflows and get the images back.' },
  { id: 'blender', label: 'Blender', description: 'Run Blender Python (modeling, rendering, exports).' },
  { id: 'adobe', label: 'Adobe', description: 'Photoshop and After Effects scripts, open Premiere projects.' },
  { id: 'media', label: 'FFmpeg', description: 'Convert, cut and inspect audio and video.' },
  { id: 'social', label: 'Social', description: 'Draft X and Reddit posts (they wait in the Outbox), read posts, mentions and subreddits, Telegram, Discord.' },
  { id: 'agents', label: 'Delegate', description: 'Ask other agents and Hermes profiles for help.' },
  { id: 'files', label: 'Files', description: 'Read and write files in its workspace and folders you allow.' },
  { id: 'orca', label: 'Orca', description: 'Run Orca CLI commands (worktrees, terminals, its browser).' },
  { id: 'shell', label: 'Shell', description: 'Run any PowerShell command. Powerful: you are asked each time unless autonomy is Full.' },
];

export function workspaceOf(agent) {
  // By default every agent works in the project's Brain folder.
  return ensureDir(agent.workspace && path.isAbsolute(agent.workspace) ? agent.workspace : ensureBrain());
}

// Reading: workspace, outputs, knowledge, allowed folders. Writing: not linked knowledge folders.
function allowedRoots(agent, write = false) {
  const s = getSettings();
  return [workspaceOf(agent), dataPath('outputs'), ...(write ? [] : kb.knowledgeRoots(agent)), ...(s.allowedFolders || [])].map((p) => path.resolve(p).toLowerCase());
}

function resolveInside(agent, p, { write = false } = {}) {
  const abs = path.resolve(workspaceOf(agent), String(p || '.'));
  const low = abs.toLowerCase();
  const ok = allowedRoots(agent, write).some((r) => low === r || low.startsWith(r + path.sep));
  return { abs, ok, write };
}

// Files that run code when opened.
const RUNNABLE = /\.(exe|com|bat|cmd|ps1|psm1|vbs|vbe|js|jse|wsf|wsh|hta|msi|msp|scr|cpl|lnk|url|reg|jar|py|pyw|sh|appref-ms|application|gadget|inf|pif|scf)$/i;
// Programs that run whatever they are given.
const INTERPRETERS = /^(cmd|powershell|pwsh|wscript|cscript|mshta|rundll32|regsvr32|python\d*|py|node|bash|sh|wsl|msiexec|reg|schtasks|certutil|bitsadmin|curl|wget)(\.exe)?$/i;

const str = (description) => ({ type: 'string', description });
const obj = (properties, required = []) => ({ type: 'object', properties, required });

const TOOLS = [
  // ---------- programs ----------
  {
    name: 'list_programs',
    group: 'programs',
    risk: 'none',
    description: 'List the programs and local AI services found on this PC, whether each is running, and what it can do. Pass all=true to also list every Start Menu app.',
    parameters: obj({ all: { type: 'boolean', description: 'Include every Start Menu shortcut' } }),
    run: async ({ all }) => {
      const progs = await discoverPrograms(true);
      const lines = progs
        .filter((p) => p.installed)
        .map((p) => `- ${p.name} [${p.id}]${p.version ? ` v${p.version}` : ''}${p.running ? ' (running' + (p.serviceUrl ? ` at ${p.serviceUrl}` : '') + ')' : ''}`);
      let text = `Installed programs:\n${lines.join('\n')}`;
      if (all) text += `\n\nStart Menu apps:\n${startMenuApps().map((a) => `- ${a.name}`).join('\n')}`;
      return { text };
    },
  },
  {
    name: 'launch_program',
    group: 'programs',
    // Plain launches are low risk; extra arguments, runnable files or shells need a yes.
    risk: ({ program, file, args }) => (INTERPRETERS.test(path.basename(String(program || ''))) || (args && args.length) || (file && RUNNABLE.test(file)) ? 'high' : 'low'),
    description: 'Start a program by name or id (e.g. "blender", "premiere", "comfyui", "LM Studio", any Start Menu app). Optionally open a file with it.',
    parameters: obj({ program: str('Program name or id'), file: str('Optional file to open with it'), args: { type: 'array', items: { type: 'string' } } }, ['program']),
    run: async ({ program, file, args }) => ({ text: await launchProgram(program, { file, args }) }),
  },
  {
    name: 'open_path',
    group: 'programs',
    risk: ({ path: p }) => (RUNNABLE.test(String(p || '')) ? 'high' : 'low'),
    description: 'Open a file or folder with its default program (Explorer for folders).',
    parameters: obj({ path: str('Absolute path') }, ['path']),
    run: async ({ path: p }) => {
      if (!exists(p)) throw new Error(`${p} does not exist.`);
      openWithShell(p);
      return { text: `Opened ${p}` };
    },
  },
  // ---------- browser ----------
  {
    name: 'open_url',
    group: 'browser',
    risk: 'low',
    description: 'Open a web page for the user in their browser (default browser, or chrome/edge/opera).',
    parameters: obj({ url: str('http(s) URL'), browser: str('Optional: chrome, edge or opera') }, ['url']),
    run: async ({ url, browser }) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened.');
      const exe = browser ? programExe(browser.toLowerCase()) : null;
      if (exe) launchDetached(exe, [url]);
      else openWithShell(url);
      return { text: `Opened ${url}${exe ? ` in ${browser}` : ''}.` };
    },
  },
  {
    name: 'fetch_url',
    group: 'browser',
    risk: 'none',
    description: 'Download a web page or API response and return its readable text (scripts and styles removed). For interactive browsing add the Playwright MCP server.',
    parameters: obj({ url: str('http(s) URL'), max_chars: { type: 'number' } }, ['url']),
    run: async ({ url, max_chars = 20000 }) => {
      if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) URLs.');
      const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) my-dashboard/0.1' }, signal: AbortSignal.timeout(30000), redirect: 'follow' });
      const type = res.headers.get('content-type') || '';
      let body = await res.text();
      if (/html/i.test(type)) body = htmlToText(body);
      return { text: `HTTP ${res.status} ${res.url}\n\n${truncate(body, max_chars)}` };
    },
  },
  // ---------- ComfyUI ----------
  {
    name: 'comfyui_status',
    group: 'comfyui',
    risk: 'none',
    description: 'Is ComfyUI running, its queue and GPU memory.',
    parameters: obj({}),
    run: async () => ({ text: JSON.stringify(await comfy.queueStatus(), null, 2) }),
  },
  {
    name: 'comfyui_start',
    group: 'comfyui',
    risk: 'low',
    description: 'Start ComfyUI (the desktop app). It takes a little while before it accepts jobs; check with comfyui_status.',
    parameters: obj({}),
    run: async () => ({ text: await comfy.startComfy() }),
  },
  {
    name: 'comfyui_list_workflows',
    group: 'comfyui',
    risk: 'none',
    description: 'List the saved ComfyUI workflows that can be run.',
    parameters: obj({}),
    run: async () => ({ text: comfy.listWorkflows().map((w) => `- ${w.name}`).join('\n') || 'No workflows found. Save one in ComfyUI first.' }),
  },
  {
    name: 'comfyui_describe_workflow',
    group: 'comfyui',
    risk: 'none',
    description: 'Show which inputs a workflow has (keyed "nodeId.input") and which nodes hold the positive/negative prompt.',
    parameters: obj({ workflow: str('Workflow name') }, ['workflow']),
    run: async ({ workflow }) => ({ text: JSON.stringify(await comfy.describeWorkflow(workflow), null, 2) }),
  },
  {
    name: 'comfyui_run',
    group: 'comfyui',
    risk: 'low',
    description: 'Run a ComfyUI workflow and wait for the results. Set prompt/negative to replace the prompt text, inputs to change anything else ({"3.steps": 30, "5.width": 1024}). Seeds are randomized unless you set them.',
    parameters: obj(
      {
        workflow: str('Workflow name'),
        prompt: str('Positive prompt text'),
        negative: str('Negative prompt text'),
        inputs: { type: 'object', description: 'Other changes as {"nodeId.input": value}' },
        randomize_seed: { type: 'boolean' },
      },
      ['workflow'],
    ),
    run: async ({ workflow, prompt, negative, inputs, randomize_seed = true }, ctx) => {
      const r = await comfy.runWorkflow({ workflow, prompt, negative, inputs, randomizeSeed: randomize_seed, signal: ctx.signal, onProgress: (s) => ctx.progress?.(`ComfyUI working… ${s}s`) });
      const imgs = r.files.filter((f) => f.kind === 'images').map((f) => f.url);
      return {
        text: `Done in ${r.seconds}s. Files:\n${r.files.map((f) => `- ${f.filename} (${f.kind}, ${f.type}${f.subfolder ? `/${f.subfolder}` : ''})`).join('\n')}${r.warnings.length ? `\nWarnings:\n${r.warnings.join('\n')}` : ''}`,
        images: imgs,
      };
    },
  },
  // ---------- Blender ----------
  {
    name: 'blender_run_python',
    group: 'blender',
    risk: 'high', // Python can do anything; "Always allow" it for agents you trust with Blender

    description: 'Run a Python script in Blender (bpy) without opening its window, optionally on a .blend file, and return what it prints. Use it to build scenes, render (bpy.ops.render.render(write_still=True)), import/export models. Save outputs to absolute paths.',
    parameters: obj({ code: str('Python code using bpy'), blend_file: str('Optional .blend to open first'), save_as: str('Optional path to save the .blend afterwards') }, ['code']),
    run: async ({ code, blend_file, save_as }, ctx) => {
      const exe = programExe('blender');
      if (!exe) throw new Error('Blender was not found. Set its path in Settings.');
      const script = tmpFile('blender.py');
      const footer = save_as ? `\nimport bpy as __b\n__b.ops.wm.save_as_mainfile(filepath=${JSON.stringify(save_as)})\nprint("Saved", ${JSON.stringify(save_as)})\n` : '';
      fs.writeFileSync(script, `${code}\n${footer}`);
      const args = ['-b', ...(blend_file ? [blend_file] : ['--factory-startup']), '--python', script, '--python-exit-code', '1'];
      const r = await run(exe, args, { timeout: 15 * 60_000, signal: ctx.signal });
      const out = (r.stdout + '\n' + r.stderr)
        .split(/\r?\n/)
        .filter((l) => !/^(Blender \d|Read prefs|Warning: \(|Color management|found bundled python|Fra:\d+ Mem:)/.test(l))
        .join('\n');
      return { text: `${r.code === 0 ? 'Finished' : `Failed (exit ${r.code})`}\n${truncate(out.trim(), 12000)}`, isError: r.code !== 0 };
    },
  },
  {
    name: 'blender_open',
    group: 'blender',
    risk: 'low',
    description: 'Open Blender with its window, optionally loading a .blend file.',
    parameters: obj({ file: str('Optional .blend file') }),
    run: async ({ file }) => ({ text: await launchProgram('blender', { file }) }),
  },
  // ---------- Adobe ----------
  {
    name: 'photoshop_run_script',
    group: 'adobe',
    risk: 'high',
    description: 'Run ExtendScript (JavaScript) in Photoshop, starting it if needed. Use log(value) to send text back; a returned value is sent back too. Example: app.documents.add(1920,1080); return app.activeDocument.name;',
    parameters: obj({ code: str('ExtendScript code (body of a function)') }, ['code']),
    run: async ({ code }) => runJsx('photoshop', code),
  },
  {
    name: 'aftereffects_run_script',
    group: 'adobe',
    risk: 'high',
    description: 'Run ExtendScript in After Effects (starting it if needed). log(value) and return values come back. After Effects needs "Allow Scripts to Write Files and Access Network" turned on in Preferences > Scripting & Expressions.',
    parameters: obj({ code: str('ExtendScript code (body of a function)') }, ['code']),
    run: async ({ code }) => runJsx('aftereffects', code),
  },
  {
    name: 'premiere_open',
    group: 'adobe',
    risk: 'low',
    description: 'Open Premiere Pro, optionally with a project (.prproj) or media file. For timeline editing use ffmpeg, or add a Premiere MCP server.',
    parameters: obj({ file: str('Optional .prproj or media file') }),
    run: async ({ file }) => ({ text: await launchProgram('premiere', { file }) }),
  },
  // ---------- media ----------
  {
    name: 'ffmpeg',
    group: 'media',
    risk: 'high', // it can overwrite any file; "Always allow" it for your video agents
    description: 'Run ffmpeg with the given arguments (no shell). Always pass -y and absolute output paths. Example args: ["-y","-i","C:/in.mp4","-ss","5","-t","10","C:/out.mp4"].',
    parameters: obj({ args: { type: 'array', items: { type: 'string' } } }, ['args']),
    run: async ({ args }, ctx) => {
      if (!which('ffmpeg')) throw new Error('ffmpeg is not installed.');
      const r = await run('ffmpeg', ['-hide_banner', ...args], { timeout: 60 * 60_000, signal: ctx.signal });
      return { text: `${r.code === 0 ? 'Done' : `ffmpeg failed (exit ${r.code})`}\n${truncate(r.stderr.split(/\r?\n/).slice(-40).join('\n'), 6000)}`, isError: r.code !== 0 };
    },
  },
  {
    name: 'ffprobe',
    group: 'media',
    risk: 'none',
    description: 'Show duration, streams and format of an audio or video file.',
    parameters: obj({ file: str('Absolute path') }, ['file']),
    run: async ({ file }) => {
      const r = await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { timeout: 60000 });
      return { text: truncate(r.stdout || r.stderr, 8000) };
    },
  },
  // ---------- social ----------
  {
    name: 'social_accounts',
    group: 'social',
    risk: 'none',
    description: 'List connected social accounts.',
    parameters: obj({}),
    run: async () => {
      const a = social.listAccounts();
      return {
        text: `X: ${a.x.map((x) => `@${x.username}${x.autopost ? ' (auto-post on)' : ' (approve first)'}`).join(', ') || 'none connected'}\nReddit: ${a.reddit.map((x) => `u/${x.username}`).join(', ') || 'none connected'}\nTelegram: ${a.telegram.configured ? 'ready' : 'not set up'}\nDiscord: ${a.discord.configured ? 'ready' : 'not set up'}`,
      };
    },
  },
  {
    name: 'x_draft_post',
    group: 'social',
    risk: 'none',
    description: 'Write a post (or thread) for X. It goes to the Outbox where the user approves, edits or rejects it; it is only published straight away if that account has auto-post on. Each part max 280 characters.',
    parameters: obj(
      {
        text: str('The post'),
        thread: { type: 'array', items: { type: 'string' }, description: 'For a thread: every part in order (instead of text)' },
        account: str('Handle to post as (default: first connected)'),
        reply_to: str('Tweet ID to reply to'),
        note: str('Why this post, for the reviewer'),
      },
    ),
    run: async ({ text, thread, account, reply_to, note }, ctx) => {
      const r = await social.draftPost({ platform: 'x', text, thread, account, replyTo: reply_to, note, agentId: ctx.agent.id, agentName: ctx.agent.name });
      return { text: r.status === 'posted' ? `Posted: ${r.url}` : r.status === 'failed' ? `Auto-post failed: ${r.error}` : `Saved to the Outbox for approval (id ${r.id}).` };
    },
  },
  {
    name: 'x_draft_dm',
    group: 'social',
    risk: 'none',
    description: 'Write a direct message on X to someone. It always waits in the Outbox for the user to approve, edit or reject; it is never sent on its own.',
    parameters: obj({ to: str('Their X handle, e.g. @someone'), text: str('The message'), account: str('Which of your handles to send from (default: first connected)'), note: str('Why, for the reviewer') }, ['to', 'text']),
    run: async ({ to, text, account, note }, ctx) => {
      const r = await social.draftPost({ platform: 'x_dm', to, text, account, note, agentId: ctx.agent.id, agentName: ctx.agent.name });
      return { text: `Saved the DM to @${r.to} in the Outbox for approval (id ${r.id}).` };
    },
  },
  {
    name: 'x_recent_posts',
    group: 'social',
    risk: 'none',
    description: "Read a connected account's recent posts with likes, reposts and replies. (Each X read is billed by X.)",
    parameters: obj({ account: str('Handle'), limit: { type: 'number' } }),
    run: async ({ account, limit = 10 }) => ({ text: JSON.stringify(await social.xRecentPosts(account, limit), null, 2) }),
  },
  {
    name: 'x_mentions',
    group: 'social',
    risk: 'none',
    description: 'Read recent mentions of a connected account. (Each X read is billed by X.)',
    parameters: obj({ account: str('Handle'), limit: { type: 'number' } }),
    run: async ({ account, limit = 10 }) => ({ text: JSON.stringify(await social.xMentions(account, limit), null, 2) }),
  },
  {
    name: 'reddit_read',
    group: 'social',
    risk: 'none',
    description: 'Read posts from a subreddit (hot, new, top this week, rising): titles, scores, comment counts, links.',
    parameters: obj({ subreddit: str('e.g. LocalLLaMA'), sort: str('hot, new, top or rising'), limit: { type: 'number' } }, ['subreddit']),
    run: async ({ subreddit, sort = 'hot', limit = 10 }) => ({ text: JSON.stringify(await reddit.readSubreddit(subreddit, sort, limit), null, 2) }),
  },
  {
    name: 'reddit_search',
    group: 'social',
    risk: 'none',
    description: 'Search Reddit (optionally inside one subreddit) for posts from the last month.',
    parameters: obj({ query: str('What to look for'), subreddit: str('Optional subreddit'), limit: { type: 'number' } }, ['query']),
    run: async ({ query, subreddit = '', limit = 10 }) => ({ text: JSON.stringify(await reddit.searchReddit(query, subreddit, limit), null, 2) }),
  },
  {
    name: 'reddit_comments',
    group: 'social',
    risk: 'none',
    description: "Read a Reddit post and its top comments (give the post URL or id).",
    parameters: obj({ post: str('Post URL or id') }, ['post']),
    run: async ({ post }) => ({ text: JSON.stringify(await reddit.postComments(post), null, 2) }),
  },
  {
    name: 'reddit_draft_post',
    group: 'social',
    risk: 'none',
    description: 'Write a Reddit post. It waits in the Outbox for the user to approve or edit. Follow the subreddit rules; no spam or self-promotion where it is not allowed.',
    parameters: obj({ subreddit: str('Subreddit, e.g. LocalLLaMA'), title: str('Post title'), text: str('Post body (markdown)'), link: str('Or a link to share instead of text'), account: str('Which of your Reddit accounts') }, ['subreddit', 'title']),
    run: async ({ subreddit, title, text, link, account, note }, ctx) => {
      const r = await social.draftPost({ platform: 'reddit', subreddit, title, text, link, account, note, agentId: ctx.agent.id, agentName: ctx.agent.name });
      return { text: r.status === 'posted' ? `Posted: ${r.url}` : `Saved to the Outbox for approval (id ${r.id}).` };
    },
  },
  {
    name: 'reddit_draft_comment',
    group: 'social',
    risk: 'none',
    description: 'Write a Reddit comment replying to a post or comment (give its URL or id). It waits in the Outbox for the user to approve.',
    parameters: obj({ reply_to: str('Post or comment URL, or id like t3_abc / t1_abc'), text: str('The comment (markdown)'), account: str('Which of your Reddit accounts') }, ['reply_to', 'text']),
    run: async ({ reply_to, text, account }, ctx) => {
      const r = await social.draftPost({ platform: 'reddit', parent: reply_to, text, account, agentId: ctx.agent.id, agentName: ctx.agent.name });
      return { text: r.status === 'posted' ? `Posted: ${r.url}` : `Saved to the Outbox for approval (id ${r.id}).` };
    },
  },
  {
    name: 'telegram_send',
    group: 'social',
    risk: 'high',
    description: 'Send a Telegram message to the configured chat.',
    parameters: obj({ text: str('Message') }, ['text']),
    run: async ({ text }) => ({ text: await social.sendTelegram(text) }),
  },
  {
    name: 'discord_send',
    group: 'social',
    risk: 'high',
    description: 'Post a message to the configured Discord channel webhook.',
    parameters: obj({ text: str('Message') }, ['text']),
    run: async ({ text }) => ({ text: await social.sendDiscord(text) }),
  },
  // ---------- team ----------
  {
    name: 'list_agents',
    group: 'agents',
    risk: 'none',
    description: 'List the other agents on this dashboard and what each is good at.',
    parameters: obj({}),
    run: async (_a, ctx) => ({
      text: agentStore
        .list()
        .filter((a) => a.id !== ctx.agent.id)
        .map((a) => `- ${a.name} [${a.id}]: ${a.specialty || a.description || ''}`)
        .join('\n') || 'No other agents yet.',
    }),
  },
  {
    name: 'ask_agent',
    group: 'agents',
    risk: 'none',
    description: 'Give a task to another agent and wait for its answer. Say exactly what you need back.',
    parameters: obj({ agent: str('Agent name or id'), message: str('The task or question') }, ['agent', 'message']),
    run: async ({ agent, message }, ctx) => {
      if ((ctx.depth || 0) >= 3) throw new Error('Too many agents deep; answer this yourself.');
      const all = agentStore.list();
      const target = all.find((a) => a.id === agent) || all.find((a) => a.name.toLowerCase() === String(agent).toLowerCase()) || all.find((a) => a.name.toLowerCase().includes(String(agent).toLowerCase()));
      if (!target) throw new Error(`No agent called "${agent}".`);
      if (target.id === ctx.agent.id) throw new Error("That's you.");
      const { askAgent } = await import('./engines/index.js');
      const answer = await askAgent(target, message, { depth: (ctx.depth || 0) + 1, from: ctx.agent.name, parentRunId: ctx.runId, signal: ctx.signal });
      return { text: `${target.name} says:\n${answer}` };
    },
  },
  {
    name: 'hermes_ask',
    group: 'agents',
    risk: 'none',
    description: 'Ask one of your Hermes profiles (e.g. net-researcher) a question and get its answer.',
    parameters: obj({ profile: str('Hermes profile name (default profile when empty)'), message: str('Question or task') }, ['message']),
    run: async ({ profile, message }, ctx) => {
      if (profile && !/^[\w.-]+$/.test(profile)) throw new Error('Invalid Hermes profile name.');
      const args = [...(profile ? ['-p', profile] : []), 'chat', '--query-file', '-', '--format', 'text', '-Q'];
      const r = await run('hermes', args, { input: message, timeout: 20 * 60_000, signal: ctx.signal });
      return { text: truncate((r.stdout || r.stderr).replace(/\n?session_id: \S+\s*$/, '').trim(), 20000), isError: r.code !== 0 };
    },
  },
  // ---------- knowledge (added automatically when an agent has knowledge) ----------
  {
    name: 'knowledge_search',
    group: 'knowledge',
    risk: 'none',
    description: 'Search your knowledge files. Returns the best matching passages with file and line.',
    parameters: obj({ query: str('What to look for') }, ['query']),
    run: async ({ query }, ctx) => {
      const hits = kb.searchKnowledge(ctx.agent, query);
      return { text: hits.length ? hits.map((h) => `### ${h.file}:${h.line}\n${h.text}`).join('\n\n') : 'Nothing matched.' };
    },
  },
  {
    name: 'knowledge_read',
    group: 'knowledge',
    risk: 'none',
    description: 'Read one of your knowledge files (400 lines at a time).',
    parameters: obj({ file: str('File name as listed'), from_line: { type: 'number' } }, ['file']),
    run: async ({ file, from_line = 1 }, ctx) => {
      const r = kb.readKnowledge(ctx.agent, file, from_line);
      return { text: `${r.file} lines ${r.from}-${r.to} of ${r.total}\n\n${r.text}` };
    },
  },
  // ---------- files ----------
  {
    name: 'list_files',
    group: 'files',
    risk: 'none',
    description: 'List a folder (relative paths start in your workspace).',
    parameters: obj({ path: str('Folder (default: workspace)') }),
    run: async ({ path: p = '.' }, ctx) => {
      const { abs, ok } = resolveInside(ctx.agent, p);
      if (!ok) throw new Error(`${abs} is outside the folders this agent may use. Add it in Settings > Allowed folders.`);
      const items = fs.readdirSync(abs, { withFileTypes: true }).slice(0, 500);
      return { text: `${abs}\n${items.map((d) => `${d.isDirectory() ? '[dir] ' : ''}${d.name}`).join('\n')}` };
    },
  },
  {
    name: 'read_file',
    group: 'files',
    risk: 'none',
    description: 'Read a text file (workspace, knowledge, outputs or allowed folders).',
    parameters: obj({ path: str('File path') }, ['path']),
    run: async ({ path: p }, ctx) => {
      const { abs, ok } = resolveInside(ctx.agent, p);
      if (!ok) throw new Error(`${abs} is outside the folders this agent may use.`);
      return { text: truncate(fs.readFileSync(abs, 'utf8'), 60000) };
    },
  },
  {
    name: 'write_file',
    group: 'files',
    risk: 'low',
    description: 'Create or overwrite a text file in your workspace or an allowed folder. Returns the full path.',
    parameters: obj({ path: str('File path (relative = workspace)'), content: str('File contents') }, ['path', 'content']),
    run: async ({ path: p, content }, ctx) => {
      const { abs, ok } = resolveInside(ctx.agent, p, { write: true });
      if (!ok) throw new Error(`${abs} is outside the folders this agent may write to.`);
      ensureDir(path.dirname(abs));
      fs.writeFileSync(abs, content);
      return { text: `Wrote ${abs} (${Buffer.byteLength(content)} bytes)` };
    },
  },
  // ---------- orca ----------
  {
    name: 'orca',
    group: 'orca',
    // Reading state is safe; anything else (spawning agents, terminals) needs a yes.
    risk: ({ args = [] }) => (['status', 'agent-context', 'search'].includes(args[0]) || (args[0] === 'skills' && args[1] === 'list') || (args[0] === 'reference' && ['list', 'find'].includes(args[1])) ? 'none' : 'high'),
    description: 'Run the Orca CLI with these arguments, e.g. ["status"], ["agent-context"] (prints every command), ["skills","list"].',
    parameters: obj({ args: { type: 'array', items: { type: 'string' } } }, ['args']),
    run: async ({ args }, ctx) => {
      const r = await run('orca', args, { timeout: 5 * 60_000, signal: ctx.signal });
      return { text: truncate((r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim() || `(exit ${r.code})`, 20000), isError: r.code !== 0 };
    },
  },
  // ---------- shell ----------
  {
    name: 'run_command',
    group: 'shell',
    risk: 'high',
    description: 'Run a PowerShell command on this PC and return its output. Starts in your workspace.',
    parameters: obj({ command: str('PowerShell command'), cwd: str('Working folder'), timeout_sec: { type: 'number' } }, ['command']),
    run: async ({ command, cwd, timeout_sec = 300 }, ctx) => {
      const r = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { cwd: cwd || workspaceOf(ctx.agent), timeout: timeout_sec * 1000, signal: ctx.signal });
      return { text: truncate(`exit ${r.code}\n${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ''}`, 20000), isError: r.code !== 0 };
    },
  },
  // ---------- always on ----------
  {
    name: 'notify_user',
    group: 'core',
    risk: 'none',
    description: 'Show the user a notification in the dashboard (and on Telegram when telegram=true and it is set up).',
    parameters: obj({ text: str('Message'), telegram: { type: 'boolean' } }, ['text']),
    run: async ({ text, telegram }, ctx) => {
      emit('toast', { text: `${ctx.agent.name}: ${text}` });
      log('notify', `${ctx.agent.name}: ${text}`, { agentId: ctx.agent.id });
      if (telegram) await social.sendTelegram(`${ctx.agent.name}: ${text}`).catch(() => {});
      return { text: 'The user has been notified.' };
    },
  },
];

const BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export function toolsForAgent(agent) {
  const groups = new Set(['core', ...(agent.toolGroups || [])]);
  if (kb.knowledgeFiles(agent).length) groups.add('knowledge');
  return TOOLS.filter((t) => groups.has(t.group));
}

export function toolDefs(agent) {
  return toolsForAgent(agent).map(({ name, description, parameters }) => ({ name, description, parameters }));
}

export const allTools = () => TOOLS.map(({ name, group, risk, description }) => ({ name, group, risk: typeof risk === 'function' ? 'varies' : risk, description }));

export function needsApproval(agent, risk, toolName) {
  // "Always allow" never covers high-risk calls of tools whose risk depends on the arguments.
  if ((agent.alwaysAllow || []).includes(toolName)) return false;
  const mode = agent.autonomy || 'auto';
  if (mode === 'full') return false;
  if (mode === 'auto') return risk === 'high';
  return risk === 'low' || risk === 'high';
}

// Ask the user when the agent's autonomy says so. Returns null when it may go ahead, else a refusal result.
export async function gate(agent, name, risk, args, ctx = {}, detail = null) {
  if (!needsApproval(agent, risk, name)) return null;
  const d = await requestApproval({
    kind: 'tool',
    title: `${agent.name} wants to use ${name}`,
    detail: detail ?? describeCall(name, args),
    agentId: agent.id,
    agentName: agent.name,
    data: { tool: name, args, runId: ctx.runId },
  });
  if (!d.approved) return { text: `The user said no${d.message ? `: ${d.message}` : ''}. Don't retry the same thing; ask what they want instead.`, isError: true, denied: true };
  if (d.always && agent.id && !agent.id.startsWith('_')) {
    const fresh = agentStore.get(agent.id);
    if (fresh) {
      fresh.alwaysAllow = [...new Set([...(fresh.alwaysAllow || []), name])];
      agentStore.save(fresh);
    }
  }
  return null;
}

// Run a tool for an agent, asking the user first when its settings say so.
export async function callTool(agent, name, args = {}, ctx = {}) {
  const tool = BY_NAME.get(name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  if (!toolsForAgent(agent).includes(tool)) throw new Error(`${agent.name} isn't allowed to use ${name}. Turn on the "${tool.group}" tools for it.`);
  args = args && typeof args === 'object' ? args : {};
  let risk = 'high';
  try {
    risk = typeof tool.risk === 'function' ? tool.risk(args) : tool.risk;
  } catch {
    /* treat as high */
  }
  // For tools whose risk depends on arguments, "Always allow" only skips the low-risk form.
  const allowName = typeof tool.risk === 'function' && risk === 'high' ? `${name}:high` : name;
  const refused = await gate(agent, allowName, risk, args, ctx, describeCall(name, args));
  if (refused) return refused;
  if (ctx.signal?.aborted) return { text: 'Stopped.', isError: true };
  try {
    const r = await tool.run(args, { ...ctx, agent });
    return { text: String(r?.text ?? ''), images: r?.images || [], isError: !!r?.isError };
  } catch (e) {
    return { text: `Error: ${e.message}`, isError: true };
  }
}

function describeCall(name, args) {
  if (name === 'run_command') return args.command;
  if (name.endsWith('_run_script') || name === 'blender_run_python') return args.code;
  if (name === 'write_file') return `${args.path}\n\n${String(args.content || '').slice(0, 1500)}`;
  if (name === 'ffmpeg' || name === 'orca') return `${name} ${(args.args || []).join(' ')}`;
  return JSON.stringify(args, null, 2);
}

// ---------- helpers ----------
function htmlToText(html) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
  return (title ? `Title: ${title}\n\n` : '') + html
    .replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article|header|footer)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

async function runJsx(appId, code) {
  const exe = programExe(appId);
  if (!exe) throw new Error(`${appId === 'photoshop' ? 'Photoshop' : 'After Effects'} was not found. Set its path in Settings.`);
  const outFile = tmpFile('jsx-out.txt').replace(/\\/g, '/');
  const script = tmpFile('script.jsx');
  const wrapped = `#target ${appId === 'photoshop' ? 'photoshop' : 'aftereffects'}
(function(){
  var __f = new File(${JSON.stringify(outFile)});
  function log(v){ __f.encoding = "UTF-8"; __f.open("a"); __f.writeln(String(v)); __f.close(); }
  try {
    var __r = (function(){ ${code}
    })();
    if (__r !== undefined) log(__r);
  } catch (e) { log("ERROR: " + e + (e.line ? " (line " + e.line + ")" : "")); }
  log("__DONE__");
})();`;
  fs.writeFileSync(script, wrapped);
  if (appId === 'photoshop') launchDetached(exe, [script]);
  else launchDetached(exe, ['-r', script]);
  const started = Date.now();
  while (Date.now() - started < 5 * 60_000) {
    await new Promise((r) => setTimeout(r, 1000));
    if (exists(outFile)) {
      const t = fs.readFileSync(outFile, 'utf8');
      if (t.includes('__DONE__')) {
        const text = t.replace(/__DONE__\s*$/, '').trim();
        return { text: text || 'Script finished.', isError: /^ERROR:/m.test(text) };
      }
    }
  }
  return { text: 'The script was sent, but no answer came back within 5 minutes (the app may still be starting, or a dialog is open).', isError: true };
}

export const TOOL_ROOT = ROOT;
export const HOME_DIR = HOME;
