// What the page shows about the dashboard and this PC (shared/api/status.ts).
import { implement } from '@orpc/server';
import { status as contract } from '../../shared/api/status.ts';
import * as store from '../store.ts';
import * as engines from '../engines/index.ts';
import * as codexEngine from '../engines/codex.ts';
import * as piEngine from '../engines/pi.ts';
import * as openclawEngine from '../engines/openclaw.ts';
import { CLAUDE_MODELS } from '../engines/claude.ts';
import * as usage from '../status.ts';
import * as codexLimits from '../codexlimits.ts';
import * as mcp from '../mcp.ts';
import * as projects from '../projects.ts';
import * as projectSync from '../projectsync.ts';
import * as questions from '../questions.ts';
import * as social from '../social.ts';
import * as terms from '../terminals.ts';
import * as tools from '../tools.ts';
import { listApprovals } from '../approvals.ts';
import { aboutInfo } from '../about.ts';
import { overview } from '../overview.ts';
import { toolStats } from '../toolstats.ts';
import { codexModelList } from '../models.ts';
import { PROVIDERS, listModels } from '../providers.ts';
import { gatewaySupervisor } from '../gateways/live.ts';
import { HOME, PORT, dataPath } from '../util.ts';
import type { AppState, HeadbarInfo, ProviderUsage, UsageLimits } from '../../shared/types.ts';

const os = implement(contract);

/** The page's state: what every page starts from. */
export function appState(): AppState {
  const servers = mcp.listServers();
  return {
    gateways: gatewaySupervisor.summary(),
    agents: store.agents.list().sort((a, b) => (Number(b.pinned) - Number(a.pinned)) || a.name.localeCompare(b.name)),
    // the MCP servers' names and each one's label, service and "use for" (mcp.json read once)
    mcpServers: Object.keys(servers),
    mcpInfo: mcp.serverInfo(servers),
    project: projects.withLogo(store.activeProject()),
    projectSaved: projectSync.saveStatus(),
    projects: store.listProjects().map(projects.withLogo),
    approvals: listApprovals(),
    outboxPending: social.listPosts().filter((p) => p.status === 'pending' || ((p.platform === 'telegram' || p.platform === 'discord') && p.status === 'failed')).length,
    questions: questions.waitingQuestions(),
    runs: engines.activeRuns(),
    engines: engines.engineStatus(),
    engineList: engines.ENGINE_LIST,
    toolGroups: tools.TOOL_GROUPS,
    settings: store.getSettings(),
    secrets: store.secretStatus(),
    accounts: social.listAccounts(),
    terminals: terms.listTerminals(),
    port: PORT,
    home: HOME,
    dataDir: dataPath(),
    desktop: !!process.env.DASH_DESKTOP,
  };
}

/** The header's usage meters: one entry per connected provider that reports usage (the header cycles through them). */
async function headbar(): Promise<HeadbarInfo> {
  const eng = engines.engineStatus();
  // Codex: asked live, like the sidebar (its session logs can be old or missing; they're only the fallback)
  const ox = await codexEngine.checkedStatus();
  const [claude, connectors, or, cxLimits, venice] = await Promise.all([usage.claudeUsage(), usage.claudeConnectors().catch(() => []), usage.openrouterUsage(store.getSecrets().openrouterKey), ox?.installed && ox.loggedIn ? codexLimits.codexLimits() : null, usage.veniceUsage()]);
  const usages = ([
    // Claude Code is always shown when you're signed in; "–" until Anthropic sends numbers
    eng['claude-code'].installed && (claude || eng['claude-code'].loggedIn) && { id: 'claude', name: 'Claude Code', meters: [{ label: 'SESSION', ...(claude?.session || {}) }, { label: 'WEEK', ...(claude?.week || {}) }] },
    or && { id: 'openrouter', name: 'OpenRouter', meters: [or.percent != null ? { label: 'CREDITS', percent: or.percent, text: or.left != null ? `$${or.left.toFixed(2)} left` : null } : null, or.today != null ? { label: 'TODAY', text: `$${or.today.toFixed(2)}` } : null].filter(Boolean) },
    cxLimits && { id: 'codex', name: 'OpenAI Codex', meters: codexLimits.headbarMeters(cxLimits) },
    venice && !venice.expired && venice.accessPermitted && { id: 'venice', name: 'Venice', meters: [
      venice.balances.usd != null ? { label: 'USD', text: `$${venice.balances.usd.toFixed(2)} left` } : null,
      venice.balances.diem != null ? { label: 'DIEM', text: `${venice.balances.diem.toFixed(2)} left` } : null,
      venice.balances.bundled != null ? { label: 'Bundled credits', text: `${venice.balances.bundled.toFixed(2)} left` } : null,
    ].filter(Boolean) },
  ] as (ProviderUsage | false | null | undefined)[]).filter((x): x is ProviderUsage => Boolean(x && x.meters.length));
  return { usage: claude, usages, connectors };
}

/** The sidebar's usage view: your Claude and Codex plan limits, and Codex's free limit resets. cx: limits just read. */
export async function usageLimits(cx: codexLimits.CodexLimits | null = null): Promise<UsageLimits> {
  const eng = engines.engineStatus();
  const cc = eng['claude-code'];
  // (waits for the login check, so a fresh start doesn't say "not signed in" first)
  const ox = await codexEngine.checkedStatus();
  const why = (e: { installed: boolean; loggedIn: boolean }) => (!e.installed ? 'not installed' : !e.loggedIn ? 'not signed in' : undefined);
  const [claude, codex] = await Promise.all([cc.installed ? usage.claudeUsage() : null, cx || (ox?.installed && ox.loggedIn ? codexLimits.codexLimits() : null)]);
  const claudeWindows = [claude?.session && { label: '5h', ...claude.session }, claude?.week && { label: 'Week', ...claude.week }].filter((w) => !!w);
  return {
    // signed in through an API key or not at all, Claude Code has no plan limits to show
    claude: { ready: cc.installed && (cc.loggedIn || !!claude), why: why(cc), windows: claudeWindows },
    codex: { ready: !!(ox?.installed && ox.loggedIn), why: ox ? why(ox) : 'not installed', plan: codex?.plan ?? null, windows: codex?.windows || [], blocked: codex?.blocked, resets: codex?.resets ?? null },
  };
}

export const statusRouter = os.router({
  state: os.state.handler(() => appState()),
  activity: os.activity.handler(() => store.activity(200)),
  headbar: os.headbar.handler(() => headbar()),
  usageLimits: os.usageLimits.handler(() => usageLimits()),
  overview: os.overview.handler(() => overview()),
  tools: os.tools.handler(() => ({ groups: tools.TOOL_GROUPS, tools: tools.allTools() })),
  toolStats: os.toolStats.handler(() => toolStats()),
  models: os.models.handler(({ input: { engine, provider } }) => {
    if (engine === 'claude-code') return CLAUDE_MODELS;
    if (engine === 'hermes') return [];
    if (engine === 'codex') return codexModelList();
    if (engine === 'pi' || engine === 'omp') return piEngine.listModels(engine).catch(() => []);
    if (engine === 'openclaw') return openclawEngine.listModels().catch(() => []);
    return listModels(provider || 'openrouter');
  }),
  providers: os.providers.handler(() => Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label }))),
  about: os.about.handler(({ input }) => aboutInfo({ withStars: input.stars === '1' })),
});
