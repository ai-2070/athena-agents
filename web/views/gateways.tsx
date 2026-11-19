// Settings › Gateways: Telegram, Slack and Discord bots that bring messages to the Brain, a team or an agent of a
// project, and answer in the same chat. A list of them, a form to add or change one (tokens go in, never come back),
// and each one's messages, with Retry for one that failed.
// Links: #/settings?tab=gateways&instance=<id> opens its form, &messages=<id> its messages.
import { useCallback, useEffect, useState } from 'react';
import { ago, attempt, confirmBox } from '../core.ts';
import { rpc } from '../client/rpc.ts';
import { Button } from '../ui/button.tsx';
import { Dot, Pill } from '../ui/marks.tsx';
import type { PillTone } from '../ui/marks.tsx';
import { FieldRow, PanelNote, Row, RowActions, Section, Sections, Switch } from '../ui/controls.tsx';
import { SelectControl } from '../ui/select.tsx';
import { Icon, useAppState, useServerEvents } from '../ui/react.tsx';
import type { DotTone } from '../ui/classes.ts';
import type {
  GatewayListing,
  GatewayMessage,
  GatewayPlatform,
  GatewayTarget,
  ServerEvent,
} from '../../shared/types.ts';

export const PLATFORM: Record<GatewayPlatform, string> = { telegram: 'Telegram', slack: 'Slack', discord: 'Discord' };

const query = () => new URLSearchParams(location.hash.split('?')[1] || '');
const ids = (text: string) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];
const GATEWAY_EVENTS = new Set(['chat-gateways', 'gateways', 'gateway-health', 'gateway-messages', 'projects']);

/** How an instance is doing, as a dot and a few words. */
export function gatewayState(g: { enabled: boolean; health: GatewayListing['health'] }): [DotTone, string] {
  if (!g.enabled) return ['off', 'Off'];
  const h = g.health;
  if (h.status === 'connected') return ['on', h.bot ? `Connected as ${h.bot}` : 'Connected'];
  if (h.status === 'error') return ['warn', h.error || 'Not connected'];
  return ['busy', 'Connecting…'];
}

type View = { kind: 'edit'; id: string | null; platform: GatewayPlatform } | { kind: 'messages'; id: string } | null;

export function GatewaysTab() {
  const [list, setList] = useState<GatewayListing[] | null>(null);
  const [view, setView] = useState<View>(null);
  const load = useCallback(async () => {
    const next = await rpc.gateways.list();
    setList(next);
    return next;
  }, []);
  useEffect(() => {
    void load()
      .then((next) => {
        const q = query();
        const edit = next.find((g) => g.id === q.get('instance'));
        const messages = next.find((g) => g.id === q.get('messages'));
        if (edit) setView({ kind: 'edit', id: edit.id, platform: edit.platform });
        else if (messages) setView({ kind: 'messages', id: messages.id });
      })
      .catch(() => setList([]));
  }, [load]);
  useServerEvents((ev: ServerEvent) => {
    if (GATEWAY_EVENTS.has(ev.type)) void load().catch(() => {});
  });
  if (!list) return null;
  const open = view && view.kind !== 'edit' ? list.find((g) => g.id === view.id) : null;
  // (undefined: a new one; null: the one being edited is gone)
  const editing = view?.kind === 'edit' && view.id ? (list.find((g) => g.id === view.id) ?? null) : undefined;
  return (
    <Sections>
      <Section
        title="Chat gateways"
        description="Talk to the Brain, a team or an agent from Telegram, Slack or Discord. Each bot answers in one project, in a conversation of its own per chat. Nothing on this computer is opened to the internet."
        action={(['telegram', 'slack', 'discord'] as const).map((platform) => (
          <Button
            key={platform}
            variant="ghost"
            size="small"
            onClick={() => setView({ kind: 'edit', id: null, platform })}
          >
            <Icon name="plus" size={13} />
            {PLATFORM[platform]}
          </Button>
        ))}
      >
        {list.length ? (
          list.map((g) => <GatewayRow key={g.id} g={g} open={setView} />)
        ) : (
          <PanelNote>
            No gateways yet. Add a Telegram, Slack or Discord bot to talk to your agents from there.
          </PanelNote>
        )}
      </Section>
      {view?.kind === 'edit' && editing !== null ? (
        <GatewayForm
          key={view.id || `new-${view.platform}`}
          platform={view.platform}
          g={editing}
          done={(id) => {
            void load();
            setView(id ? { kind: 'messages', id } : null);
          }}
          close={() => setView(null)}
        />
      ) : null}
      {view?.kind === 'messages' && open ? (
        <GatewayMessages key={open.id} g={open} close={() => setView(null)} />
      ) : null}
    </Sections>
  );
}

function GatewayRow({ g, open }: { g: GatewayListing; open: (v: View) => void }) {
  const [tone, state] = gatewayState(g);
  const toggle = (on: boolean) =>
    void attempt(() => rpc.gateways.enable({ id: g.id, enabled: on }), on ? `${g.name} is on` : `${g.name} is off`);
  const remove = async () => {
    if (
      !(await confirmBox(`Remove ${g.name}? Its messages go too; files it saved stay in the project.`, {
        danger: true,
        ok: 'Remove',
      }))
    )
      return;
    await attempt(() => rpc.gateways.remove({ id: g.id }), 'Removed');
  };
  return (
    <div className="set-row gateway-row px-5 py-4" data-gateway={g.id}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[14px] leading-snug font-medium text-ink">
            <Dot tone={tone} />
            <span className="truncate">{g.name}</span>
          </div>
          <div className="mt-1 text-[13px] text-dim">
            {`${PLATFORM[g.platform]} · ${g.projectName} · answered by ${g.targetName}`}
          </div>
          <div className={`mt-1 text-[13px] ${tone === 'warn' ? 'text-amber' : 'text-dim'}`}>{state}</div>
        </div>
        <div className="flex flex-none flex-wrap items-center gap-2">
          <Switch checked={g.enabled} onChange={toggle}>
            <span className="sr-only">{`${g.name} on`}</span>
          </Switch>
          {g.enabled && g.health.status === 'error' ? (
            <Button
              variant="ghost"
              size="small"
              onClick={() => void attempt(() => rpc.gateways.reconnect({ id: g.id }))}
            >
              <Icon name="refresh-cw" size={13} />
              Reconnect
            </Button>
          ) : null}
          <Button variant="ghost" size="small" onClick={() => open({ kind: 'messages', id: g.id })}>
            <Icon name="message-circle" size={13} />
            Messages
          </Button>
          <Button variant="ghost" size="small" onClick={() => open({ kind: 'edit', id: g.id, platform: g.platform })}>
            <Icon name="pencil" size={13} />
            Edit
          </Button>
          <Button variant="ghost" size="small" aria-label={`Remove ${g.name}`} onClick={() => void remove()}>
            <Icon name="trash-2" size={13} />
          </Button>
        </div>
      </div>
      {g.refused.length ? (
        <div className="mt-3 flex flex-col gap-1.5 text-[13px] text-dim">
          {g.refused.slice(0, 3).map((r) => (
            <div key={`${r.kind}-${r.id}`} className="flex flex-wrap items-center gap-2">
              <span>
                {r.kind === 'user'
                  ? `Ignored ${r.name} (user ${r.id}), ${ago(r.at)}.`
                  : `Ignored a mention in ${r.name} (channel ${r.id}), ${ago(r.at)}.`}
              </span>
              <Button
                variant="ghost"
                size="tiny"
                onClick={() =>
                  void attempt(
                    () => rpc.gateways.allow({ id: g.id, kind: r.kind, value: r.id }),
                    r.kind === 'user' ? `${r.name} can talk to ${g.name} now` : 'The channel is on the list now',
                  )
                }
              >
                {r.kind === 'user' ? 'Let them in' : 'Add the channel'}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ---------- the form ----------
const STEPS: Record<GatewayPlatform, string[]> = {
  telegram: [
    'In Telegram, talk to @BotFather: send /newbot and follow along. Paste the token it gives you here.',
    'Then write to your bot. It ignores people not on its list, and shows them here with a button to let them in.',
    'In a group, it answers when someone mentions it or replies to it.',
  ],
  slack: [
    'Make an app at api.slack.com/apps. Turn on Socket Mode and make an app-level token with connections:write (xapp-…).',
    'Bot token scopes: chat:write, app_mentions:read, im:history, files:read, files:write (and users:read, channels:read for names). Subscribe to the bot events app_mention and message.im, and allow messages in the App Home.',
    'Install it to your workspace and paste the Bot User OAuth Token (xoxb-…).',
  ],
  discord: [
    'Make an application at discord.com/developers, add a bot, and turn on Message Content Intent. Paste its token here.',
    'Invite it to your server (OAuth2 › URL Generator: scope bot; Send Messages, Read Message History, Attach Files).',
    'Write to it or mention it in a channel: who it ignored shows here, to let them in. (Or copy IDs with Developer Mode on.)',
  ],
};

function GatewayForm({
  platform,
  g,
  done,
  close,
}: {
  platform: GatewayPlatform;
  g: GatewayListing | undefined;
  done: (id: string | null) => void;
  close: () => void;
}) {
  const app = useAppState();
  const projects = app?.projects || [];
  const [name, setName] = useState(g?.name ?? `${PLATFORM[platform]} bot`);
  const [projectId, setProjectId] = useState(g?.projectId ?? app?.project.id ?? '');
  const [target, setTarget] = useState(targetValue(g?.target ?? { kind: 'brain' }));
  const [users, setUsers] = useState((g?.users ?? []).join(', '));
  const [channels, setChannels] = useState((g?.channels ?? []).join(', '));
  const [botToken, setBotToken] = useState('');
  const [appToken, setAppToken] = useState('');
  const [busy, setBusy] = useState(false);
  // (set once saved: saving again changes the same gateway, also when its token or turning it on failed)
  const [id, setId] = useState(g?.id);
  const [choices, setChoices] = useState<{ value: string; label: string }[]>([{ value: 'brain', label: 'The Brain' }]);
  useEffect(() => {
    if (!projectId) return;
    let live = true;
    void rpc.gateways
      .targets({ projectId })
      .then((t) => {
        if (!live) return;
        setChoices([
          { value: 'brain', label: 'The Brain' },
          ...t.teams.map((x) => ({ value: `team:${x.id}`, label: `Team: ${x.name}` })),
          ...t.agents.map((x) => ({ value: `agent:${x.id}`, label: `Agent: ${x.name}` })),
        ]);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [projectId]);
  const save = async () => {
    setBusy(true);
    const saved = await attempt(() =>
      rpc.gateways.save({
        ...(id ? { id } : {}),
        platform,
        name,
        projectId,
        target: targetOf(target),
        users: ids(users),
        channels: ids(channels),
      }),
    );
    if (!saved) return setBusy(false);
    setId(saved.id);
    if (botToken.trim() || appToken.trim()) {
      const stored = await attempt(() =>
        rpc.gateways.tokens({
          id: saved.id,
          ...(botToken.trim() ? { botToken } : {}),
          ...(appToken.trim() ? { appToken } : {}),
        }),
      );
      if (!stored) return setBusy(false);
      setBotToken('');
      setAppToken('');
    }
    // a new one goes on at once when it has what it needs; otherwise it says what is missing
    if (!g && !saved.enabled) {
      const on = await attempt(() => rpc.gateways.enable({ id: saved.id, enabled: true }), `${saved.name} is on`);
      if (!on) return setBusy(false);
    }
    setBusy(false);
    done(saved.id);
  };
  const tokenHint = (set: boolean | undefined) => (set ? 'Saved. Type a new one to replace it.' : undefined);
  return (
    <Section
      title={g ? `Edit ${g.name}` : `New ${PLATFORM[platform]} gateway`}
      description={
        <span className="flex flex-col gap-2">
          {STEPS[platform].map((s) => (
            <span key={s}>{s}</span>
          ))}
        </span>
      }
    >
      <FieldRow label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </FieldRow>
      <FieldRow
        label={platform === 'slack' ? 'Bot token (xoxb-…)' : 'Bot token'}
        hint={tokenHint(g?.credentials.botToken)}
      >
        <input
          type="password"
          autoComplete="off"
          value={botToken}
          placeholder={g?.credentials.botToken ? '••••••••' : ''}
          onChange={(e) => setBotToken(e.target.value)}
        />
      </FieldRow>
      {platform === 'slack' ? (
        <FieldRow label="App-level token (xapp-…)" hint={tokenHint(g?.credentials.appToken)}>
          <input
            type="password"
            autoComplete="off"
            value={appToken}
            placeholder={g?.credentials.appToken ? '••••••••' : ''}
            onChange={(e) => setAppToken(e.target.value)}
          />
        </FieldRow>
      ) : null}
      <FieldRow label="Project" group="gateway-project">
        <SelectControl
          aria-label="Project"
          value={projectId}
          onChange={(v) => {
            setProjectId(v);
            setTarget('brain');
          }}
          options={projects.map((p) => ({ value: p.id, label: p.name }))}
        />
      </FieldRow>
      <FieldRow label="Who answers" group="gateway-target">
        <SelectControl aria-label="Who answers" value={target} onChange={setTarget} options={choices} />
      </FieldRow>
      <FieldRow
        label={platform === 'telegram' ? 'Telegram user IDs it answers' : 'User IDs it answers'}
        hint={
          platform === 'telegram'
            ? 'Only they get answers: anyone can find a Telegram bot. Empty at first? Write to your bot, then let yourself in from the list above.'
            : platform === 'slack'
              ? 'Leave empty to answer everyone in your workspace.'
              : 'Empty: everyone in the channels below, and no direct messages (anyone who shares a server with the bot could write).'
        }
      >
        <input value={users} placeholder="123456789" onChange={(e) => setUsers(e.target.value)} />
      </FieldRow>
      {platform !== 'telegram' ? (
        <FieldRow
          label="Channel IDs"
          hint={
            platform === 'slack'
              ? 'Channels where it answers when mentioned (invite the bot there too). Empty: direct messages only.'
              : 'Channels where it answers when mentioned (threads in them too).'
          }
        >
          <input
            value={channels}
            placeholder={platform === 'slack' ? 'C0123ABCD' : '1234567890'}
            onChange={(e) => setChannels(e.target.value)}
          />
        </FieldRow>
      ) : null}
      <RowActions>
        <Button variant="ghost" size="small" onClick={close}>
          Cancel
        </Button>
        <Button size="small" disabled={busy || !projectId} onClick={() => void save()}>
          <Icon name="check" size={13} />
          {g ? 'Save' : 'Add and turn on'}
        </Button>
      </RowActions>
    </Section>
  );
}

const targetValue = (t: GatewayTarget) => (t.kind === 'brain' ? 'brain' : `${t.kind}:${t.id}`);
function targetOf(value: string): GatewayTarget {
  const [kind, id] = value.split(':');
  return kind === 'team' || kind === 'agent' ? { kind, id } : { kind: 'brain' };
}

// ---------- messages ----------
const STATUS: Record<GatewayMessage['status'], [PillTone, string]> = {
  queued: ['dim', 'Waiting'],
  working: ['info', 'Working…'],
  done: ['ok', 'Answered'],
  failed: ['bad', 'Failed'],
};

function GatewayMessages({ g, close }: { g: GatewayListing; close: () => void }) {
  const [list, setList] = useState<GatewayMessage[] | null>(null);
  const load = useCallback(() => rpc.gateways.messages({ id: g.id }).then(setList), [g.id]);
  useEffect(() => void load().catch(() => setList([])), [load]);
  useServerEvents((ev) => {
    if (ev.type === 'gateway-messages' && ev.id === g.id) void load().catch(() => {});
  });
  return (
    <Section
      title={`Messages · ${g.name}`}
      description="What people sent it and how each answer went, newest first. A failed one can be tried again: what already arrived isn't sent twice."
      action={
        <Button variant="ghost" size="small" onClick={close}>
          Close
        </Button>
      }
    >
      {list?.length ? (
        list.slice(0, 50).map((m) => <MessageRow key={m.id} g={g} m={m} />)
      ) : (
        <PanelNote>{list ? 'No messages yet.' : 'Loading…'}</PanelNote>
      )}
    </Section>
  );
}

function MessageRow({ g, m }: { g: GatewayListing; m: GatewayMessage }) {
  const [tone, label] = STATUS[m.status];
  const [open, setOpen] = useState(m.status === 'failed');
  const files = [...m.files, ...(m.outFiles || [])];
  return (
    <Row
      stack
      className="gateway-message"
      title={
        <span className="flex flex-wrap items-center gap-2">
          <Pill tone={tone}>{label}</Pill>
          <span>{m.sender.name}</span>
          <span className="text-[13px] font-normal text-dim">{`in ${m.chatTitle} · ${ago(m.createdAt)}`}</span>
        </span>
      }
      description={<span className="line-clamp-3 whitespace-pre-wrap">{m.text || '(files only)'}</span>}
    >
      <div className="flex flex-col gap-2 text-[13px]">
        {m.error ? <div className="text-red">{m.error}</div> : null}
        {files.length ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-dim">
            {files.map((f, i) => (
              <span key={`${f.name}-${i}`} title={f.error || f.path || ''} className={f.error ? 'text-red' : ''}>
                {`${i < m.files.length ? '↓' : '↑'} ${f.name}${f.error ? ' (failed)' : ''}`}
              </span>
            ))}
          </div>
        ) : null}
        {m.answer !== undefined && open ? (
          <div className="max-h-60 overflow-auto whitespace-pre-wrap rounded-box bg-panel-2 px-3 py-2 text-ink">
            {m.answer || '(No answer)'}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {m.answer !== undefined ? (
            <Button variant="ghost" size="tiny" aria-expanded={open} onClick={() => setOpen(!open)}>
              {open ? 'Hide the answer' : 'Show the answer'}
            </Button>
          ) : null}
          {m.status === 'failed' ? (
            <>
              <Button
                size="tiny"
                disabled={!g.enabled}
                title={g.enabled ? '' : 'Turn the gateway on first'}
                onClick={() => void attempt(() => rpc.gateways.retry({ id: g.id, messageId: m.id }))}
              >
                <Icon name="refresh-cw" size={12} />
                Retry
              </Button>
              <Button
                variant="ghost"
                size="tiny"
                onClick={() => void attempt(() => rpc.gateways.dismiss({ id: g.id, messageId: m.id }))}
              >
                Dismiss
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </Row>
  );
}
