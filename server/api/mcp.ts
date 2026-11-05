// MCP servers and the engines' own setup (shared/api/mcp.ts). server/mcp.ts refuses a server it can't save in plain
// words; those are 400s here.
import { implement } from '@orpc/server';
import { engines as enginesContract, mcp as mcpContract } from '../../shared/api/mcp.ts';
import { internalToken, log } from '../store.ts';
import * as mcp from '../mcp.ts';
import * as programs from '../programs.ts';
import * as codexEngine from '../engines/codex.ts';
import * as piEngine from '../engines/pi.ts';
import * as openclawEngine from '../engines/openclaw.ts';
import { listProfiles } from '../engines/hermes.ts';
import * as codexLimits from '../codexlimits.ts';
import { PORT, clearWhichCache, run, which } from '../util.ts';
import { usageLimits } from './status.ts';
import { refuse, refusing } from './refuse.ts';

const m = implement(mcpContract);
const e = implement(enginesContract);

export const mcpRouter = m.router({
  list: m.list.handler(async () => {
    const servers = mcp.listServers();
    // (keys, logins and the bridge's token stay hidden here: bridge gives the bridge config to copy)
    const bridge = mcp.bridgeServerConfig('');
    return {
      servers: mcp.hiddenServers(servers),
      info: mcp.serverInfo(servers),
      presets: mcp.presetAvailability(servers),
      suggested: mcp.suggestPresets(await programs.discoverPrograms(), servers),
      importable: mcp.importableServers().map((s) => mcp.hideSecrets(s)),
      bridge: { ...bridge, env: { ...bridge.env, DASH_TOKEN: mcp.HIDDEN } },
    };
  }),
  bridge: m.bridge.handler(() => mcp.bridgeServerConfig('')),
  save: m.save.handler(({ input: { name, ...server } }) => refusing(() => mcp.saveServer(name, server))),
  remove: m.remove.handler(({ input }) => (mcp.removeServerEverywhere(input.name), { ok: true as const })),
  test: m.test.handler(async ({ input }) => ({ tools: await mcp.testServer(input.name) })),
  addPreset: m.addPreset.handler(({ input }) => {
    const preset = mcp.PRESETS.find((x) => x.name === input.name) || refuse('Unknown preset', 404);
    const made = refusing(() => mcp.addPreset(preset.name, { label: input.label, useFor: input.useFor }));
    // (only label and "use for" change: the copies' connections stay open, and an unchanged one isn't saved)
    const servers = mcp.listServers();
    for (const [name, notes] of Object.entries(input.others || {})) if (name !== made.name && servers[name]) mcp.describeCopy(name, { label: notes.label, useFor: notes.useFor });
    return made;
  }),
  import: m.import.handler(({ input }) => {
    const it = mcp.importableServers().find((x) => x.name === input.name && x.source === input.source) || refuse('That server is no longer in its Claude config.', 404);
    return refusing(() => mcp.saveServer(it.name, it));
  }),
});

export const enginesRouter = e.router({
  hermesProfiles: e.hermesProfiles.handler(() => listProfiles()),
  hermesBridge: e.hermesBridge.handler(async () => {
    const cfg = mcp.bridgeServerConfig('');
    const r = await run('hermes', ['mcp', 'add', 'dashboard', '--command', cfg.command, '--env', `DASH_PORT=${PORT}`, `DASH_TOKEN=${internalToken()}`, '--args', ...cfg.args], { timeout: 120000, input: 'y\n' });
    if (r.code !== 0) return refuse((r.stderr || r.stdout).trim().slice(-800) || 'hermes mcp add failed', 500);
    log('mcp', 'Gave Hermes the dashboard tools (hermes mcp add dashboard)');
    return { message: (r.stdout || 'Added.').trim().slice(-800) };
  }),
  // pi and oh-my-pi: the bridge goes in their own mcp.json (neither takes MCP servers per run)
  piBridge: e.piBridge.handler(({ input }) => {
    const flavors: piEngine.PiFlavor[] = input.flavor ? [input.flavor] : (['pi', 'omp'] as const).filter((f) => which(f));
    if (!flavors.length) return refuse('Neither pi nor oh-my-pi is installed on this PC.');
    const files = flavors.map((f) => refusing(() => piEngine.addBridge(f), 500));
    log('mcp', `Gave ${flavors.map((f) => (f === 'pi' ? 'pi' : 'oh-my-pi')).join(' and ')} the dashboard tools (${files.join(', ')})`);
    return { message: `Added to ${files.join(' and ')}. New ${flavors.includes('pi') ? 'pi' : 'oh-my-pi'} sessions have the dashboard tools.`, files };
  }),
  openclawAgents: e.openclawAgents.handler(() => openclawEngine.listAgents().catch(() => [])),
  codexInstall: e.codexInstall.handler(async () => {
    const r = await run('npm', ['install', '-g', '@openai/codex'], { timeout: 10 * 60_000 });
    clearWhichCache();
    codexEngine.refreshStatus();
    if (r.code !== 0) return refuse((r.stderr || r.stdout).trim().slice(-600) || 'npm install failed', 500);
    log('system', 'Installed OpenAI Codex CLI');
    return { message: 'Codex installed. Now sign in.' };
  }),
  codexRefresh: e.codexRefresh.handler(async () => {
    clearWhichCache();
    codexEngine.refreshStatus();
    codexEngine.status();
    await new Promise((r) => setTimeout(r, 3500));
    return codexEngine.status();
  }),
  codexReset: e.codexReset.handler(async ({ input }) => {
    const r = await codexLimits.useCodexReset(input.creditId ?? null);
    log('codex', r.outcome === 'reset' ? 'Used a free Codex limit reset' : `Codex limit reset not used (${r.outcome})`);
    return { outcome: r.outcome, limits: await usageLimits(r.limits) };
  }),
});
