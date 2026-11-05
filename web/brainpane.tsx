// Another project's Brain as an Overview pane: its conversation (the one its Brain chat shows when that project is
// open) and a box to ask it something, the answer streamed in. Its requests go to that project (/api/p/<project>/brain/…),
// so the dashboard stays on the project that is open. The whole Brain chat (who a message goes to, /goal, /loop,
// /queue) is the open project's (dock.tsx).
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { attempt, md, onEvent, onReconnect, toast } from './core.ts';
import { projectAt } from './client/connection.ts';
import { rpcAt } from './client/rpc.ts';
import { COMPOSER_BTNS, COMPOSER_TEXT, attachTray } from './attach.tsx';
import { StepCard, brainProgress, savedAnswer } from './dock.tsx';
import { BRAIN, memoryButton } from './memory.tsx';
import type { BrainHistoryEntry } from './dock.tsx';
import { DomNode, Icon } from './ui/react.tsx';
import { Button } from './ui/button.tsx';
import { Dot } from './ui/marks.tsx';
import type { BrainAnswer, BrainDelegate, BrainDone, BrainStep } from '../shared/types.ts';

type Said = { id: string; ts: number; role: 'user'; text: string; attachments?: string[] };
type Answer = { id: string; ts: number; role: 'brain'; answer: string; done: BrainDone[]; delegate?: BrainDelegate; steps?: BrainStep[] };
type Item = Said | Answer;
/** A question on its way: what you asked, and the answer as it streams in. */
interface Asking {
  text: string;
  attachments: string[];
  answer: string;
  steps: BrainStep[];
}
// how many of the last messages show (the Brain chat shows a few; a pane has room for more)
const KEEP = 30;

const fromHistory = (m: BrainHistoryEntry): Item =>
  m.role === 'user' ? { id: `${m.ts}u`, ts: m.ts, role: 'user', text: m.text, attachments: m.attachments } : { id: `${m.ts}b`, ts: m.ts, role: 'brain', ...savedAnswer(m) };

/** onOpen: opens an agent's or team's pane (of this project), for work the Brain handed on. */
export function BrainPane({ projectId, projectName, onOpen }: { projectId: string; projectName: string; onOpen?: (kind: 'agent' | 'team', id: string) => void }) {
  const at = projectAt(projectId);
  const [items, setItems] = useState<Item[]>([]);
  // what the Brain said by itself meanwhile (checked on work it handed out, learned a skill): not in its history
  const [notes, setNotes] = useState<Answer[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [asking, setAsking] = useState<Asking | null>(null);
  const askingRef = useRef(asking);
  askingRef.current = asking;
  const [filled, setFilled] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const stopper = useRef<AbortController | null>(null);
  const tray = useMemo(() => attachTray({ project: projectId, onChange: () => refill() }), [projectId]);
  const refill = () => setFilled(!!box.current?.value.trim() || tray.count() > 0);

  const load = useCallback(async () => {
    const msgs = await rpcAt(at).brain.history().catch(() => null);
    if (!msgs || !Array.isArray(msgs)) return;
    setItems(msgs.slice(-KEEP).map(fromHistory));
    setLoaded(true);
  }, [at]);
  useEffect(() => {
    void load();
    const off = onEvent((ev) => {
      if (ev.projectId !== projectId) return;
      // (an answer on its way is saved when it ends: this pane reads the history again then)
      if (ev.type === 'brain-chat' && !ev.conversationId && !askingRef.current) void load();
      if (ev.type === 'brain-note' || ev.type === 'brain-learned') setNotes((n) => [...n, { id: `n${ev.ts}`, ts: ev.ts, role: 'brain', answer: String(ev.answer || ''), done: (ev.done as BrainDone[]) || [] }]);
    });
    const back = onReconnect(() => void load());
    return () => (off(), back());
  }, [load, projectId]);
  useEffect(() => {
    const off = tray.dropZone(root.current!, `Drop files for ${projectName}'s Brain`);
    return () => (off(), tray.discard());
  }, [tray, projectName]);

  // staying at the newest message while you are there
  const near = useRef(true);
  const shown = [...items, ...notes].sort((a, b) => a.ts - b.ts);
  useLayoutEffect(() => {
    const el = list.current;
    if (el && near.current) el.scrollTop = el.scrollHeight;
  }, [shown.length, asking?.answer, asking?.steps.length]);

  const ask = async () => {
    if (askingRef.current) return;
    const attachments = await tray.ready();
    if (!attachments) return;
    const text = box.current?.value.trim() || '';
    if (!text && !attachments.length) return;
    box.current!.value = '';
    const taken = tray.take();
    refill();
    near.current = true;
    const stop = (stopper.current = new AbortController());
    setAsking({ text, attachments, answer: '', steps: [] });
    let failed = '';
    try {
      const [{ readUIMessageStream }, { brainTransport }] = await Promise.all([import('ai'), import('./chat/transport.ts')]);
      const stream = await brainTransport({ text, project: projectId, attachments }, at).sendMessages({ chatId: `brain-${projectId}`, messages: [], trigger: 'submit-message', messageId: undefined, abortSignal: stop.signal });
      let answer: BrainAnswer | null = null;
      const errors: string[] = [];
      for await (const m of readUIMessageStream({ stream, onError: (e) => errors.push(e instanceof Error ? e.message : String(e)) })) {
        const now = brainProgress(m);
        setAsking((a) => (a ? { ...a, ...now } : a));
        const d = m.parts.find((p) => p.type === 'data-answer') as { data?: BrainAnswer } | undefined;
        if (d?.data) answer = d.data;
      }
      if (!answer && !stop.signal.aborted) failed = errors[0] || "The Brain didn't answer.";
    } catch (e) {
      if (!stop.signal.aborted) failed = e instanceof Error ? e.message : String(e);
    } finally {
      stopper.current = null;
      await load();
      setAsking(null);
    }
    if (failed) {
      toast(failed, 'error');
      // (what you wrote goes back in the box, unless you started another)
      if (box.current && !box.current.value) box.current.value = text;
      tray.put(taken);
      refill();
    }
  };
  /** Stops the answer it is writing (it changes nothing; your question stays in its history). */
  const stop = () => {
    stopper.current?.abort();
    void attempt(() => rpcAt(at).brain.steer());
  };

  return (
    <div ref={root} className="brain-pane flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex justify-end pt-1">
        <DomNode as="span" make={() => memoryButton(BRAIN, `${projectName}'s Brain`, { size: 'tiny', projectId })} deps={[projectId, projectName]} />
      </div>
      <div
        ref={list}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pt-2"
        onScroll={(e) => {
          const el = e.currentTarget;
          near.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {loaded && !shown.length && !asking ? <p className="m-auto max-w-72 text-center text-[13px] text-dim">{`Ask ${projectName}'s Brain about that project, or for work done there. The dashboard stays on the project that is open.`}</p> : null}
        {shown.map((it) => (it.role === 'user' ? <Question key={it.id} text={it.text} attachments={it.attachments} /> : <BrainAnswerView key={it.id} it={it} onOpen={onOpen} />))}
        {asking ? (
          <>
            <Question text={asking.text} attachments={asking.attachments} />
            <BrainAnswerView it={{ answer: asking.answer, done: [], steps: asking.steps }} live />
          </>
        ) : null}
      </div>
      <DomNode make={() => tray.el} deps={[tray]} />
      <div className="dock-composer relative">
        <textarea
          ref={box}
          className={`dock-input w-full ${COMPOSER_TEXT}`}
          rows={2}
          aria-label={`Message ${projectName}'s Brain`}
          placeholder={asking ? 'The Brain is answering…' : `Ask ${projectName}'s Brain…  (Enter to send)`}
          onInput={refill}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void ask();
            }
          }}
        />
        <div className={`${COMPOSER_BTNS} items-center px-2 pt-1 pb-2`} style={{ flexDirection: 'row', justifyContent: 'flex-end' }}>
          <DomNode as="span" make={() => tray.picker} deps={[tray]} />
          {asking ? (
            <Button key="stop" variant="danger" className="rounded-full" onClick={stop} title="Stop the Brain's answer" aria-label="Stop">
              <Icon name="square" size={14} />
            </Button>
          ) : (
            <Button key="send" className="rounded-full" onClick={() => void ask()} disabled={!filled} title="Send (Enter)" aria-label="Send">
              <Icon name="arrow-up" size={16} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function Question({ text, attachments }: { text: string; attachments?: string[] }) {
  const files = (attachments || []).map((p) => p.split(/[\\/]/).pop() || p);
  return (
    <div className="user font-chat max-w-[85%] self-end whitespace-pre-wrap rounded-[12px] border border-line bg-panel-2 px-3.5 py-2.5 text-[13.5px] leading-[1.6] wrap-anywhere">
      {text}
      {files.length ? <div className="mt-1 text-[12px] text-faint">{files.join(', ')}</div> : null}
    </div>
  );
}

const DONE_ICONS: Record<string, string> = { team: 'users', hired: 'user-plus', file: 'file-text', routine: 'repeat', skill: 'puzzle', model: 'cpu', mcp: 'plug', stop: 'square', memory: 'file-text', error: 'triangle-alert', note: 'check' };
const ACT = 'flex items-center gap-2.5 rounded-ctl border px-3 py-1.5 text-[13px]';

/** A Brain answer: the tools it used, its words, what it did, and the work it handed on. */
function BrainAnswerView({ it, live = false, onOpen }: { it: Pick<Answer, 'answer' | 'done' | 'delegate' | 'steps'>; live?: boolean; onOpen?: (kind: 'agent' | 'team', id: string) => void }) {
  const to = it.delegate;
  return (
    <div className="brain text-[13.5px] leading-[1.6] wrap-anywhere">
      <div className="mb-2 flex items-center gap-2.5 text-[13px]">
        <div className="avatar size-6 bg-accent/10 text-accent">
          <Icon name="brain" size={13} />
        </div>
        <b>Brain</b>
      </div>
      {it.steps?.length ? (
        <div className="my-2 flex flex-col gap-1.5 font-mono text-[12.5px] leading-[normal] text-dim">
          {it.steps.map((st) => (
            <StepCard key={st.id} st={st} />
          ))}
        </div>
      ) : null}
      {live && !it.answer ? (
        <div className="flex items-center gap-2.5 text-[13px] text-dim">
          <Dot tone="busy" />
          The Brain is looking at the project…
        </div>
      ) : it.answer || !it.done.length ? (
        <DomNode
          className="dom-contents"
          make={() => {
            const el = md(it.answer || '(no answer)');
            el.classList.add('font-chat', '[&_p]:mx-0', '[&_p]:mt-0', '[&_p]:mb-2.5', '[&_pre]:max-h-[220px]');
            if (live) el.classList.add('cursor');
            return el;
          }}
          deps={[it.answer, live]}
        />
      ) : null}
      {it.done.length ? (
        <div className="mt-3 flex flex-col gap-2">
          {it.done.map((d, i) => (
            <div key={i} className={`${ACT} ${d.kind === 'error' ? 'border-[color-mix(in_srgb,var(--color-amber)_35%,var(--color-line))] bg-amber/8' : 'border-line bg-panel'}`}>
              <Icon name={DONE_ICONS[d.kind] || 'check'} size={13} />
              <span className="flex-1">{d.text}</span>
            </div>
          ))}
        </div>
      ) : null}
      {to ? (
        <div className={`${ACT} mt-2 border-line bg-panel`}>
          <Icon name="send" size={13} />
          <span className="flex-1">
            Handed to <b>{to.name}</b>
          </span>
          {onOpen && to.id ? (
            <Button size="tiny" variant="ghost" onClick={() => onOpen(to.kind === 'agent' ? 'agent' : 'team', to.id)}>
              Open
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
