// MEMORY.md on the page: read and edit what an agent (or the Brain) remembers across its chats.
// The same editor sits in the agent editor and opens as a window from chats and the Brain chat.
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { GET, PUT, attempt, ago, onEvent, onState, state, confirmBox } from './core.ts';
import { projectAt } from './client/connection.ts';
import { domButton } from './ui/dom.ts';
import type { ButtonSize, ButtonVariant } from './ui/classes.ts';
import { Button } from './ui/button.tsx';
import { icon } from './icons.ts';
import { historyButton } from './history.tsx';
import { openModal } from './ui/overlays.tsx';
import { Icon } from './ui/react.tsx';
import type { MemoryInfo } from '../shared/types.ts';

// an amber note above the editor (the same as the backup warnings in backup.ts)
const WARN = 'm-0 flex items-start gap-1.5 rounded-[8px] border border-[color-mix(in_srgb,var(--color-amber)_30%,var(--color-line))] bg-amber/10 px-2.5 py-2 text-[13px] text-amber';

/** The Brain's memory goes by this owner (an agent's by its id). */
export const BRAIN = 'brain';

export interface MemoryEditor {
  el: HTMLElement;
  /** there are changes not saved yet */
  dirty: () => boolean;
}

const size = (n: number) => (n < 1000 ? `${n} characters` : `${(n / 1000).toFixed(1)}k characters`);

// everything the editor keeps between renders, in one place so dirty() can read it outside React
interface MemoryState {
  loaded: MemoryInfo | null;
  /** the text as it was loaded: what "Undo changes" goes back to */
  base: string;
  text: string;
  /** it changed elsewhere (the agent wrote to it) while you had changes here */
  changedElsewhere: boolean;
  /** another project was opened: this one isn't the open project's any more */
  gone: boolean;
  error: boolean;
}

interface ViewProps {
  owner: string;
  rows: number;
  brain: boolean;
  project: string | null;
  /** the project, when it isn't the open one (an Overview pane): read and saved there, and opening another
   *  project doesn't make it someone else's */
  foreign?: string;
  host: HTMLElement;
  store: MemoryState;
}

function MemoryEditorView({ owner, rows, brain, project, foreign, host, store }: ViewProps): ReactNode {
  const at = projectAt(foreign);
  const [, force] = useReducer((n: number) => n + 1, 0);
  const area = useRef<HTMLTextAreaElement | null>(null);
  const dirty = () => !!store.loaded && store.text !== store.base;

  const load = async (again = false): Promise<void> => {
    if (dirty() && !again) {
      store.changedElsewhere = true;
      return force();
    }
    const m = await GET<MemoryInfo>(`${at}/memory/${encodeURIComponent(owner)}`).catch(() => null);
    if (!m || typeof m.text !== 'string') {
      store.error = true;
      return force();
    }
    // (typing meanwhile wins: only put the text in when nothing was changed here)
    if (dirty() && !again) {
      store.changedElsewhere = true;
      store.loaded = m;
      return force();
    }
    store.loaded = m;
    store.base = m.text;
    store.text = m.text;
    store.changedElsewhere = false;
    store.error = false;
    if (area.current) area.current.value = m.text;
    force();
  };

  const save = async (): Promise<void> => {
    if (!dirty() || store.gone) return;
    const text = store.text;
    const m = await attempt(() => PUT<MemoryInfo>(`${at}/memory/${encodeURIComponent(owner)}`, { text }), 'Saved MEMORY.md');
    if (!m) return;
    store.loaded = m;
    store.base = m.text;
    // (the server tidies line ends; keep what's typed when it means the same)
    if (store.text === text) {
      store.text = m.text;
      if (area.current) area.current.value = m.text;
    }
    store.changedElsewhere = false;
    force();
  };

  // the History button is plain DOM (history.ts), so it goes into a contents span of its own
  const history = useRef<HTMLButtonElement | null>(null);
  if (!history.current) history.current = historyButton('memory', owner, () => void load(true), 'History', foreign);
  const mountHistory = useCallback((node: HTMLSpanElement | null) => { if (node && history.current) node.replaceChildren(history.current); }, []);

  // typing keeps the store in step; the box is uncontrolled, and input arrives on the element itself
  useEffect(() => {
    const node = area.current;
    if (!node) return;
    const onInput = () => {
      store.text = node.value;
      flushSync(() => force());
    };
    node.addEventListener('input', onInput);
    return () => node.removeEventListener('input', onInput);
  }, []);

  // live: the agent (or the Brain) wrote to it, or another tab did
  useEffect(() => {
    let stop = () => {};
    const offEvent = onEvent((ev) => {
      if (!host.isConnected && store.loaded) return stop();
      if (ev.type === 'memory' && ev.owner === owner && (!ev.project || ev.project === project)) void load();
    });
    const offState = onState((d) => {
      if (!host.isConnected && store.loaded) return stop();
      if (!foreign && !store.gone && project && d.project?.id && d.project.id !== project) {
        store.gone = true;
        force();
      }
    });
    stop = () => { offEvent(); offState(); };
    return () => stop();
  }, []);

  useEffect(() => { void load(); }, []);

  const changed = dirty();
  const len = store.text.length;
  const over = store.loaded ? len > store.loaded.max : false;
  const status = store.loaded
    ? `${len ? size(len) : 'Empty'}${over ? ` · too long (up to ${size(store.loaded.max)})` : ''} · ${store.loaded.updatedAt ? `changed ${ago(store.loaded.updatedAt)}` : 'never written'}${changed ? ' · not saved' : ''}`
    : store.error
      ? 'Couldn’t load MEMORY.md.'
      : 'Loading…';

  return (
    <div className="flex flex-col gap-2.5">
      <p className="hint">
        {brain
          ? 'What the Brain remembers across its conversations in this project: how you like it to work, decisions, lessons. It reads this with every message and adds to it as it learns. Facts every agent needs belong in PROJECT.md.'
          : 'What this agent remembers across all its chats in this project. It reads this with every message and adds to it as it learns. Change or remove anything. (Not the same as a chat’s memory, which Clear memory resets.)'}
      </p>
      <div className="empty:hidden">
        {store.gone ? (
          <p className={WARN}>
            <Icon name="triangle-alert" size={14} className="mt-0.5 flex-none" /> You opened another project. This MEMORY.md belongs to the one before, so it can’t be saved here.
          </p>
        ) : store.changedElsewhere ? (
          <p className={WARN}>
            <Icon name="triangle-alert" size={14} className="mt-0.5 flex-none" />
            {` ${brain ? 'The Brain' : 'The agent'} changed it while you were editing. Save keeps your text; `}
            <Button variant="ghost" size="tiny" type="button" onClick={() => void load(true)}>
              Show its version
            </Button>
            {' drops your changes.'}
          </p>
        ) : null}
      </div>
      <textarea
        ref={area}
        className="code min-h-40 w-full resize-y leading-[1.55]"
        rows={rows}
        spellCheck={false}
        disabled={store.gone}
        placeholder={
          brain
            ? 'Nothing yet. The Brain adds what it learns about how you like to work. You can also write notes here yourself, e.g. "Keep answers short." or "Ask before building a new team."'
            : 'Nothing yet. The agent adds what it learns as it works. You can also write notes here yourself, e.g. "Use British spelling." or "The client is called Northwind."'
        }
        onKeyDown={(e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            void save();
          }
        }}
      />
      <div className="flex flex-wrap items-center justify-between gap-2.5">
        <div className={`hint memory-status [&.warn]:text-amber ${over ? 'warn' : ''}`}>{status}</div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="contents" ref={mountHistory} />
          <Button
            variant="ghost"
            size="small"
            type="button"
            disabled={!changed}
            onClick={() => {
              store.text = store.base;
              if (area.current) area.current.value = store.base;
              // synchronously, like typing: callers read the buttons' state right after the click
              flushSync(() => force());
            }}
          >
            Undo changes
          </Button>
          <Button size="small" type="button" disabled={!changed || store.gone} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The editor for one MEMORY.md. rows: the height of the text box. projectId: its project, when it isn't the open
 *  one (an Overview pane). */
export function memoryEditor(owner: string, { rows = 12, projectId }: { rows?: number; projectId?: string } = {}): MemoryEditor {
  const brain = owner === BRAIN;
  const project = projectId || state.data?.project?.id || null;
  const store: MemoryState = { loaded: null, base: '', text: '', changedElsewhere: false, gone: false, error: false };
  const el = document.createElement('div');
  // (synchronously, so the box is there the moment this returns, as the plain-DOM editor's was)
  flushSync(() => createRoot(el).render(<MemoryEditorView owner={owner} rows={rows} brain={brain} project={project} foreign={projectId} host={el} store={store} />));
  return { el, dirty: () => !!store.loaded && store.text !== store.base };
}

/** A window with the MEMORY.md of an agent (its id) or the Brain (BRAIN). projectId: of a project that isn't open. */
export function openMemory(owner: string, name = owner === BRAIN ? 'The Brain' : 'Agent', { projectId }: { projectId?: string } = {}): void {
  const ed = memoryEditor(owner, { rows: 18, projectId });
  const close = async (shut: () => void) => {
    if (ed.dirty() && !(await confirmBox('Close without saving your changes to MEMORY.md?', { ok: 'Close', danger: true }))) return;
    shut();
  };
  const m = openModal(
    <span className="flex items-center gap-2">
      <Icon name="file-text" size={16} />
      {` ${name} · MEMORY.md`}
    </span>,
    (shut) => (
      <>
        <div className="modal-body" ref={(node) => { if (node) node.replaceChildren(ed.el); }} />
        <div className="modal-foot">
          <Button variant="ghost" onClick={() => void close(shut)}>
            Close
          </Button>
        </div>
      </>
    ),
  );
  m.el.classList.add('[&_.modal]:w-[min(760px,100%)]');
  setTimeout(() => ed.el.querySelector('textarea')?.focus(), 30);
}

/** A button that opens it. */
export function memoryButton(owner: string, name?: string, { variant = 'ghost', size = 'small', class: cls = '', projectId }: { variant?: ButtonVariant; size?: ButtonSize; class?: string; projectId?: string } = {}): HTMLButtonElement {
  return domButton({ variant, size, class: cls, type: 'button', title: 'What it remembers across chats: read and edit', onclick: () => openMemory(owner, name, { projectId }) }, icon('file-text', 13), 'MEMORY.md');
}
