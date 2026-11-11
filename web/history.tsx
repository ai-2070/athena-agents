// Versions of skills, agents, teams and MEMORY.md files: the History window (every kept version, what it changed,
// compared with the current one, and Restore) and Recently deleted (bring one back). The two windows are React now
// (openModal() with React content); the buttons that open them stay plain DOM (domButton), as they were.
import { useState } from 'react';
import type { ReactNode } from 'react';
import { attempt, ago, confirmBox } from './core.ts';
import { projectAt } from './client/connection.ts';
import { rpc, rpcAt } from './client/rpc.ts';
import { domButton } from './ui/dom.ts';
import { icon } from './icons.ts';
import { Button } from './ui/button.tsx';
import { Icon } from './ui/react.tsx';
import { openModal } from './ui/overlays.tsx';
import { SkillMark } from './skillmark.tsx';
import type { DeletedItem, VersionDetail, VersionHistory, VersionKind } from '../shared/types.ts';

const KIND_NAME: Record<VersionKind, string> = { skill: 'skill', agent: 'agent', team: 'team', memory: 'MEMORY.md' };
const byName = (by: string) => (by === 'brain' ? 'the Brain' : by === 'agent' ? 'the agent' : 'you');
const when = (ts: number) => new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

// ---------- a line diff (old → new) ----------
export type DiffLine = { op: ' ' | '-' | '+'; text: string };
/** Lines of a and b, marked kept, removed (only in a) or added (only in b). Plain list when too big to compare. */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length * y.length > 4_000_000)
    return [...x.map((text): DiffLine => ({ op: '-', text })), ...y.map((text): DiffLine => ({ op: '+', text }))];
  // longest common subsequence, from the end
  const n = x.length;
  const m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) (out.push({ op: ' ', text: x[i++] }), j++);
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: '-', text: x[i++] });
    else out.push({ op: '+', text: y[j++] });
  }
  while (i < n) out.push({ op: '-', text: x[i++] });
  while (j < m) out.push({ op: '+', text: y[j++] });
  return out;
}

// a version's text, in a box of its own
const TEXT_BOX =
  'm-0 max-h-[58vh] overflow-auto rounded-ctl border border-line bg-bg px-4 py-3.5 font-mono text-[12.5px] leading-[1.55] font-normal whitespace-pre-wrap wrap-anywhere';
const LINE = {
  kept: '-mx-1.5 px-1.5 text-dim',
  del: '-mx-1.5 bg-red/12 px-1.5 text-red',
  add: '-mx-1.5 bg-ok/10 px-1.5 text-ok',
};

function DiffView({ older, newer }: { older: string; newer: string }) {
  const lines = diffLines(older, newer);
  if (!lines.some((l) => l.op !== ' '))
    return (
      <div>
        <p className="hint">Same as the current one.</p>
        <pre className={TEXT_BOX}>{older}</pre>
      </div>
    );
  return (
    <div>
      <p className="hint">
        <span className={LINE.del}>- only in this version</span> <span className={LINE.add}>+ added since</span>
      </p>
      <pre className={TEXT_BOX}>
        {lines.map((l, i) => (
          <div
            key={i}
            className={l.op === '-' ? LINE.del : l.op === '+' ? LINE.add : LINE.kept}
          >{`${l.op} ${l.text}`}</div>
        ))}
      </pre>
    </div>
  );
}

// a version in the list; the picked one is lit
function VersionRow({
  on,
  title,
  sub,
  onclick,
}: {
  on: boolean;
  title: ReactNode;
  sub: ReactNode;
  onclick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`block w-full cursor-pointer rounded-ctl border px-3.5 py-3 text-left text-ink enabled:hover:bg-panel-2 disabled:cursor-default ${on ? 'border-accent bg-accent/8' : 'border-line bg-transparent'}`}
      onClick={onclick}
      disabled={!onclick}
    >
      <div className="flex items-center gap-2 font-semibold">{title}</div>
      <div className="hint mt-0.5 wrap-anywhere">{sub}</div>
    </button>
  );
}

// ---------- History ----------
interface HistoryProps {
  kind: VersionKind;
  id: string;
  hist: VersionHistory;
  onRestored?: () => void;
  close: () => void;
  /** '/p/<project>' for a project that isn't open (projectAt) */
  at: string;
}

function HistoryDialog({ kind, id, hist, onRestored, close, at }: HistoryProps) {
  const [picked, setPicked] = useState<VersionDetail | null>(null);
  const [compare, setCompare] = useState(true);

  const pick = async (vid: string) => {
    const d = await attempt(() => rpcAt(at).versions.get({ kind, id, vid }));
    if (!d) return;
    setPicked(d);
  };
  const restore = async () => {
    if (!picked) return;
    const what =
      hist.current === null
        ? `Bring back the ${KIND_NAME[kind]} "${picked.name}" as it was on ${when(picked.at)}?`
        : `Put back the version from ${when(picked.at)}? The current one is kept in the history, so you can switch back.`;
    if (!(await confirmBox(what, { ok: hist.current === null ? 'Bring it back' : 'Restore' }))) return;
    if (!(await attempt(() => rpcAt(at).versions.restore({ kind, id, vid: picked.id }), 'Restored'))) return;
    close();
    onRestored?.();
  };

  return (
    <>
      <div className="modal-body">
        <div className="grid min-h-[360px] grid-cols-[minmax(200px,260px)_1fr] gap-5 max-[761px]:grid-cols-[1fr]">
          <div className="flex max-h-[62vh] flex-col gap-2 overflow-auto pr-1 max-[761px]:max-h-[30vh]">
            <VersionRow
              on={!picked}
              title={hist.current === null ? 'Deleted' : 'Current'}
              sub={hist.current === null ? 'not in use any more' : 'what it is now'}
              onclick={picked ? () => setPicked(null) : undefined}
            />
            {hist.versions.length ? (
              hist.versions.map((v) => (
                <VersionRow
                  key={v.id}
                  on={picked?.id === v.id}
                  title={
                    <span>
                      {ago(v.at)}
                      <span className="inline-flex items-center gap-0.75 text-[11.5px] font-normal text-dim">
                        {v.by === 'brain' ? (
                          <Icon name="brain" size={11} />
                        ) : v.by === 'agent' ? (
                          <Icon name="bot" size={11} />
                        ) : null}
                        {byName(v.by)}
                      </span>
                    </span>
                  }
                  sub={
                    v.deleted
                      ? 'its last version, before it was deleted'
                      : v.changes.length
                        ? `then changed: ${v.changes.join(', ')}`
                        : v.note || 'then saved'
                  }
                  onclick={() => void pick(v.id)}
                />
              ))
            ) : (
              <p className="hint px-0.5 py-2">No earlier versions yet. Each change keeps the version from before it.</p>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            {picked ? (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <b>{`Version from ${when(picked.at)}`}</b>
                    <div className="hint">{`Replaced by ${byName(picked.by)}${picked.deleted ? ' (deleted)' : ''}${picked.note ? ` · ${picked.note}` : ''}`}</div>
                  </div>
                  {hist.current !== null ? (
                    <label className="flex flex-wrap items-center gap-2.5">
                      <input type="checkbox" checked={compare} onChange={(e) => setCompare(e.currentTarget.checked)} />
                      <span>Compare with current</span>
                    </label>
                  ) : null}
                </div>
                {compare && hist.current !== null ? (
                  <DiffView older={picked.text} newer={hist.current} />
                ) : (
                  <pre className={TEXT_BOX}>{picked.text}</pre>
                )}
              </>
            ) : hist.current === null ? (
              <p className="hint">Pick a version to see it and bring it back.</p>
            ) : (
              <pre className={TEXT_BOX}>{hist.current}</pre>
            )}
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <span className="hint min-w-0 flex-1">{`${hist.versions.length} earlier version${hist.versions.length === 1 ? '' : 's'} kept`}</span>
        <Button variant="ghost" onClick={close}>
          Close
        </Button>
        <Button onClick={restore} disabled={!picked}>
          {hist.current === null ? 'Bring back this version' : 'Restore this version'}
        </Button>
      </div>
    </>
  );
}

/** The History window of one skill, agent or team. onRestored runs after a version is put back. projectId: a
 *  MEMORY.md of a project that isn't open (an Overview pane). */
export async function openHistory(
  kind: VersionKind,
  id: string,
  { onRestored, projectId }: { onRestored?: () => void; projectId?: string } = {},
): Promise<void> {
  const at = projectAt(projectId);
  const hist = await attempt(() => rpcAt(at).versions.history({ kind, id }));
  if (!hist) return;
  const dlg = openModal(`History · ${hist.name}`, (close) => (
    <HistoryDialog kind={kind} id={id} hist={hist} onRestored={onRestored} close={close} at={at} />
  ));
  dlg.el.classList.add('wide');
}

/** A History button for a skill, agent, team or MEMORY.md. */
export function historyButton(
  kind: VersionKind,
  id: string,
  onRestored?: () => void,
  label = 'History',
  projectId?: string,
): HTMLButtonElement {
  return domButton(
    {
      variant: 'ghost',
      size: 'small',
      type: 'button',
      title: 'Earlier versions: compare and restore',
      onclick: () => openHistory(kind, id, { onRestored, projectId }),
    },
    icon('history', 13),
    label,
  );
}

// ---------- Recently deleted ----------
interface DeletedFailed {
  kind: VersionKind;
  error: string;
}

// a list that couldn't load says so (it isn't "nothing deleted")
async function loadDeleted(kinds: VersionKind[]): Promise<{ items: DeletedItem[]; failed: DeletedFailed[] }> {
  const lists = await Promise.allSettled(kinds.map((k) => rpc.versions.deleted({ kind: k })));
  const items = lists.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).sort((a, b) => b.at - a.at);
  const failed = lists.flatMap((r, i) =>
    r.status === 'rejected' ? [{ kind: kinds[i], error: (r.reason as Error)?.message || 'failed' }] : [],
  );
  return { items, failed };
}

interface DeletedProps {
  kinds: VersionKind[];
  initial: { items: DeletedItem[]; failed: DeletedFailed[] };
  onRestored?: () => void;
  close: () => void;
}

function DeletedDialog({ kinds, initial, onRestored, close }: DeletedProps) {
  const [items, setItems] = useState(initial.items);
  const [failed, setFailed] = useState(initial.failed);
  const [busy, setBusy] = useState<string | null>(null);

  const load = async () => {
    const next = await loadDeleted(kinds);
    setItems(next.items);
    setFailed(next.failed);
  };
  const bringBack = async (it: DeletedItem) => {
    setBusy(it.id);
    if (await attempt(() => rpc.versions.undelete({ kind: it.kind, id: it.id }), `Brought back ${it.name}`)) {
      onRestored?.();
      await load();
    }
    setBusy(null);
  };

  return (
    <>
      <div className="modal-body">
        <div className="flex flex-col gap-2.5">
          <p className="hint">
            {kinds.includes('skill')
              ? 'Deleted skills come back with their extra files. Bring one back and give it to whoever should have it again.'
              : 'An agent comes back without its teams (add it back to them); a team comes back with the members that still exist, so bring back its agents first.'}
          </p>
          <div className="list">
            {failed.length ? (
              <div className="list-row">
                <Icon name="triangle-alert" size={14} />
                <div className="min-w-0 flex-1">
                  <div className="title">{`Couldn't load the deleted ${failed.map((f) => `${KIND_NAME[f.kind]}s`).join(' and ')}`}</div>
                  <div className="hint">{failed.map((f) => f.error).join('; ')}</div>
                </div>
                <Button variant="ghost" size="small" onClick={() => void load()}>
                  <Icon name="rotate-cw" size={13} />
                  Retry
                </Button>
              </div>
            ) : null}
            {items.length ? (
              items.map((it) => (
                <div key={`${it.kind}:${it.id}`} className="list-row">
                  {it.kind === 'skill' ? (
                    <SkillMark slug={it.id} />
                  ) : (
                    <div className="skill-ico">
                      <Icon name={it.kind === 'team' ? 'users' : 'bot'} size={16} />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="title">{it.name}</div>
                    <div className="hint">{`${KIND_NAME[it.kind]} · deleted ${ago(it.at)} by ${byName(it.by)}`}</div>
                  </div>
                  <Button
                    variant="ghost"
                    size="small"
                    onClick={() => openHistory(it.kind, it.id, { onRestored: () => (void load(), onRestored?.()) })}
                  >
                    <Icon name="history" size={13} />
                    History
                  </Button>
                  <Button size="small" disabled={busy === it.id} onClick={() => void bringBack(it)}>
                    <Icon name="archive-restore" size={13} />
                    Bring back
                  </Button>
                </div>
              ))
            ) : failed.length ? null : (
              <p className="empty">Nothing deleted.</p>
            )}
          </div>
        </div>
      </div>
      <div className="modal-foot">
        <Button onClick={close}>Done</Button>
      </div>
    </>
  );
}

/** Deleted skills, agents or teams that can come back. */
export async function openDeleted(
  kinds: VersionKind[],
  { onRestored }: { onRestored?: () => void } = {},
): Promise<void> {
  const initial = await loadDeleted(kinds);
  openModal('Recently deleted', (close) => (
    <DeletedDialog kinds={kinds} initial={initial} onRestored={onRestored} close={close} />
  ));
}

export function deletedButton(kinds: VersionKind[], onRestored?: () => void): HTMLButtonElement {
  // (the size the toolbar's other buttons use: this sits in the same row on the Agents and Skills pages)
  return domButton(
    { variant: 'ghost', type: 'button', onclick: () => openDeleted(kinds, { onRestored }) },
    icon('archive-restore', 14),
    'Recently deleted',
  );
}
