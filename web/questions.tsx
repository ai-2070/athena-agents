// Questions agents asked you (ask_user): the card with the choices as buttons and a box for an answer in
// your own words. Shown in the Outbox, and in the chat while the agent waits there.
import { useState } from 'react';
import { POST, DEL, attempt, ago, md } from './core.ts';
import { DomNode } from './ui/react.tsx';
import type { AgentQuestion } from '../shared/types.ts';

const STATUS: Record<AgentQuestion['status'], [string, string]> = {
  waiting: ['warn', 'asks you'],
  answered: ['ok', 'answered'],
  dismissed: ['', 'dismissed'],
  closed: ['', 'closed'],
};

/** Where your answer went, in plain words. */
export function deliveredText(q: AgentQuestion): string {
  const who = q.agentName || 'the agent';
  if (q.delivered === 'live') return `${who} got it right away.`;
  if (q.delivered === 'chat') return `Sent to ${who}'s chat as a new message.`;
  if (q.delivered === 'team') return `Sent to ${who} in the ${q.teamName || 'team'} chat.`;
  return q.note || '';
}

/** The waiting question in the list that a chat's ask_user call made (matched by its text, newest first). */
export function questionFor(list: readonly AgentQuestion[] | undefined, input: unknown): AgentQuestion | null {
  const asked = input && typeof input === 'object' ? String((input as { question?: unknown }).question ?? '').trim().slice(0, 2000) : '';
  if (!asked) return null;
  return [...(list || [])].reverse().find((q) => q.status === 'waiting' && q.question === asked) || null;
}

/** One question: click a choice, or write an answer (or both: what you wrote goes along with the choice). */
export function QuestionCard({ q, inChat = false, changed }: { q: AgentQuestion; inChat?: boolean; changed?: () => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const waiting = q.status === 'waiting';
  const who = q.agentName || 'the agent';
  const answer = async (choice?: string) => {
    setBusy(true);
    const r = await attempt(() => POST<AgentQuestion>(`/questions/${q.id}/answer`, { choice: choice || '', text }), `Sent to ${who}`);
    setBusy(false);
    if (r) {
      setText('');
      changed?.();
    }
  };
  const dismiss = async () => {
    if (await attempt(() => POST(`/questions/${q.id}/dismiss`, {}))) changed?.();
  };
  const remove = async () => {
    if (await attempt(() => DEL(`/questions/${q.id}`))) changed?.();
  };
  const [tone, label] = STATUS[q.status] || ['', q.status];
  const after = q.status === 'answered' ? deliveredText(q) : q.note || '';
  return (
    <div className={`${inChat ? 'question in-chat' : 'panel question'}${waiting ? ' waiting' : ''}`} role="group" aria-label={`Question from ${who}`}>
      <div className="row">
        <span className={`pill${tone ? ` ${tone}` : ''}`}>{label}</span>
        {inChat ? <span className="hint">Also in your Outbox</span> : <b>{q.agentName || 'An agent'}</b>}
        {inChat ? null : <span className="hint">{`${q.teamName ? `team ${q.teamName} · ` : ''}${ago(q.createdAt)}`}</span>}
      </div>
      <p className="question-text">{q.question}</p>
      {q.detail ? <DomNode className="question-detail hint" make={() => md(q.detail)} deps={[q.detail]} /> : null}
      {waiting ? (
        <>
          {q.choices.length ? (
            <div className="row question-choices">
              {q.choices.map((c) => (
                <button key={c} className="btn small" disabled={busy} title={text.trim() ? 'Send this choice, with what you wrote' : 'Send this answer'} onClick={() => void answer(c)}>
                  {c}
                </button>
              ))}
            </div>
          ) : null}
          <textarea
            rows={2}
            aria-label={`Answer ${who}`}
            placeholder={q.choices.length ? 'Or answer in your own words… (goes along with a choice you click)' : `Answer ${who} in your own words…`}
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && text.trim() && void answer()}
          />
          <div className="row">
            <button className="btn ghost small" disabled={busy || !text.trim()} title="Send what you wrote (Ctrl+Enter)" onClick={() => void answer()}>Send answer</button>
            <span className="grow" />
            <button className="btn ghost tiny" disabled={busy} title={`Close it without answering: ${who} hears you passed`} onClick={() => void dismiss()}>Dismiss</button>
          </div>
        </>
      ) : (
        <>
          {q.status === 'answered' ? (
            <p className="mt">
              <span className="hint">You answered: </span>
              {[q.choice, q.reply].filter(Boolean).join(' · ')}
            </p>
          ) : null}
          {after ? <p className="hint">{after}</p> : null}
          {inChat ? null : (
            <div className="row">
              <button className="btn tiny ghost" onClick={() => void remove()}>Remove</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
