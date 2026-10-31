// The Skills page's dialogs (React in Base UI dialogs): write or edit a skill, with the Brain's help
// in plain words; install from GitHub; import from Claude Code. Each takes the page's reload().
import { useEffect, useRef, useState } from 'react';
import { GET, POST, PUT, attempt, toast } from './core.ts';
import { historyButton } from './history.tsx';
import { attachTray } from './attach.tsx';
import type { AttachTray } from './attach.tsx';
import { Button } from './ui/button.tsx';
import { Field } from './ui/controls.tsx';
import { Pill } from './ui/marks.tsx';
import { DomNode, Icon } from './ui/react.tsx';
import { openModal } from './ui/overlays.tsx';
import type { ClaudeSkill, Skill, SkillInstallResult } from '../shared/types.ts';

interface Fields {
  name: string;
  description: string;
  body: string;
}

/** The skill editor: new or existing, with the Brain writing or changing it from plain words. */
export async function openEditor(slug: string | null, reload: () => unknown): Promise<void> {
  const s = slug ? await GET<Skill>(`/skills/${slug}`).catch(() => null) : null;
  const tray = attachTray();
  openModal(slug ? `Edit skill · ${s?.name || slug}` : 'New skill', (close) => <SkillEditor slug={slug} s={s} reload={reload} close={close} tray={tray} />, {
    // the files were only for the Brain to read: they go with the dialog
    onClose: () => tray.discard(),
  });
}

function SkillEditor({ slug, s, reload, close, tray }: { slug: string | null; s: Skill | null; reload: () => unknown; close: () => void; tray: AttachTray }) {
  // (dimmed while the Brain writes them: locked below)
  const BUSY = 'in-[.skill-ask.busy~label.field]:opacity-55 in-[.skill-ask.busy~label.field]:cursor-progress';
  const name = useRef<HTMLInputElement>(null);
  const desc = useRef<HTMLTextAreaElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);
  const ask = useRef<HTMLTextAreaElement>(null);
  const [locked, setLocked] = useState(false);
  const [asking, setAsking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const [before, setBefore] = useState<Fields | null>(null);
  const askingRef = useRef(false);
  const editing = slug;
  const fields = (): Fields => ({ name: name.current?.value ?? '', description: desc.current?.value ?? '', body: body.current?.value ?? '' });

  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => ask.current?.focus(), 40);
    return () => clearTimeout(t);
  }, []);
  // the whole dialog takes dropped files, so examples or notes can be dropped anywhere on it
  useEffect(() => {
    const modal = box.current?.closest<HTMLElement>('.modal');
    if (!modal) return;
    return tray.dropZone(modal, 'Drop examples or notes for the Brain');
  }, [tray]);

  const undo = () => {
    if (!before) return;
    if (name.current) name.current.value = before.name;
    if (desc.current) desc.current.value = before.description;
    if (body.current) body.current.value = before.body;
    setBefore(null);
    setStatus('Undone.');
  };

  // Plain words: describe a new skill, or say what to change, and the Brain writes it into the fields
  // below. Nothing is saved until Save (and saving keeps the version from before, in History).
  const runAsk = async () => {
    if (askingRef.current) return;
    const text = ask.current?.value.trim() ?? '';
    if (!text && !tray.count()) return toast(slug ? 'Say what to change first.' : 'Describe the skill first.', 'warn');
    askingRef.current = true;
    setAsking(true);
    // the Brain answers with all three fields: typing in them meanwhile would be lost, so they wait (and so does Save)
    setLocked(true);
    try {
      setStatus(tray.busy() ? 'Uploading files…' : '');
      const attachments = await tray.ready();
      if (!attachments) return void setStatus('');
      setStatus(slug || name.current?.value || body.current?.value ? 'The Brain is changing the skill…' : 'The Brain is writing the skill…');
      const now = fields();
      const draft = await attempt(() => POST<Fields & { note: string }>('/assist/skill', { text, slug: slug || undefined, current: now, attachments }));
      if (!draft) return void setStatus('');
      // (locked, so they match; if they somehow don't, what you typed wins)
      const still = fields();
      if (still.name !== now.name || still.description !== now.description || still.body !== now.body) return void setStatus('You changed the skill meanwhile, so the answer was not used. Ask again.');
      setBefore(now);
      if (name.current) name.current.value = draft.name;
      if (desc.current) desc.current.value = draft.description;
      if (body.current) body.current.value = draft.body;
      setStatus(`${draft.note || 'Done.'} Look it over, then ${slug ? 'Save' : 'Add skill'}.`);
      if (ask.current) ask.current.value = '';
    } finally {
      setLocked(false);
      askingRef.current = false;
      setAsking(false);
    }
  };

  const save = async () => {
    setSaving(true);
    const v = fields();
    const r = await attempt(() => (slug ? PUT(`/skills/${slug}`, v) : POST('/skills', v)), slug ? 'Saved' : 'Skill added');
    setSaving(false);
    if (!r) return;
    close();
    reload();
  };

  return (
    <>
      <div className="modal-body">
        <div ref={box} className="flex flex-col gap-5">
          <div
            className={`skill-ask flex flex-col gap-3 p-4 border border-[color-mix(in_srgb,var(--color-accent)_30%,var(--color-line))] rounded-box bg-[color-mix(in_srgb,var(--color-accent)_5%,var(--color-panel))] ${locked ? 'busy' : ''}`}
          >
            <div className="label flex items-center gap-1.5 text-accent">
              <Icon name="sparkles" size={13} />
              {slug ? ' Change it in plain words' : ' Write it in plain words'}
            </div>
            <textarea
              ref={ask}
              className="skill-ask-input resize-y min-h-13"
              rows={2}
              placeholder={
                slug
                  ? 'What should change? e.g. "Add a section on thumbnails", "Make the rules shorter", "Write it for LinkedIn instead of X"'
                  : 'Describe the skill in your own words. e.g. "How we write release notes: short bullets, user-facing changes first, no jargon, link the PR"'
              }
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void runAsk();
                }
              }}
            />
            <DomNode make={() => tray.el} deps={[]} />
            <div className="flex flex-wrap items-center gap-3">
              <Button size="small" type="button" disabled={asking} onClick={() => void runAsk()}>
                <Icon name="sparkles" size={13} />
                {slug ? 'Change it' : 'Write it'}
              </Button>
              <DomNode as="span" make={() => tray.picker} deps={[]} />
              {before ? (
                <Button variant="ghost" size="small" type="button" title="Put back what the fields said before" onClick={undo}>
                  <Icon name="rotate-ccw" size={13} />Undo
                </Button>
              ) : null}
              <span className="hint flex-1 min-w-0 wrap-anywhere">{status}</span>
            </div>
            <p className="hint m-0">{`${slug ? 'The Brain rewrites the fields below as you ask (what you typed there counts too).' : 'The Brain fills in the fields below.'} Drop examples or notes to learn from. Nothing is saved until you press ${slug ? 'Save' : 'Add skill'}. Ctrl+Enter sends.`}</p>
          </div>
          <Field label="Name">
            <input ref={name} className={BUSY} defaultValue={s?.name || ''} readOnly={locked} placeholder="e.g. Brand voice, Email to clients, YouTube thumbnail checklist" />
          </Field>
          <Field label="When to use it" hint="Agents decide from this line whether the skill fits, so be specific.">
            <textarea ref={desc} className={BUSY} rows={2} defaultValue={s?.description || ''} readOnly={locked} placeholder={'When should an agent use it? e.g. "Use when writing any post, email or reply for the NET brand."'} />
          </Field>
          <Field label="Instructions" hint="Markdown. Steps, rules, examples, what good output looks like. The agent reads this when it uses the skill.">
            <textarea ref={body} className={`code ${BUSY}`} rows={16} defaultValue={s?.body?.trim() || ''} readOnly={locked} placeholder={'# How to do it\n\n1. …\n2. …\n\n## Rules\n- …\n\n## Example\n…'} />
          </Field>
          {s?.files?.length ? (
            <div>
              <div className="label">{`Files with this skill (${s.files.length})`}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {s.files.map((f) => (
                  <Pill key={f.path} tone="dim">
                    {f.path}
                  </Pill>
                ))}
              </div>
            </div>
          ) : null}
          {s ? <p className="hint">{`Saved as data/skills/${s.slug}/SKILL.md, in the same format Claude Code uses. Every change keeps the version from before it (History).`}</p> : null}
        </div>
      </div>
      <div className="modal-foot">
        {editing ? <DomNode as="span" make={() => historyButton('skill', editing, () => (close(), void reload(), void openEditor(editing, reload)))} deps={[]} /> : null}
        <span className="flex-1 min-w-0" />
        <Button variant="ghost" onClick={close}>Cancel</Button>
        <Button disabled={locked || saving} onClick={() => void save()}>{slug ? 'Save' : 'Add skill'}</Button>
      </div>
    </>
  );
}

/** Install skills from a GitHub link: a repo, a folder or a SKILL.md. */
export function openGitHub(reload: () => unknown): void {
  openModal('Install skills from GitHub', (close) => <GitHubDialog reload={reload} close={close} />);
}

function GitHubDialog({ reload, close }: { reload: () => unknown; close: () => void }) {
  const url = useRef<HTMLInputElement>(null);
  const [installing, setInstalling] = useState(false);
  const [result, setResult] = useState<SkillInstallResult | null>(null);
  const go = async () => {
    const input = url.current;
    if (!input || !input.value.trim()) return input?.focus();
    setInstalling(true);
    const r = await attempt(() => POST<SkillInstallResult>('/skills/install', { url: input.value.trim() }));
    setInstalling(false);
    if (!r) return;
    setResult(r);
    if (r.installed.length) reload();
  };
  return (
    <>
      <div className="modal-body">
        <div className="flex flex-col gap-4">
          <Field
            label="GitHub link"
            hint="A repo, a folder or a SKILL.md. Every folder with a SKILL.md at or under the link is installed, with its files (up to 20 skills). Installing from the same place again updates them; the old version stays in History."
          >
            <input ref={url} placeholder="https://github.com/owner/repo/tree/main/skills/my-skill" onKeyDown={(e) => e.key === 'Enter' && void go()} />
          </Field>
          <p className="hint">Skills are instructions your agents follow: install them only from people you trust. Private repos work once you sign in with the GitHub CLI (gh auth login).</p>
          <div className="flex flex-col gap-3">
            {result ? (
              <>
                {result.installed.map((x) => (
                  <div key={x.slug} className="list-row">
                    <Icon name="check" size={14} />
                    <div className="flex-1 min-w-0">
                      <b>{x.name}</b>
                      <span className="hint">{` · ${x.updated ? 'updated' : 'installed'}, ${x.files} file${x.files === 1 ? '' : 's'}`}</span>
                    </div>
                  </div>
                ))}
                {result.skipped.map((x) => (
                  <div key={x} className="list-row">
                    <Icon name="triangle-alert" size={14} />
                    <div className="hint flex-1 min-w-0">{x}</div>
                  </div>
                ))}
                {result.installed.length ? <p className="hint">Give them to an agent, a team or the project with "Give to…" on each card.</p> : null}
              </>
            ) : null}
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <Button variant="ghost" onClick={close}>Close</Button>
        <Button className="gh-install" disabled={installing} onClick={() => void go()}>{installing ? 'Installing…' : 'Install'}</Button>
      </div>
    </>
  );
}

/** Copy skills from ~/.claude/skills into the library. */
export function openImport(claude: ClaudeSkill[], reload: () => unknown): void {
  openModal('Import from Claude Code', (close) => <ImportDialog claude={claude} reload={reload} close={close} />);
}

function ImportDialog({ claude, reload, close }: { claude: ClaudeSkill[]; reload: () => unknown; close: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [, redraw] = useState(0);
  const importSkill = async (c: ClaudeSkill) => {
    setBusy(c.slug);
    const r = await attempt(() => POST('/skills/import', { name: c.slug }), `Imported ${c.name}`);
    setBusy(null);
    if (!r) return; // failed: let them try again
    c.inLibrary = true;
    redraw((n) => n + 1);
    reload();
  };
  return (
    <>
      <div className="modal-body">
        <div className="flex flex-col gap-4">
          <p className="hint">Your Claude Code skills (~/.claude/skills). Importing copies the skill and its files into the dashboard library; the original stays where it is.</p>
          <div className="list">
            {claude.map((c) => (
              <div key={c.slug} className="list-row">
                <div className="skill-ico"><Icon name="puzzle" size={16} /></div>
                <div className="flex-1 min-w-0">
                  <div className="title">{c.name}</div>
                  <div className="hint">{c.description.slice(0, 160)}</div>
                </div>
                {c.inLibrary ? (
                  <Pill tone="ok">in library</Pill>
                ) : (
                  <Button size="small" disabled={busy === c.slug} onClick={() => void importSkill(c)}>Import</Button>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <Button onClick={close}>Done</Button>
      </div>
    </>
  );
}
