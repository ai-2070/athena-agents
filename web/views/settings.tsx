// Settings > General & keys: keys, the Brain, defaults, local model servers, program paths, limits.
// Switches about the Brain save at once; the rest is saved with "Save settings", which sends only what changed.
import { Button } from '../ui/button.tsx';
import { Pill } from '../ui/marks.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { GET, POST, PUT, attempt, toast, refreshSoon, navigate } from '../core.ts';
import { brainModelChip } from '../models.ts';
import { memoryButton, BRAIN } from '../memory.tsx';
import { FieldRow, Row, Section, Segmented, SwitchRow } from '../ui/controls.tsx';
import { DomNode, Icon, reactPage, useAppState } from '../ui/react.tsx';
import { logo } from '../icons.ts';
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
    <div className="flex flex-col gap-12 max-lg:gap-10">
      <Section title="Engines on this PC" description="The programs your agents can run on. They are found by themselves.">
        <Engines data={data} reload={reload} />
      </Section>

      <Section title="API keys" description="For models you pay for by use. A saved key stays on this PC and is never shown again.">
        <div className={AI_LIST}>
          <SecretField k="openrouterKey" mark={<Mark brand="openrouter" />} secrets={secrets} reload={reload} label="OpenRouter key" placeholder="sk-or-…" hint={<span>One key for hundreds of models (Claude, GPT, Gemini, Llama, DeepSeek…). Get it at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>. Also usable by Claude Code agents.</span>} />
          <SecretField k="anthropicKey" mark={<Mark brand="anthropic" />} optional secrets={secrets} reload={reload} label="Anthropic API key" placeholder="sk-ant-…" hint={'For Claude Code agents set to "Anthropic API key" instead of your subscription.'} />
        </div>
      </Section>

      <Section title="The Brain's model" description="The Brain oversees the project: it answers about it and its files, builds teams and agents, writes PROJECT.md and hands work out.">
        <Row title="Model" titleId="brain-model-label" description="It can run on Claude Code, OpenRouter, Hermes or Codex. Claude Code and Codex can also open files in the project folder.">
          <DomNode make={() => brainModelChip({ prefix: '', onChange: (b) => (s.brain = b) })} deps={[]} />
        </Row>
        <Row title="Memory" description="What the Brain remembers across its conversations in this project. Read or change it any time.">
          <DomNode make={() => memoryButton(BRAIN, 'The Brain')} deps={[]} />
        </Row>
        <SavedSwitch
          field="brainApproves"
          initial={s.brainApproves !== false}
          on="The Brain approves for you"
          off="Every request comes to you"
          reload={reload}
          title="The Brain approves"
          description="When an agent or team asks permission, the Brain allows routine, on-task work by itself and only passes the risky or unclear requests (deleting, pushing, sending, secrets, anything outside the project) to Needs you. Workflow checkpoints and Outbox posts and DMs always wait for you."
        />
        <SavedSwitch
          field="brainFollowsUp"
          initial={s.brainFollowsUp !== false}
          on="The Brain checks on the work it hands out"
          off="The Brain hands work out and leaves it to them"
          reload={reload}
          title="The Brain follows up"
          description="When a team or agent finishes work the Brain handed them, it checks the result. Something missing: it asks them for it (twice at most). Done, stuck, or they need you: it tells you in the Brain chat. Off: it only hands the work out, and stops checking on work it handed out before."
        />
        <SavedSwitch
          field="brainAnyGitHub"
          initial={s.brainAnyGitHub === true}
          on="The Brain may install skills from any GitHub link"
          off="The Brain installs only from links you give"
          reload={reload}
          title="Install skills from any GitHub link"
          description="Off: the Brain installs skills only from GitHub repos you named in the Brain chat yourself. On: also from links it finds in files, pages or agents' answers. Skills are instructions your agents follow, so only turn this on if you trust where those links come from."
        />
      </Section>

      <Section title="Defaults for new agents" description="What a new agent starts with. You can change it for each agent.">
        <Row title="Brain" description="What a new agent thinks with." stack>
          <Segmented label="Brain" options={data.engineList.map((e) => ({ value: e.id, label: e.label }))} value={engine} onChange={(v) => (setEngine(v), setP('defaults.engine', v))} />
        </Row>
        <FieldRow label="Claude Code model">
          <input className="code" defaultValue={s.defaults.claudeModel} onChange={(e) => setP('defaults.claudeModel', e.target.value)} />
        </FieldRow>
        <FieldRow label="API model">
          <input className="code" defaultValue={s.defaults.openrouterModel} onChange={(e) => setP('defaults.openrouterModel', e.target.value)} />
        </FieldRow>
        <Row title="Autonomy" titleId="default-autonomy-label" description="How much an agent may do before it asks you.">
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
        </Row>
      </Section>

      <Section title="Limits" description="Stops a run that goes on too long or costs too much.">
        <FieldRow label="Max tool steps per message" hint="API-model agents stop after this many tool rounds." size="sm">
          <input type="number" min={1} max={100} defaultValue={s.maxToolSteps} onChange={(e) => setP('maxToolSteps', Number(e.target.value))} />
        </FieldRow>
        <FieldRow label="Cost limit per message (USD)" hint="OpenRouter runs stop past this. 0 = no limit." size="sm">
          <input type="number" min={0} step="0.5" defaultValue={s.costLimitUsdPerRun} onChange={(e) => setP('costLimitUsdPerRun', Number(e.target.value))} />
        </FieldRow>
      </Section>

      {/* Chat memory: compacting long chats (server/compaction.ts) */}
      <Section id="chat-memory" title="Chat memory" description="Long chats fill up the model’s memory. Compacting turns the older messages into a short history the agent keeps reading, and keeps the latest ones in full.">
        <Row title="Where you see it" description="Every message stays in the chat for you, marked “Compacted” where it happened; open the mark to read or edit what the agent remembers. You can also press Compact in a chat, or type /compact." />
        <SwitchRow checked={compaction.auto} onChange={(on) => setC('auto', on)} title="Compact long chats automatically" />
        <SwitchRow
          checked={compaction.engineOwn !== false}
          onChange={(on) => setC('engineOwn', on)}
          title="Let Claude Code, Codex, Hermes, pi, oh-my-pi and OpenClaw compact on their own"
          description="They compact their own sessions when nearly full, keeping their prompt cache and what they know about their tools. The dashboard then compacts their chats only when you ask (Compact, /compact), or when one says the chat is too long. Off: the dashboard compacts them too, at the share below, and starts a new session from its compacted history. API-model agents are always compacted here."
        />
        <SwitchRow
          checked={compaction.instant}
          onChange={(on) => setC('instant', on)}
          title="Instant compaction"
          description="Instant keeps the original words, cut to fit: long messages are shortened, tool calls become one line and their results are left out (the agent can read any of them back). No model call, so it takes no time and costs nothing. Off: the Brain’s model writes a summary instead (slower, smaller)."
        />
        <FieldRow label="Messages kept in full" hint="Up to this many of the latest messages (yours and the agent’s, with their tool calls) stay word for word, as far as the size budget allows. The rest is compacted." size="sm">
          <input type="number" min={0} max={1000} defaultValue={s.compaction.keepMessages} onChange={(e) => setP('compaction.keepMessages', Number(e.target.value))} />
        </FieldRow>
        <FieldRow label="Compact at (% of the context window)" hint="Compacts when the agent’s memory of a chat reaches this share of the model’s context window." size="sm">
          <input type="number" min={10} max={95} defaultValue={s.compaction.thresholdPercent} onChange={(e) => setP('compaction.thresholdPercent', Number(e.target.value))} />
        </FieldRow>
        <FieldRow label="Context window (tokens)" hint="Leave empty to use what each engine or model says (Claude Code 200k, or 1M for a “[1m]” model). Set 1000000 if your models have a 1M-token window: everything the compaction keeps grows with the window." size="sm">
          <input type="number" min={0} step={1000} defaultValue={s.compaction.windowTokens || ''} placeholder="auto" onChange={(e) => setP('compaction.windowTokens', Number(e.target.value) || 0)} />
        </FieldRow>
      </Section>

      <Section title="Local and custom models" description="Models that run on this PC, or on a server you point to.">
        <FieldRow label="LM Studio server" hint="In LM Studio: Developer > Start server." size="lg">
          <input className="code" defaultValue={s.providers.lmstudio.baseUrl} onChange={(e) => setP('providers.lmstudio.baseUrl', e.target.value)} />
        </FieldRow>
        <FieldRow label="Ollama server" size="lg">
          <input className="code" defaultValue={s.providers.ollama.baseUrl} onChange={(e) => setP('providers.ollama.baseUrl', e.target.value)} />
        </FieldRow>
        <FieldRow label="Custom OpenAI-compatible URL" size="lg">
          <input className="code" defaultValue={s.providers.custom.baseUrl} placeholder="https://api.example.com/v1" onChange={(e) => setP('providers.custom.baseUrl', e.target.value)} />
        </FieldRow>
        <SecretField k="customKey" secrets={secrets} reload={reload} label="Custom provider key" placeholder="key" />
      </Section>

      <Section title="Programs" description="Their places are found by themselves. Set one only to pick a different version.">
        <FieldRow label="ComfyUI address" size="lg">
          <input className="code" defaultValue={s.comfyui.url} placeholder="auto (tries :8188 and :8000)" onChange={(e) => setP('comfyui.url', e.target.value.trim())} />
        </FieldRow>
        <FieldRow label="Extra ComfyUI workflow folders" size="lg">
          <textarea className="code" rows={2} defaultValue={(s.comfyui.workflowDirs || []).join('\n')} placeholder="One folder per line" onChange={(e) => setP('comfyui.workflowDirs', lines(e.target.value))} />
        </FieldRow>
        {PROGRAM_PATHS.map(([k, label]) => (
          <FieldRow key={k} label={`${label} path`} size="lg">
            <input className="code" defaultValue={s.paths[k] || ''} placeholder="auto" onChange={(e) => setP(`paths.${k}`, e.target.value.trim())} />
          </FieldRow>
        ))}
      </Section>

      <Section title="Allowed folders" description="Where agents may use their file tools, besides their own workspace.">
        <FieldRow label="Folders every agent may read and write (file tools)" hint="Each agent can always use its own workspace and knowledge." size="lg">
          <textarea className="code" rows={3} defaultValue={(s.allowedFolders || []).join('\n')} placeholder="C:\Users\you\Videos" onChange={(e) => setP('allowedFolders', lines(e.target.value))} />
        </FieldRow>
      </Section>

      {/* what isn't saved on its own: stays at the bottom right of the window while you scroll */}
      <div className="pointer-events-none sticky bottom-20 z-10 flex justify-end">
        <Button className="pointer-events-auto shadow-lift" onClick={() => void save()}>Save settings</Button>
      </div>
    </div>
  );
}

/** A switch that saves on its own. When saving fails it shows what is really set again. */
function SavedSwitch({ field, initial, on, off, reload, title, description }: { field: keyof Settings; initial: boolean; on: string; off: string; reload: () => Promise<unknown>; title: string; description?: ReactNode }) {
  const [value, setValue] = useState(initial);
  const change = async (next: boolean) => {
    setValue(next);
    const saved = await attempt(() => PUT('/settings', { [field]: next }), next ? on : off);
    if (saved) refreshSoon(0);
    else await reload();
  };
  return <SwitchRow checked={value} onChange={(v) => void change(v)} title={title} description={description} />;
}

/** A provider's mark: its brand logo, else its own glyph (Hermes, pi… have no logo). */
function Mark({ brand, glyph }: { brand?: string; glyph?: string }) {
  // near-black brand colours (Anthropic, OpenAI) draw in the text colour, so they show on a dark page too
  const color = brand && DARK_BRANDS.has(brand) ? 'currentColor' : null;
  return <DomNode as="span" className="ai-mark grid size-8 place-items-center rounded-ctl bg-panel-2 font-sans text-[16px] leading-none font-semibold text-ink [&_svg]:size-[17px]" make={() => (brand && logo(brand, 18, color)) || document.createTextNode(glyph || '•')} deps={[brand, glyph]} />;
}
const DARK_BRANDS = new Set(['anthropic', 'openai']);

// AI keys: one row per engine or key (ai-row, ai-name, ai-mark, ai-key and ai-list stay for the tests)
const AI_LIST = 'ai-list divide-y divide-line';
const AI_ROW = 'ai-row grid grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-x-3.5 px-5 py-4 [&.flash-find]:rounded-ctl max-[561px]:grid-cols-[32px_minmax(0,1fr)] max-[561px]:gap-y-3';
const AI_MAIN = 'flex min-w-0 flex-col gap-1';
const AI_HEAD = 'flex min-h-8 flex-wrap items-center gap-x-2.5 gap-y-1';
const AI_NAME = 'ai-name font-sans text-[14px] leading-[1.3] font-medium text-ink';
const AI_NOTE = 'max-w-[62ch] text-[13px] leading-[1.5] text-dim [&_a]:text-accent [&_a]:underline-offset-2';
export const AI_VERSION = 'font-mono text-[12px] leading-[1.3] font-normal text-dim tabular-nums';

/** One engine or key: its mark, name and status, a line about it, and what you can do on the right.
 *  below: more under the line (an install command). */
function AiRow({ mark, name, status, note, below, children }: { mark: ReactNode; name: ReactNode; status?: ReactNode; note?: ReactNode; below?: ReactNode; children?: ReactNode }) {
  return (
    <div className={AI_ROW}>
      {mark}
      <div className={AI_MAIN}>
        <div className={AI_HEAD}>
          <span className={AI_NAME}>{name}</span>
          {status}
        </div>
        {note ? <div className={AI_NOTE}>{note}</div> : null}
        {below}
      </div>
      {children ? <div className="flex min-h-8 items-center gap-2 self-center max-[561px]:col-start-2 max-[561px]:min-h-0">{children}</div> : null}
    </div>
  );
}

/** "found 2.1.311": the pill, and the version when there is one. */
const Found = ({ label = 'found', version }: { label?: string; version?: string | null }) => (
  <>
    <Pill tone="ok">{label}</Pill>
    {version ? <span className={AI_VERSION}>{shortVersion(version)}</span> : null}
  </>
);
/** "2.1.311 (Claude Code)" → "2.1.311": the row already says which program it is. */
const shortVersion = (v: string): string => v.replace(/\s*\([^)]*\)\s*$/, '');

/** An install command to copy into a terminal: a quiet box with the command and a small Copy button. */
function InstallCmd({ cmd }: { cmd: string }) {
  const copy = () => void navigator.clipboard.writeText(cmd).then(() => toast('Copied'), () => toast('Copy it by hand: the clipboard is blocked', 'warn'));
  return (
    <span className="ai-cmd inline-flex max-w-full items-center gap-2 self-start rounded-ctl border border-line bg-panel-2 py-1 pr-1 pl-3">
      <code className="min-w-0 overflow-x-auto border-0 bg-transparent p-0 font-mono text-[12px] leading-normal whitespace-nowrap text-ink select-all">{cmd}</code>
      <Button type="button" variant="ghost" size="tiny" className="flex-none" onClick={copy} aria-label={`Copy ${cmd}`}>
        <Icon name="copy" size={12} />
        Copy
      </Button>
    </span>
  );
}

/** A key: typed in, saved to the server (never shown again), removable, and for OpenRouter testable. Without a mark it is a plain row. */
function SecretField({ k, secrets, reload, label, placeholder, hint, mark, optional = false }: { k: SecretKey; secrets: SecretStatus; reload: () => Promise<unknown>; label: string; placeholder: string; hint?: ReactNode; mark?: ReactNode; optional?: boolean }) {
  const [value, setValue] = useState('');
  const saved = secrets[k];
  const id = `secret-${k}`;
  const store = async () => {
    if (!value.trim()) return toast('Paste the key first', 'warn');
    await attempt(() => POST('/secrets', { key: k, value: value.trim() }), 'Saved');
    setValue('');
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
    <div className={mark ? `${AI_ROW} ai-key` : 'ai-row ai-key grid grid-cols-[minmax(0,1fr)] items-start gap-x-4 px-5 py-4 [&.flash-find]:rounded-ctl'}>
      {mark}
      <div className={AI_MAIN}>
        <div className={AI_HEAD}>
          <label className={AI_NAME} htmlFor={id}>{label}</label>
          {saved.set ? <Found label="saved" version={saved.hint} /> : <Pill>{optional ? 'optional' : 'not set'}</Pill>}
        </div>
        <div className="flex items-stretch gap-2 max-[561px]:flex-wrap">
          <input className="code min-w-0 flex-1 max-[561px]:basis-full" id={id} type="password" autoComplete="off" value={value} placeholder={saved.set ? 'Paste a new key to replace it' : placeholder} onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void store()} />
          <Button size="small" className="h-auto! min-h-9.5" disabled={!value.trim()} onClick={() => void store()}>
            Save
          </Button>
          {k === 'openrouterKey' && saved.set ? (
            <Button variant="ghost" size="small" className="h-auto! min-h-9.5" onClick={() => void test()}>
              Test
            </Button>
          ) : null}
          {saved.set ? (
            <Button variant="ghost" size="small" className="h-auto! min-h-9.5" onClick={() => void remove()}>
              Remove
            </Button>
          ) : null}
        </div>
        {hint ? <div className={AI_NOTE}>{hint}</div> : null}
      </div>
    </div>
  );
}

// pi, oh-my-pi and OpenClaw: found or not, and how to install them (they sign in to models in their own terminal).
const CLIS: { id: keyof EngineStatus & ('pi' | 'omp' | 'openclaw'); label: string; glyph: string; cmd: string; then: string }[] = [
  { id: 'pi', label: 'pi coding agent', glyph: 'π', cmd: 'npm install -g @earendil-works/pi-coding-agent', then: 'Then sign in to a model provider with /login in pi.' },
  { id: 'omp', label: 'oh-my-pi', glyph: 'Ω', cmd: 'bun install -g @oh-my-pi/pi-coding-agent', then: 'Needs Bun. Then sign in with /login in omp.' },
  { id: 'openclaw', label: 'OpenClaw', glyph: '🦞', cmd: 'npm install -g openclaw', then: 'Then run openclaw onboard.' },
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
    <div className={AI_LIST}>
      <AiRow mark={<Mark brand="claude" />} name="Claude Code" status={cc.installed ? <Found version={cc.version} /> : <Pill tone="bad">not installed</Pill>} note={cc.installed ? 'Agents on "My Claude login" use your Claude subscription. Nothing to paste.' : 'Install Claude Code to run agents on your Claude subscription.'} />
      <AiRow
        mark={<Mark brand="openai" />}
        name="OpenAI Codex"
        status={!cx.installed ? <Pill>not installed</Pill> : cx.loggedIn ? <Found label="signed in" version={cx.version} /> : <><Pill tone="warn">not signed in</Pill>{cx.version ? <span className={AI_VERSION}>{cx.version}</span> : null}</>}
        note={!cx.installed ? 'Installs the official CLI with npm (npm install -g @openai/codex). Then sign in with your ChatGPT account.' : cx.loggedIn ? 'Agents set to Codex use your ChatGPT login.' : 'Sign in opens a terminal running "codex login": follow the link, then press Recheck.'}
      >
        {!cx.installed ? (
          <Button size="small" disabled={installing} onClick={() => void install()}>
            {installing ? 'Installing…' : 'Install Codex'}
          </Button>
        ) : (
          <>
            {cx.loggedIn ? null : (
              <Button size="small" onClick={() => void signIn()}>
                Sign in
              </Button>
            )}
            <Button variant="ghost" size="small" onClick={() => void recheck()}>
              Recheck
            </Button>
          </>
        )}
      </AiRow>
      <AiRow mark={<Mark glyph="☤" />} name="Hermes" status={data.engines.hermes.installed ? <Found /> : <Pill>not installed</Pill>} note={data.engines.hermes.installed ? 'Agents can run on your Hermes profiles.' : null} />
      {CLIS.map(({ id, label, glyph, cmd, then }) => {
        const st: Partial<EngineStatus['pi']> = data.engines[id] || {};
        return <AiRow key={id} mark={<Mark glyph={glyph} />} name={label} status={st.installed ? <Found version={st.version} /> : <Pill>not installed</Pill>} note={st.installed ? null : then} below={st.installed ? null : <InstallCmd cmd={cmd} />} />;
      })}
    </div>
  );
}

export const title = () => 'Settings';
export const { render, unmount } = reactPage(() => <GeneralTab />);
