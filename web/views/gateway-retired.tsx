import { useCallback, useEffect, useRef, useState } from 'react';
import { confirmBox } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { Button } from '../ui/button.tsx';
import { Pill } from '../ui/marks.tsx';
import { FieldRow, PanelNote, Row, RowActions, Section } from '../ui/controls.tsx';
import { useServerEvents } from '../ui/react.tsx';
import type { GatewayInboxEvent, GatewayReplyPart, GatewayRetiredInstance } from '../../shared/types.ts';
import { GatewayRetiredFinishView } from './gateway-retired-finish.tsx';

const platforms = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord', whatsapp: 'WhatsApp' };
const status = {
  pending: 'Waiting when saved',
  sending: 'Saved in-flight receipt',
  sent: 'Confirmed',
  uncertain: 'Delivery uncertain',
  failed: 'Failed',
  skipped: 'Skipped',
};
const workStatus = {
  queued: 'Waiting to start',
  'waiting-files': 'Waiting for files',
  running: 'Native work was active',
  done: 'Completed work',
  'needs-review': 'Needs review',
};
const incomingStatus = {
  pending: 'Waiting when saved',
  transferring: 'Downloading when saved',
  saved: 'Saved',
  failed: 'Failed',
};
const attempts = (count: number) => `${count} attempt${count === 1 ? '' : 's'}`;
const failureMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Saved history could not load. Reload before continuing.';
const textClass =
  'm-0 max-h-48 overflow-auto whitespace-pre-wrap [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-accent';

// Operate extension: keep Settings' rows and light/dark tokens. Read identity, then saved evidence.
// The first view lists blocked instances; history disclosures keep long receipts out of the way.
// Removal retry and receipt-local finish have separate confirmations; neither reconnects or sends.
export function GatewayRetiredView({
  id,
  select,
  close,
  changed,
}: {
  id: string;
  select: (id: string) => void;
  close: () => void;
  changed: () => Promise<void>;
}) {
  const [records, setRecords] = useState<GatewayRetiredInstance[] | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(25);
  const mounted = useRef(false);
  const request = useRef(0);
  const load = useCallback(async () => {
    const version = ++request.current;
    try {
      const value = await rpc.gateways.retired.list();
      if (mounted.current && request.current === version) {
        setRecords(value.instances);
        setError('');
      }
    } catch (failure) {
      if (mounted.current && request.current === version) {
        setRecords(null);
        setError(failureMessage(failure));
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, [load]);
  useServerEvents((event) => {
    if (event.type === 'gateways') void load();
  });
  const selected = records?.find((record) => record.id === id);
  const term = query.trim().toLocaleLowerCase();
  const shown = (records || []).filter((record) =>
    [record.name, record.id, record.accountId, record.platform, record.projectId].some((value) =>
      value.toLocaleLowerCase().includes(term),
    ),
  );
  return (
    <Section
      title="Removed instances"
      description="Connections stay blocked. Read saved history, finish local receipts or complete an interrupted removal."
      action={
        <Button size="small" variant="ghost" onClick={close}>
          Close removed instances
        </Button>
      }
    >
      <Row
        title={id ? 'Saved instance history' : 'Saved removal records'}
        description="Opening history only reads local receipts. It never starts work, sends a message or reconnects an account."
      >
        {id && (
          <Button size="small" variant="ghost" onClick={() => select('')}>
            Back to removed instances
          </Button>
        )}
        <Button size="small" variant="ghost" onClick={() => void load()}>
          Reload removed instances
        </Button>
      </Row>
      {error && (
        <div role="alert" className="px-5 py-4 text-red [overflow-wrap:anywhere]">
          {error}
        </div>
      )}
      {!records && !error && <Row title={<span role="status">Loading removed instances…</span>} />}
      {records && id && !selected && (
        <Row
          title="This removed instance could not be found"
          description="Check its saved instance ID or return to the removed-instance list. Older deleted folders without a removal record need separate recovery."
        />
      )}
      {selected && (
        <RetiredHistory
          key={selected.id}
          record={selected}
          changed={async () => {
            await load();
            if (mounted.current) await changed();
          }}
        />
      )}
      {records && !id && (
        <>
          <FieldRow label="Find a removed instance" hint="Search by name, platform, account, project or instance ID.">
            <input
              aria-label="Find a removed instance"
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setLimit(25);
              }}
            />
          </FieldRow>
          {!shown.length && (
            <Row
              title={!records.length ? 'No removed instances' : 'No matching removed instances'}
              description={
                !records.length
                  ? 'Future removals keep their identity and saved receipts here.'
                  : 'Try another name or ID, or clear the search.'
              }
            />
          )}
          {shown.slice(0, limit).map((record) => (
            <Row
              key={record.id}
              title={
                <span className="flex flex-wrap items-center gap-2 [overflow-wrap:anywhere]">
                  {record.name}
                  <Pill tone={record.completedAt === undefined ? 'warn' : 'dim'}>
                    {record.completedAt === undefined ? 'Removal unfinished' : 'Removed'}
                  </Pill>
                </span>
              }
              description={
                <span className="[overflow-wrap:anywhere]">
                  {platforms[record.platform]} · Account <code>{record.accountId}</code>
                  <span className="mt-1 block">Removal started {new Date(record.startedAt).toLocaleString()}.</span>
                </span>
              }
            >
              <Button
                size="small"
                variant="ghost"
                aria-label={`View saved history for ${record.name}`}
                onClick={() => select(record.id)}
              >
                View saved history
              </Button>
            </Row>
          ))}
          {shown.length > limit && (
            <RowActions>
              <Button size="small" variant="ghost" onClick={() => setLimit((before) => before + 25)}>
                Show 25 more instances
              </Button>
            </RowActions>
          )}
        </>
      )}
      <PanelNote>
        Saved history stays separate from newly added instances. Native work may still be running; manage it through
        Athena's usual controls. Saved files remain on this computer.
      </PanelNote>
    </Section>
  );
}

function RetiredHistory({ record, changed }: { record: GatewayRetiredInstance; changed: () => Promise<void> }) {
  const [events, setEvents] = useState<GatewayInboxEvent[] | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [limit, setLimit] = useState(25);
  const [finishId, setFinishId] = useState('');
  const mounted = useRef(false);
  const request = useRef(0);
  const active = useRef(false);
  const load = useCallback(async () => {
    const version = ++request.current;
    try {
      const value = await rpc.gateways.retired.inbox({ id: record.id });
      if (mounted.current && request.current === version) {
        setEvents(value.events);
        setError('');
      }
    } catch (failure) {
      if (mounted.current && request.current === version) {
        setEvents(null);
        setError(failureMessage(failure));
      }
    }
  }, [record.id]);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      request.current++;
    };
  }, [load]);
  useServerEvents((event) => {
    if (event.type === 'gateway-inbox' && event.instanceId === record.id) void load();
  });
  const remove = async () => {
    if (active.current || !mounted.current || record.completedAt !== undefined) return;
    active.current = true;
    setBusy(true);
    setNotice('');
    try {
      if (
        !(await confirmBox(
          `Finish removing ${record.name}, ${platforms[record.platform]} account ${record.accountId}? Athena will drain its worker and clear only its local credentials and pairing under exclusive ownership. Saved receipts and native work stay. The connection remains blocked.`,
          { ok: 'Retry removal', danger: true },
        )) ||
        !mounted.current
      )
        return;
      await rpc.gateways.remove({ id: record.id });
      if (mounted.current) {
        setNotice('Removal finished. The connection stays blocked and saved receipts are kept.');
        setError('');
        await changed();
      }
    } catch (failure) {
      if (mounted.current) setError(failureMessage(failure));
    } finally {
      active.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const ordered = [...(events || [])].sort((a, b) => b.sequence - a.sequence);
  return (
    <>
      <Row
        title={<span className="[overflow-wrap:anywhere]">{record.name}</span>}
        description={
          record.completedAt === undefined
            ? 'Removal is unfinished. New gateway work stays blocked until local cleanup can finish.'
            : `Removed ${new Date(record.completedAt).toLocaleString()}. Local credentials and pairing were cleared.`
        }
        stack
      >
        <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
          <dt className="text-dim">Instance</dt>
          <dd className="m-0 [overflow-wrap:anywhere]">
            <code>{record.id}</code>
          </dd>
          <dt className="text-dim">Account</dt>
          <dd className="m-0 [overflow-wrap:anywhere]">
            {platforms[record.platform]} · <code>{record.accountId}</code>
          </dd>
          <dt className="text-dim">Saved project</dt>
          <dd className="m-0 [overflow-wrap:anywhere]">
            <code>{record.projectId}</code>
          </dd>
          <dt className="text-dim">Destination</dt>
          <dd className="m-0 [overflow-wrap:anywhere]">
            {record.target.kind === 'brain' ? (
              'The Brain'
            ) : (
              <>
                {record.target.kind === 'team' ? 'Team' : 'Agent'} · <code>{record.target.id}</code>
              </>
            )}
          </dd>
        </dl>
      </Row>
      {notice && (
        <div role="status" className="px-5 py-4 text-dim">
          {notice}
        </div>
      )}
      {error && (
        <div role="alert" className="px-5 py-4 text-red [overflow-wrap:anywhere]">
          {error}
        </div>
      )}
      {record.completedAt === undefined && (
        <Row
          title="Finish local removal"
          description="Check storage and any other Athena process using this account. Retrying removal preserves saved history and makes no messaging-service or relay-administration request."
        >
          <Button size="small" variant="danger" disabled={busy} onClick={() => void remove()}>
            Retry removal
          </Button>
        </Row>
      )}
      {finishId ? (
        <GatewayRetiredFinishView
          key={finishId}
          instanceId={record.id}
          eventId={finishId}
          close={() => setFinishId('')}
          changed={load}
        />
      ) : (
        <>
          <Row
            title="Saved inbox receipts"
            description="These are historical gateway records. In-flight statuses are preserved as saved; opening history does not classify them or check the messaging app."
          >
            <Button size="small" variant="ghost" disabled={busy} onClick={() => void load()}>
              Reload saved history
            </Button>
          </Row>
          {!events && !error && <Row title={<span role="status">Loading saved messages…</span>} />}
          {events && !events.length && (
            <Row
              title="No saved inbox messages"
              description="This instance has no remaining inbox receipts. Native chats and approved Outbox receipts are kept separately."
            />
          )}
          {ordered.slice(0, limit).map((event) => (
            <SavedReceipt key={event.id} event={event} reviewFinish={setFinishId} />
          ))}
          {ordered.length > limit && (
            <RowActions>
              <Button size="small" variant="ghost" onClick={() => setLimit((before) => before + 25)}>
                Show 25 more messages
              </Button>
            </RowActions>
          )}
        </>
      )}
    </>
  );
}

function SavedReceipt({ event, reviewFinish }: { event: GatewayInboxEvent; reviewFinish: (id: string) => void }) {
  const native = event.dispatch?.conversation;
  return (
    <details className="px-5 py-4">
      <summary className="cursor-pointer rounded-ctl text-[14px] [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-accent">
        <span className="font-medium">{event.input.actor.label}</span> · Message{' '}
        <code>{event.input.sourceMessageId}</code>
        <span className="mt-1 block text-[13px] text-dim">
          {event.input.text ? event.input.text.slice(0, 160) : `${event.input.media.length} saved attachments`} ·{' '}
          {new Date(event.receivedAt).toLocaleString()}
        </span>
      </summary>
      <div className="mt-4 flex min-w-0 flex-col gap-4 text-[13px] [overflow-wrap:anywhere]">
        <p className="m-0 text-dim">
          Saved state:{' '}
          {event.workKept
            ? 'Kept in Athena'
            : event.dismissed
              ? 'Dismissed'
              : event.deliveryFinished
                ? 'Finished locally'
                : workStatus[event.status]}
          . Connection blocked.
        </p>
        <p className="m-0 text-dim">
          Sender <code>{event.input.actor.id}</code> · Chat <code>{event.input.conversationId}</code>
          {event.input.threadId && (
            <>
              {' '}
              · Thread <code>{event.input.threadId}</code>
            </>
          )}
          . Saved project <code>{event.route.projectId}</code> ·{' '}
          {event.route.target.kind === 'brain' ? (
            'The Brain'
          ) : (
            <>
              {event.route.target.kind} <code>{event.route.target.id}</code>
            </>
          )}
          .
        </p>
        {event.input.text && (
          <p tabIndex={0} aria-label="Saved original message" className={textClass}>
            {event.input.text}
          </p>
        )}
        {event.reason && <p className="m-0 text-dim">{event.reason}</p>}
        {event.operationId &&
          event.input.kind === 'message' &&
          (!event.input.mediaGroupId || event.album?.leaderId === event.id) &&
          ['running', 'needs-review', 'done'].includes(event.status) && (
            <div>
              <Button size="small" variant="ghost" onClick={() => reviewFinish(event.id)}>
                Review local finish
              </Button>
            </div>
          )}
        {event.operationId && (
          <div className="text-dim">
            Operation <code>{event.operationId}</code>
            {event.dispatch?.runId && (
              <div>
                Run <code>{event.dispatch.runId}</code>
              </div>
            )}
            {event.dispatch?.messageId && (
              <div>
                Native message <code>{event.dispatch.messageId}</code>
              </div>
            )}
            {native && (
              <div>
                Private conversation <code>{native.conversationId}</code>
                {native.kind === 'agent' && (
                  <>
                    {' '}
                    · Agent <code>{native.agentId}</code> · Chat <code>{native.chatId}</code>
                  </>
                )}
                {native.kind === 'team' && (
                  <>
                    {' '}
                    · Team <code>{native.teamId}</code>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        {event.album && (
          <p className="m-0 text-dim">
            Saved album {event.album.leaderId === event.id ? 'leader' : 'member'} · Receipt{' '}
            <code>{event.album.leaderId}</code>
            {event.album.memberIds && <> · {event.album.memberIds.length} messages</>}.
          </p>
        )}
        {event.files?.length ? (
          <div>
            <h3 className="m-0 mb-2 text-[13px] font-medium">Incoming files</h3>
            {event.files.map((file) => (
              <p key={file.index} className="my-2">
                {file.file?.name || event.input.media[file.index]?.name || `Attachment ${file.index + 1}`} ·{' '}
                {incomingStatus[file.status]}
                {file.reason && <span className="block text-dim">{file.reason}</span>}
              </p>
            ))}
          </div>
        ) : null}
        {event.dispatch?.answer && (
          <div>
            <h3 className="m-0 mb-2 text-[13px] font-medium">Saved final answer</h3>
            <p tabIndex={0} className={textClass}>
              {event.dispatch.answer}
            </p>
          </div>
        )}
        {event.reply && (
          <div>
            <h3 className="m-0 mb-2 text-[13px] font-medium">Text delivery receipts</h3>
            {event.reply.parts.map((part, index) => (
              <SavedPart key={index} part={part} label={`Part ${index + 1}`} />
            ))}
          </div>
        )}
        {event.notices && (
          <div>
            <h3 className="m-0 mb-2 text-[13px] font-medium">Notice receipts</h3>
            {Object.entries(event.notices).map(([kind, part]) => (
              <SavedPart key={kind} part={part} label={kind === 'working' ? 'Working notice' : 'Approval notice'} />
            ))}
          </div>
        )}
        {event.outgoing?.length ? (
          <div>
            <h3 className="m-0 mb-2 text-[13px] font-medium">Outgoing file receipts</h3>
            {event.outgoing.map((file, index) => (
              <p key={index} className="my-2">
                {file.name} · {status[file.status]} · {attempts(file.attempts.length)}
                {file.remoteId && (
                  <span className="block">
                    Messaging-app ID <code>{file.remoteId}</code>
                  </span>
                )}
                {file.reason && <span className="block text-dim">{file.reason}</span>}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function SavedPart({ part, label }: { part: GatewayReplyPart; label: string }) {
  return (
    <div className="my-3">
      <p className="m-0">
        {label} · {status[part.status]} · {attempts(part.attempts)}
      </p>
      <p tabIndex={0} className={textClass}>
        {part.text}
      </p>
      {part.remoteId && (
        <p className="mt-1 text-dim">
          Messaging-app ID <code>{part.remoteId}</code>
        </p>
      )}
    </div>
  );
}
