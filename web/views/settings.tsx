// Settings > General & keys: keys, the Brain, defaults, local model servers, program paths, limits.
// Switches about the Brain save at once; the rest is saved with "Save settings", which sends only what changed.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { GET, POST, PUT, attempt, toast, refreshSoon, navigate } from '../core.ts';
import { brainModelChip } from '../models.ts';
import { memoryButton, BRAIN } from '../memory.ts';
import { Field, Segmented, Switch } from '../ui/controls.tsx';
import { DomNode, reactPage, useAppState } from '../ui/react.tsx';
import type { AppState, EngineStatus, SecretKey, SecretStatus, Settings, Terminal } from '../../shared/types.ts';

/** What POST /api/settings/test-openrouter passes on from OpenRouter's /key endpoint. */
interface OpenRouterKeyInfo {
  label?: string;
  limit_remaining?: number | null;
  usage?: number | null;
}
interface Loaded {
  settings: Settings;
  secrets: SecretStatus;
}
type Patch = Record<string, unknown>;

/** Puts value at a dotted path in the patch: setPath(p, 'defaults.engine', 'codex'). */
export function setPath(patch: Patch, path: string, value: unknown): void {
  const keys = path.split('.');
  let o = patch;
  for (const k of keys.slice(0, -1)) o = (o[k] ||= {}) as Patch;
  o[keys.at(-1)!] = value;
}
// Programs whose place can be set by hand (server/programs.ts reads settings.paths[key]).
const PROGRAM_PATHS: [string, string][] = [
  ['blender', 'Blender'],
  ['maya', 'Maya'],
  ['houdini', 'Houdini'],
  ['painter', 'Substance 3D Painter'],
  ['designer', 'Substance 3D Designer'],
  ['photoshop', 'Photoshop'],
  ['aftereffects', 'After Effects'],
  ['premiere', 'Premiere Pro'],
  ['resolve', 'DaVinci Resolve'],
  ['handbrakecli', 'HandBrakeCLI'],
  ['imagemagick', 'ImageMagick (magick)'],
  ['openscad', 'OpenSCAD'],
  ['prusaslicer', 'PrusaSlicer'],
  ['orcaslicer', 'OrcaSlicer'],
  ['nvtt', 'NVIDIA Texture Tools (nvtt_export)'],
  ['comfyui', 'ComfyUI'],
];
const lines = (text: string) => text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);

export function GeneralTab() {
  const data = useAppState();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // a new number re-creates the inputs from what the server has (after a key is saved, or a switch failed)
  const [version, setVersion] = useState(0);
  const load = useCallback(() => GET<Loaded>('/settings').then((r) => (setLoaded(r), setVersion((v) => v + 1))), []);
  useEffect(() => void load(), [load]);
  if (!loaded || !data) return null;
  return <GeneralForm key={version} loaded={loaded} data={data} reload={load} />;
}

function GeneralForm({ loaded, data, reload }: { loaded: Loaded; data: AppState; reload: () => Promise<unknown> }) {
  const { settings: s, secrets } = loaded;
  const patch = useRef<Patch>({});
  const setP = (path: string, value: unknown) => setPath(patch.current, path, value);
  const save = () => attempt(() => PUT('/settings', patch.current), 'Saved').then(() => refreshSoon(0));
  // the few choices drawn from state rather than left to the input
  const [engine, setEngine] = useState(s.defaults.engine);
  const [autonomy, setAutonomy] = useState(s.defaults.autonomy);
  const [compaction, setCompaction] = useState(s.compaction);
  const setC = (k: 'auto' | 'engineOwn' | 'instant', on: boolean) => (setCompaction({ ...compaction, [k]: on }), setP(`compaction.${k}`, on));

  return (
    <div className="two-col">
      <div className="col gap-lg">
        <div className="panel">
          <div className="panel-head">
            <h2>AI keys</h2>
          </div>
          <div className="col gap-lg">
            <Engines data={data} reload={reload} />
            <SecretField k="openrouterKey" secrets={secrets} reload={reload} label="OpenRouter key" placeholder="sk-or-…" hint={<span>One key for hundreds of models (Claude, GPT, Gemini, Llama, DeepSeek…). Get it at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>. Also usable by Claude Code agents.</span>} />
            <SecretField k="anthropicKey" secrets={secrets} reload={reload} label="Anthropic API key (optional)" placeholder="sk-ant-…" hint={'For Claude Code agents set to "Anthropic API key" instead of your subscription.'} />
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>The Brain's model</h2>
          </div>
          <p className="hint">The Brain oversees the project: it answers about the project and its files, builds teams and agents, writes PROJECT.md and hands work out. It can run on Claude Code, OpenRouter, Hermes or Codex. Claude Code and Codex can also open files in the project folder.</p>
          <div className="row mt">
            <Field label="Model" group="brain-model-label">
              <DomNode make={() => brainModelChip({ prefix: '', onChange: (b) => (s.brain = b) })} deps={[]} />
            </Field>
          </div>
          <div className="row mt">
            <DomNode make={() => memoryButton(BRAIN, 'The Brain')} deps={[]} />
            <span className="hint">What the Brain remembers across its conversations in this project. Read or change it any time.</span>
          </div>
          <SavedSwitch field="brainApproves" initial={s.brainApproves !== false} on="The Brain approves for you" off="Every request comes to you" reload={reload}>
            The Brain approves
          </SavedSwitch>
          <p className="hint">When an agent or team asks permission, the Brain allows routine, on-task work by itself and only passes the risky or unclear requests (deleting, pushing, sending, secrets, anything outside the project) to Needs you. Workflow checkpoints and Outbox posts and DMs always wait for you.</p>
          <SavedSwitch field="brainFollowsUp" initial={s.brainFollowsUp !== false} on="The Brain checks on the work it hands out" off="The Brain hands work out and leaves it to them" reload={reload}>
            The Brain follows up
          </SavedSwitch>
          <p className="hint">When a team or agent finishes work the Brain handed them, it checks the result. Something missing: it asks them for it (twice at most). Done, stuck, or they need you: it tells you in the Brain chat. Off: it only hands the work out, and stops checking on work it handed out before.</p>
          <SavedSwitch field="brainAnyGitHub" initial={s.brainAnyGitHub === true} on="The Brain may install skills from any GitHub link" off="The Brain installs only from links you give" reload={reload}>
            Install skills from any GitHub link
          </SavedSwitch>
          <p className="hint">Off: the Brain installs skills only from GitHub repos you named in the Brain chat yourself. On: also from links it finds in files, pages or agents' answers. Skills are instructions your agents follow, so only turn this on if you trust where those links come from.</p>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Defaults for new agents</h2>
          </div>
          <div className="col">
            <Field label="Brain" group="default-engine-label">
              <Segmented label="Brain" options={data.engineList.map((e) => ({ value: e.id, label: e.label }))} value={engine} onChange={(v) => (setEngine(v), setP('defaults.engine', v))} />
            </Field>
            <div className="grid-2">
              <Field label="Claude Code model">
                <input defaultValue={s.defaults.claudeModel} onChange={(e) => setP('defaults.claudeModel', e.target.value)} />
              </Field>
              <Field label="API model">
                <input className="code" defaultValue={s.defaults.openrouterModel} onChange={(e) => setP('defaults.openrouterModel', e.target.value)} />
              </Field>
            </div>
            <Field label="Autonomy" group="default-autonomy-label">
              <Segmented
                label="Autonomy"
                options={[
                  { value: 'ask', label: 'Ask first' },
                  { value: 'auto', label: 'Auto' },
                  { value: 'full', label: 'Full' },
                ]}
                value={autonomy}
                onChange={(v) => (setAutonomy(v), setP('defaults.autonomy', v))}
              />
            </Field>
          </div>
        </div>

        <div className="panel">
          <div className="panel-head">
            <h2>Limits</h2>
          </div>
          <div className="grid-2">
            <Field label="Max tool steps per message" hint="API-model agents stop after this many tool rounds.">
              <input type="number" min={1} max={100} defaultValue={s.maxToolSteps} onChange={(e) => setP('maxToolSteps', Number(e.target.value))} />
            </Field>
            <Field label="Cost limit per message (USD)" hint="OpenRouter runs stop past this. 0 = no limit.">
              <input type="number" min={0} step="0.5" defaultValue={s.costLimitUsdPerRun} onChange={(e) => setP('costLimitUsdPerRun', Number(e.target.value))} />
            </Field>
          </div>
        </div>

        {/* Chat memory: compacting long chats (server/compaction.ts) */}
        <div className="panel" id="chat-memory">
          <div className="panel-head">
            <h2>Chat memory</h2>
          </div>
          <p className="hint">Long chats fill up the model’s memory. Compacting turns the older messages into a short history the agent keeps reading, and keeps the latest messages in full. Every message stays in the chat for you, marked “COMPACTED” where it happened; open the mark to read or edit what the agent remembers. You can also press Compact in a chat, or type /compact.</p>
          <Switch className="mt" checked={compaction.auto} onChange={(on) => setC('auto', on)}>Compact long chats automatically</Switch>
          <Switch className="mt" checked={compaction.engineOwn !== false} onChange={(on) => setC('engineOwn', on)}>Let Claude Code, Codex, Hermes, pi, oh-my-pi and OpenClaw compact on their own</Switch>
          <p className="hint">They compact their own sessions when nearly full, keeping their prompt cache and what they know about their tools. The dashboard then compacts their chats only when you ask (Compact, /compact), or when one says the chat is too long. Off: the dashboard compacts them too, at the share below, and starts a new session from its compacted history. API-model agents are always compacted here.</p>
          <Switch className="mt" checked={compaction.instant} onChange={(on) => setC('instant', on)}>Instant compaction</Switch>
          <p className="hint">Instant keeps the original words, cut to fit: long messages are shortened, tool calls become one line and their results are left out (the agent can read any of them back). No model call, so it takes no time and costs nothing. Off: the Brain’s model writes a summary instead (slower, smaller).</p>
          <div className="grid-2 mt">
            <Field label="Messages kept in full" hint="Up to this many of the latest messages (yours and the agent’s, with their tool calls) stay word for word, as far as the size budget allows. The rest is compacted.">
              <input type="number" min={0} max={1000} defaultValue={s.compaction.keepMessages} onChange={(e) => setP('compaction.keepMessages', Number(e.target.value))} />
            </Field>
            <Field label="Compact at (% of the context window)" hint="Compacts when the agent’s memory of a chat reaches this share of the model’s context window.">
              <input type="number" min={10} max={95} defaultValue={s.compaction.thresholdPercent} onChange={(e) => setP('compaction.thresholdPercent', Number(e.target.value))} />
            </Field>
          </div>
          <div className="mt">
            <Field label="Context window (tokens)" hint="Leave empty to use what each engine or model says (Claude Code 200k, or 1M for a “[1m]” model). Set 1000000 if your models have a 1M-token window: everything the compaction keeps grows with the window.">
              <input type="number" min={0} step={1000} defaultValue={s.compaction.windowTokens || ''} placeholder="auto" onChange={(e) => setP('compaction.windowTokens', Number(e.target.value) || 0)} />
            </Field>
          </div>
        </div>
        <div className="row">
          <button className="btn" onClick={() => void save()}>Save settings</button>
        </div>
      </div>

      <div className="col gap-lg">
        <div className="panel">
          <div className="panel-head">
            <h2>Local and custom models</h2>
          </div>
          <div className="col">
            <Field label="LM Studio server" hint="In LM Studio: Developer > Start server.">
              <input className="code" defaultValue={s.providers.lmstudio.baseUrl} onChange={(e) => setP('providers.lmstudio.baseUrl', e.target.value)} />
            </Field>
            <Field label="Ollama server">
              <input className="code" defaultValue={s.providers.ollama.baseUrl} onChange={(e) => setP('providers.ollama.baseUrl', e.target.value)} />
            </Field>
            <Field label="Custom OpenAI-compatible URL">
              <input className="code" defaultValue={s.providers.custom.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setP('providers.custom.baseUrl', e.target.value)} />
            </Field>
            <SecretField k="customKey" secrets={secrets} reload={reload} label="Custom provider key" placeholder="key" />
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Programs</h2>
          </div>
          <div className="col">
            <Field label="ComfyUI address">
              <input className="code" defaultValue={s.comfyui.url} placeholder="auto (tries :8188 and :8000)" onChange={(e) => setP('comfyui.url', e.target.value.trim())} />
            </Field>
            <Field label="Extra ComfyUI workflow folders">
              <textarea className="code" rows={2} defaultValue={(s.comfyui.workflowDirs || []).join('\n')} placeholder="One folder per line" onChange={(e) => setP('comfyui.workflowDirs', lines(e.target.value))} />
            </Field>
            <p className="hint">Paths below are found automatically. Set one only to pick a different version.</p>
            {PROGRAM_PATHS.map(([k, label]) => (
              <Field key={k} label={`${label} path`}>
                <input className="code" defaultValue={s.paths[k] || ''} placeholder="auto" onChange={(e) => setP(`paths.${k}`, e.target.value.trim())} />
              </Field>
            ))}
          </div>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>Allowed folders</h2>
          </div>
          <Field label="Folders every agent may read and write (file tools)" hint="Each agent can always use its own workspace and knowledge.">
            <textarea className="code" rows={3} defaultValue={(s.allowedFolders || []).join('\n')} placeholder="C:\Users\you\Videos" onChange={(e) => setP('allowedFolders', lines(e.target.value))} />
          </Field>
        </div>
        <div className="panel">
          <div className="panel-head">
            <h2>About</h2>
          </div>
          <div className="kv">
            <span>Address</span>
            <span className="mono">{`http://localhost:${data.port}`}</span>
            <span>Login</span>
            <span>None. Only this PC can open it (it listens on 127.0.0.1).</span>
            <span>Data</span>
            <span className="mono wrap-anywhere">{data.dataDir}</span>
          </div>
          <p className="hint mt">Keys and account tokens are stored in that data folder on this PC and never sent to the browser.</p>
        </div>
      </div>
    </div>
  );
}

/** A switch that saves on its own. When saving fails it shows what is really set again. */
function SavedSwitch({ field, initial, on, off, reload, children }: { field: keyof Settings; initial: boolean; on: string; off: string; reload: () => Promise<unknown>; children: ReactNode }) {
  const [value, setValue] = useState(initial);
  const change = async (next: boolean) => {
    setValue(next);
    const saved = await attempt(() => PUT('/settings', { [field]: next }), next ? on : off);
    if (saved) refreshSoon(0);
    else await reload();
  };
  return (
    <Switch className="mt" checked={value} onChange={(v) => void change(v)}>
      {children}
    </Switch>
  );
}

/** A key: typed in, saved to the server (never shown again), removable, and for OpenRouter testable. */
function SecretField({ k, secrets, reload, label, placeholder, hint }: { k: SecretKey; secrets: SecretStatus; reload: () => Promise<unknown>; label: string; placeholder: string; hint?: ReactNode }) {
  const [value, setValue] = useState('');
  const saved = secrets[k];
  const store = async () => {
    if (!value.trim()) return toast('Paste the key first', 'warn');
    await attempt(() => POST('/secrets', { key: k, value: value.trim() }), 'Saved');
    refreshSoon(0);
    await reload();
  };
  const remove = async () => {
    await attempt(() => POST('/secrets', { key: k, value: '' }), 'Removed');
    refreshSoon(0);
    await reload();
  };
  const test = () =>
    attempt(() => POST<OpenRouterKeyInfo>('/settings/test-openrouter'), (r) => `Key works${r.label ? ` (${r.label})` : ''}${r.limit_remaining != null ? ` · $${Number(r.limit_remaining).toFixed(2)} left` : r.usage != null ? ` · $${Number(r.usage).toFixed(2)} used` : ''}`);
  return (
    <div>
      <Field label={label} hint={hint}>
        <input type="password" autoComplete="off" value={value} placeholder={saved.set ? `saved (${saved.hint}) · type to replace` : placeholder} onChange={(e) => setValue(e.target.value)} />
      </Field>
      <div className="row mt">
        <button className="btn small" onClick={() => void store()}>Save</button>
        {saved.set ? <button className="btn ghost small" onClick={() => void remove()}>Remove</button> : null}
        {k === 'openrouterKey' && saved.set ? <button className="btn ghost small" onClick={() => void test()}>Test</button> : null}
      </div>
    </div>
  );
}

// pi, oh-my-pi and OpenClaw: found or not, and how to install them (they sign in to models in their own terminal).
const CLIS: [keyof EngineStatus & ('pi' | 'omp' | 'openclaw'), string, string][] = [
  ['pi', 'pi coding agent', 'Install: npm install -g @earendil-works/pi-coding-agent. Sign in to a model provider with /login in pi.'],
  ['omp', 'oh-my-pi', 'Install: bun install -g @oh-my-pi/pi-coding-agent (needs Bun). Sign in with /login in omp.'],
  ['openclaw', 'OpenClaw', 'Install: npm install -g openclaw, then run openclaw onboard.'],
];

function Engines({ data, reload }: { data: AppState; reload: () => Promise<unknown> }) {
  const cc = data.engines['claude-code'];
  const cx: Partial<EngineStatus['codex']> = data.engines.codex || {};
  const [installing, setInstalling] = useState(false);
  const later = (ms: number) => setTimeout(() => void reload(), ms);
  const install = async () => {
    setInstalling(true);
    await attempt(() => POST<{ message: string }>('/codex/install'), (r) => r.message);
    refreshSoon(0);
    later(500);
  };
  const signIn = async () => {
    const t = await attempt(() => POST<Terminal>('/terminals', { kind: 'command', command: 'codex', args: ['login'], title: 'Codex sign-in' }));
    if (t) navigate(`#/terminals/${t.id}`);
  };
  const recheck = () =>
    attempt(() => POST<EngineStatus['codex']>('/codex/refresh'), (r) => (r.loggedIn ? 'Codex is signed in' : r.installed ? 'Installed, not signed in yet' : 'Not installed')).then(() => (refreshSoon(0), later(300)));
  return (
    <div className="kv">
      <span>Claude Code</span>
      <span>
        {cc.installed ? (
          <span>
            <span className="pill ok">found</span> {cc.version || ''}
            <div className="hint">Agents on "My Claude login" use your Claude subscription. Nothing to paste.</div>
          </span>
        ) : (
          <span className="pill bad">not installed</span>
        )}
      </span>
      <span>Hermes</span>
      <span>{data.engines.hermes.installed ? <span className="pill ok">found</span> : <span className="pill">not installed</span>}</span>
      {CLIS.map(([id, label, how]) => {
        const st: Partial<EngineStatus['pi']> = data.engines[id] || {};
        return [
          <span key={`${id}-l`}>{label}</span>,
          <span key={`${id}-v`}>
            {st.installed ? (
              <span>
                <span className="pill ok">found</span> {st.version || ''}
              </span>
            ) : (
              <span>
                <span className="pill">not installed</span>
                <div className="hint">{how}</div>
              </span>
            )}
          </span>,
        ];
      })}
      <span>OpenAI Codex</span>
      <span>
        {!cx.installed ? (
          <span>
            <span className="pill">not installed</span>{' '}
            <button className="btn tiny" disabled={installing} onClick={() => void install()}>
              {installing ? 'Installing…' : 'Install Codex'}
            </button>
            <div className="hint">Installs the official CLI with npm (npm install -g @openai/codex). Then sign in with your ChatGPT account.</div>
          </span>
        ) : (
          <span>
            {cx.loggedIn ? <span className="pill ok">signed in</span> : <span className="pill warn">not signed in</span>} {cx.version || ''}{' '}
            {cx.loggedIn ? null : (
              <button className="btn tiny" onClick={() => void signIn()}>Sign in</button>
            )}{' '}
            <button className="btn ghost tiny" onClick={() => void recheck()}>Recheck</button>
            <div className="hint">{cx.loggedIn ? 'Agents set to Codex use your ChatGPT login.' : 'Sign in opens a terminal running "codex login": follow the link, then press Recheck.'}</div>
          </span>
        )}
      </span>
    </div>
  );
}

export const title = () => 'Settings';
export const { render, unmount } = reactPage(() => <GeneralTab />);
