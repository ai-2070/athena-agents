// How a chat message's parts look (Vercel AI SDK UI message parts), in every chat view: text as
// markdown (or a Rich answer as live components), tool calls you can open (input, result, images),
// file previews with Show in Explorer / Finder, and our own rows (COMPACTED marks, errors, notes).
// Sizes: full (the chat page), compact (the floating window), mini (the Station panel, team turns).
import { Suspense, lazy, memo, useEffect, useMemo, useRef } from 'react';
import type { DynamicToolUIPart } from 'ai';
import { md, lightbox } from '../core.ts';
import { compactionMark } from '../compactmark.ts';
import { filePreviews } from '../filepreview.ts';
import { findFileMentions } from '../mentions.ts';
import { readOutput, readUser } from './messages.ts';
import type { ChatMessage, ChatPart } from './messages.ts';
import type { CompactionItem } from '../../shared/types.ts';

const RichAnswer = lazy(() => import('./rich.tsx'));

export type Variant = 'full' | 'compact' | 'mini';

/** A piece of the page built with plain DOM (approval cards, the COMPACTED mark, file previews…). */
export const Dom = memo(
  function Dom({ make, deps, className }: { make: () => Node | null; deps: readonly unknown[]; className?: string }) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
      const node = make();
      ref.current?.replaceChildren(...(node ? [node] : []));
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps);
    return <div ref={ref} className={className} style={className ? undefined : { display: 'contents' }} />;
  },
  (a, b) => a.className === b.className && a.deps.length === b.deps.length && a.deps.every((d, i) => Object.is(d, b.deps[i])),
);

export const Markdown = memo(function Markdown({ text, className }: { text: string; className: string }) {
  // (md() is marked + DOMPurify, as everywhere in the dashboard)
  const html = useMemo(() => md(text).innerHTML, [text]);
  return <div className={className} dangerouslySetInnerHTML={{ __html: html }} />;
});

export function Previews({ paths, small }: { paths: readonly string[]; small?: boolean }) {
  const key = paths.join('\n');
  if (!paths.length) return null;
  return <Dom make={() => filePreviews(paths, { compact: small })} deps={[key, small]} />;
}

/** OpenUI Lang (a Rich answer) rather than markdown: "root = Card(…)" and other statements. */
export const isRichCode = (text: string): boolean => /^\s*root\s*=\s*[A-Z]\w*\(/m.test(text) && !/^\s*```/.test(text);

const brief = (input: unknown): string =>
  input && typeof input === 'object' ? Object.values(input as Record<string, unknown>).filter((v) => typeof v === 'string').join(' · ').slice(0, 140) : typeof input === 'string' ? input.slice(0, 140) : '';

/** A tool call: its name and what it was about, opening to its input and result (and images below). */
export function ToolCard({ part, variant, busy }: { part: DynamicToolUIPart; variant: Variant; busy: boolean }) {
  const done = part.state === 'output-available' || part.state === 'output-error';
  const failed = part.state === 'output-error';
  const out = part.state === 'output-available' ? readOutput(part.output) : null;
  const images = out?.images || [];
  const running = !done && busy;
  const mark = running ? <span className="dot busy" /> : failed ? <span className="red">✕</span> : done ? <span className="accent">✓</span> : <span className="faint">·</span>;
  let input = '';
  try {
    input = typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}, null, 2);
  } catch {
    input = String(part.input);
  }
  const small = variant !== 'full';
  return (
    <div className={`col oc-tool${small ? ' small' : ''}`} style={{ gap: '6px' }}>
      <details className={`tool${failed ? ' error' : ''}${small ? ' small' : ''}`}>
        <summary>
          {mark}
          <span className="tname">{part.toolName}</span>
          <span className="targ">{brief(part.input)}</span>
        </summary>
        <div className="tbody">
          <div className="label">Input</div>
          <pre>{input}</pre>
          {done ? (
            <>
              <div className="label">{failed ? 'Error' : 'Result'}</div>
              <pre>{failed ? part.errorText : out?.text || '(empty)'}</pre>
            </>
          ) : (
            <div className="hint">{running ? 'Running…' : 'Did not finish.'}</div>
          )}
        </div>
      </details>
      {images.length ? (
        <div className={small ? 'st-imgs' : 'tool-images'}>
          {images.slice(0, small ? 6 : 24).map((src) => (
            <img key={src} src={src} onClick={() => lightbox(src)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function TextPart({ text, variant, streaming, dim, onSend }: { text: string; variant: Variant; streaming: boolean; dim: boolean; onSend: (t: string) => void }) {
  const rich = !!text && isRichCode(text);
  const mentions = useMemo(() => (rich ? [] : findFileMentions(text)), [text, rich]);
  const cls = dim ? ' compacted' : '';
  if (!text) return null;
  return (
    <>
      {rich ? (
        <div className={`msg assistant rich${cls}`}>
          <Suspense fallback={<pre className="hint">{text}</pre>}>
            <RichAnswer code={text} streaming={streaming} onSend={onSend} />
          </Suspense>
        </div>
      ) : variant === 'compact' ? (
        <div className={`ac-msg agent${cls}`}>
          <Markdown text={text} className="ac-text" />
        </div>
      ) : variant === 'mini' ? (
        <Markdown text={text.length > 4000 ? `${text.slice(0, 4000)}…` : text} className={`st-msg assistant${cls}`} />
      ) : (
        <Markdown text={text} className={`msg assistant${streaming ? ' cursor' : ''}${cls}`} />
      )}
      {mentions.length ? <Previews paths={mentions} small={variant !== 'full'} /> : null}
    </>
  );
}

export interface MessageViewProps {
  m: ChatMessage;
  variant: Variant;
  /** a run is going in this chat */
  busy: boolean;
  /** this message is the one streaming in */
  streaming: boolean;
  /** shown dimmed (only remembered as the compacted history) */
  dim: boolean;
  /** what a Rich answer's buttons send */
  onSend: (text: string) => void;
  /** for the COMPACTED mark's edit */
  chatPath?: string;
  latestCompaction?: string | null;
  onCompactionSaved?: () => void;
}

export function MessageView({ m, variant, busy, streaming, dim, onSend, chatPath, latestCompaction, onCompactionSaved }: MessageViewProps) {
  if (m.role === 'user') {
    const { text, attachments } = readUser(m);
    const paths = [...attachments, ...findFileMentions(text)];
    const cls = variant === 'compact' ? 'ac-msg user' : variant === 'mini' ? 'st-msg user' : 'msg user';
    return (
      <>
        <div className={`${cls}${dim ? ' compacted' : ''}`}>
          {m.metadata?.from && variant === 'full' ? <div className="from">from {m.metadata.from}</div> : null}
          {text ? variant === 'compact' ? <div className="ac-text">{text}</div> : text : null}
        </div>
        {paths.length ? <Previews paths={paths} small={variant !== 'full'} /> : null}
      </>
    );
  }
  const lastText = m.parts.findLastIndex((p) => p.type === 'text');
  return (
    <>
      {m.parts.map((p: ChatPart, i) => {
        const key = `${m.id}:${i}`;
        if (p.type === 'text') return <TextPart key={key} text={p.text} variant={variant} streaming={streaming && i === lastText && p.state === 'streaming'} dim={dim} onSend={onSend} />;
        if (p.type === 'dynamic-tool') return <ToolCard key={key} part={p} variant={variant} busy={busy} />;
        if (p.type === 'data-compaction') {
          const it = p.data as CompactionItem;
          if (variant === 'mini') return <div key={key} className="st-msg cmp" title="The agent’s memory of the messages above was compacted. Open the full chat to see or edit it.">— COMPACTED —</div>;
          return <Dom key={key} make={() => compactionMark(it, { chatPath, latest: latestCompaction === it.id, busy, compact: variant === 'compact', onSaved: onCompactionSaved })} deps={[it.id, it.text, latestCompaction, busy, chatPath]} />;
        }
        if (p.type === 'data-error') return <div key={key} className={variant === 'full' ? 'msg error' : variant === 'compact' ? 'ac-msg err' : 'st-msg err'}>{(p.data as { text: string }).text}</div>;
        if (p.type === 'data-meta') return variant === 'full' ? <div key={key} className="msg meta">{(p.data as { text: string }).text}</div> : null;
        return null;
      })}
    </>
  );
}
