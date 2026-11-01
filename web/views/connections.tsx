// Settings > Connections: X and Reddit accounts, Telegram, Discord, and the Outbox where posts wait for you.
import { Button, ButtonLink } from '../ui/button.tsx';
import { Badge, Pill } from '../ui/marks.tsx';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { GET, POST, PUT, DEL, attempt, copy, ago, confirmBox } from '../core.ts';
import { serverUrl } from '../client/connection.ts';
import { FieldRow, PanelNote, Row, RowActions, Section, Sections, Switch, Tabs } from '../ui/controls.tsx';
import { reactPage, useAppState, useServerEvents } from '../ui/react.tsx';
import { ProgramLabel } from '../ui/programmark.tsx';
import { Outbox } from './outbox.tsx';
import type { Accounts, SecretStatus, Settings } from '../../shared/types.ts';

/** One entry of GET /api/accounts/x/:id/posts. */
interface XPost {
  id: string;
  text: string;
  createdAt: string;
  metrics?: { like_count?: number; retweet_count?: number; reply_count?: number };
  url: string;
}
interface Loaded {
  settings: Settings;
  secrets: SecretStatus;
  accounts: Accounts;
}
type Sub = 'accounts' | 'outbox';

// kept while you move around the app, as before
let lastSub: Sub = 'accounts';
/** The full address of a server path, as X and Reddit need it registered. */
const fullUrl = (path: string) => new URL(serverUrl(path), location.href).href;

export function ConnectionsTab() {
  const data = useAppState();
  const asked = new URLSearchParams(location.hash.split('?')[1] || '').get('sub');
  const [sub, setSub] = useState<Sub>(() => (asked === 'accounts' || asked === 'outbox' ? (lastSub = asked) : lastSub));
  const pending = data?.outboxPending || 0;
  return (
    <Tabs
      label="Connections"
      tabs={[
        { value: 'accounts' as const, label: 'Accounts' },
        { value: 'outbox' as const, label: <>Outbox {pending ? <Badge hot>{pending}</Badge> : null}</> },
      ]}
      value={sub}
      onChange={(s) => setSub((lastSub = s))}
      rowClassName="[&>.tabs]:flex-1"
    >
      {sub === 'outbox' ? <Outbox /> : <AccountsPanel />}
    </Tabs>
  );
}

function AccountsPanel() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  // a new number re-creates the forms from what the server has (after a save)
  const [version, setVersion] = useState(0);
  const load = useCallback(
    () =>
      Promise.all([GET<{ settings: Settings; secrets: SecretStatus }>('/settings'), GET<Accounts>('/accounts')]).then(([s, accounts]) => {
        setLoaded({ ...s, accounts });
        setVersion((v) => v + 1);
      }),
    [],
  );
  useEffect(() => void load(), [load]);
  useServerEvents((ev) => ev.type === 'accounts' && void load());
  if (!loaded) return null;
  return <AccountsForms key={version} loaded={loaded} reload={load} />;
}

function AccountsForms({ loaded, reload }: { loaded: Loaded; reload: () => Promise<unknown> }) {
  const { settings, secrets, accounts } = loaded;
  const callback = fullUrl('/oauth/x/callback');
  const rdCallback = fullUrl('/oauth/reddit/callback');
  const x = useRef({ clientId: settings.x.clientId, secret: '' });
  const rd = useRef({ clientId: settings.reddit?.clientId || '', secret: '', username: settings.reddit?.username || '' });
  const tg = useRef({ token: '', chatId: settings.telegram.chatId });
  const dc = useRef('');
  const saved = (s: { set: boolean; hint?: string } | undefined, otherwise: string) => (s?.set ? `saved (${s.hint})` : otherwise);

  const saveX = async () => {
    await attempt(async () => {
      await PUT('/settings', { x: { clientId: x.current.clientId.trim() } });
      if (x.current.secret.trim()) await POST('/secrets', { key: 'xClientSecret', value: x.current.secret.trim() });
    }, 'X app saved');
    await reload();
  };
  const saveReddit = async () => {
    await attempt(async () => {
      await PUT('/settings', { reddit: { clientId: rd.current.clientId.trim(), username: rd.current.username.trim().replace(/^\/?u\//, '') } });
      if (rd.current.secret.trim()) await POST('/secrets', { key: 'redditClientSecret', value: rd.current.secret.trim() });
    }, 'Reddit app saved');
    await reload();
  };
  const saveTelegram = async () => {
    await attempt(async () => {
      if (tg.current.token.trim()) await POST('/secrets', { key: 'telegramBotToken', value: tg.current.token.trim() });
      await PUT('/settings', { telegram: { chatId: tg.current.chatId.trim() } });
    }, 'Saved');
    await reload();
  };
  const saveDiscord = async () => {
    if (dc.current.trim()) await attempt(() => POST('/secrets', { key: 'discordWebhook', value: dc.current.trim() }), 'Saved');
    await reload();
  };
  const test = (platform: string) => void attempt(() => POST<{ message: string }>('/social/test', { platform }), (r) => r.message);

  return (
    <div className="flex flex-col gap-10">
      {/* col gap-lg: the mark tests find the groups by */}
      <Sections className="col gap-lg">
        <Section title={<ProgramLabel id="x">X accounts</ProgramLabel>} description="The accounts your agents can post from." action={accounts.xAppConfigured ? <ButtonLink size="small" href={serverUrl('/oauth/x/start')}>+ Connect an account</ButtonLink> : null}>
          {accounts.x.length ? (
            accounts.x.map((a) => <XAccount key={a.id} a={a} reload={reload} />)
          ) : (
            <Row title="No account connected yet" description={accounts.xAppConfigured ? 'Click Connect, sign in to X, and approve.' : 'First set up your X app below (one time).'} />
          )}
          <PanelNote>Agents with the Social tools draft posts into the Outbox; you approve each one. X bills API use per request on your developer account.</PanelNote>
        </Section>

        <Section title={<ProgramLabel id="telegram">Telegram</ProgramLabel>} description="Agents and workflows can message you, e.g. when a long task is done.">
          <FieldRow label="Bot token" size="lg">
            <input className="code" type="password" autoComplete="off" placeholder={saved(secrets.telegramBotToken, 'Bot token from @BotFather')} onChange={(e) => (tg.current.token = e.target.value)} />
          </FieldRow>
          <FieldRow label="Chat ID" size="lg">
            <input className="code" defaultValue={settings.telegram.chatId} placeholder="Your chat ID (message @userinfobot to get it)" onChange={(e) => (tg.current.chatId = e.target.value)} />
          </FieldRow>
          <RowActions>
            <Button variant="ghost" size="small" onClick={() => test('telegram')}>Send test</Button>
            <Button size="small" onClick={() => void saveTelegram()}>Save</Button>
          </RowActions>
        </Section>

        <Section title={<ProgramLabel id="discord">Discord</ProgramLabel>} description="Post to a channel through a webhook.">
          <FieldRow label="Channel webhook URL" hint="Channel settings > Integrations > Webhooks > New webhook > Copy URL." size="lg">
            <input className="code" type="password" autoComplete="off" placeholder={saved(secrets.discordWebhook, 'https://discord.com/api/webhooks/…')} onChange={(e) => (dc.current = e.target.value)} />
          </FieldRow>
          <RowActions>
            <Button variant="ghost" size="small" onClick={() => test('discord')}>Send test</Button>
            <Button size="small" onClick={() => void saveDiscord()}>Save</Button>
          </RowActions>
        </Section>

        <Section title="Everything else" description="Gmail, Calendar, Drive, Notion, Slack and more.">
          <Row title="Other services" description="Claude Code agents can also use the connectors on your Claude account (Gmail, Calendar, Drive, Notion, Higgsfield) once each is signed in there. For other services (Slack, LinkedIn, YouTube…) add their MCP server under MCP servers." />
        </Section>
      </Sections>

      <Sections className="col gap-lg">
        <Section title="Your X app (one-time setup)" description="X needs an app of yours to sign accounts in." action={accounts.xAppConfigured ? <Pill tone="ok">ready</Pill> : <Pill tone="warn">not set</Pill>}>
          <div className="px-5 py-4">
            <ol className="conn-steps m-0 list-decimal pl-5 text-[13.5px] leading-relaxed text-dim marker:text-faint [&>li+li]:mt-2">
              <li>
                Open <a href="https://developer.x.com/en/portal/dashboard" target="_blank" rel="noopener">developer.x.com</a> and create a Project and App (or use an existing one).
              </li>
              <li>
                In the app, open User authentication settings: permissions <b className="text-ink">Read and write</b>, type <b className="text-ink">Web App / Native App</b>.
              </li>
              <li>
                Add this Callback URL exactly: <CopyCode text={callback} />
              </li>
              <li>
                Website URL can be anything (e.g. your site). Save, then copy the OAuth 2.0 <b className="text-ink">Client ID</b> here.
              </li>
            </ol>
          </div>
          <FieldRow label="Client ID" size="lg">
            <input className="code" defaultValue={settings.x.clientId} placeholder="Client ID from your X app" onChange={(e) => (x.current.clientId = e.target.value)} />
          </FieldRow>
          <FieldRow label="Client Secret" hint="Only if X shows one (confidential client). Stored on this PC only." size="lg">
            <input className="code" type="password" autoComplete="off" placeholder={saved(secrets.xClientSecret, 'Client Secret (only for confidential apps)')} onChange={(e) => (x.current.secret = e.target.value)} />
          </FieldRow>
          <RowActions>
            <Button size="small" onClick={() => void saveX()}>Save</Button>
          </RowActions>
          <PanelNote>{`Open the dashboard at the same address you registered (${location.host}). localhost and 127.0.0.1 count as different addresses for X.`}</PanelNote>
        </Section>

        <Section title="Reddit accounts" description="The accounts your agents can read and post with." action={accounts.redditAppConfigured ? <ButtonLink size="small" href={serverUrl('/oauth/reddit/start')}>+ Connect an account</ButtonLink> : null}>
          {(accounts.reddit || []).length ? (
            accounts.reddit.map((a) => (
              <div key={a.id} className="list-row flex-wrap gap-4 px-5 py-4">
                {a.icon ? <img className="size-8 rounded-full" src={a.icon} width={32} height={32} alt="" /> : <div className="avatar size-8 rounded-full text-[12px]">r/</div>}
                <div className="min-w-0 flex-1">
                  <div className="title">{`u/${a.username}`}</div>
                  <div className="hint">{`connected ${ago(a.connectedAt)}`}</div>
                </div>
                <AutoPost
                  initial={a.autopost}
                  title="Publish agent posts and comments right away, without the Outbox"
                  ask={`Let agents post to Reddit as u/${a.username} without asking you?`}
                  save={(v) => POST(`/accounts/reddit/${a.id}`, { autopost: v })}
                />
                <Button variant="danger" size="tiny" onClick={() => void disconnect(`u/${a.username}`, `/accounts/reddit/${a.id}`, reload)}>Disconnect</Button>
              </div>
            ))
          ) : (
            <Row title="No account connected yet" description={accounts.redditAppConfigured ? 'Click Connect, sign in to Reddit and allow access.' : 'First set up your Reddit app below (one time).'} />
          )}
          <PanelNote>Agents read subreddits and search freely. Posts and comments they write wait in the Outbox for you.</PanelNote>
        </Section>

        <Section title="Your Reddit app (one-time setup)" description="Reddit needs an app of yours to sign accounts in." action={accounts.redditAppConfigured ? <Pill tone="ok">ready</Pill> : <Pill tone="warn">not set</Pill>}>
          <div className="px-5 py-4">
            <ol className="conn-steps m-0 list-decimal pl-5 text-[13.5px] leading-relaxed text-dim marker:text-faint [&>li+li]:mt-2">
              <li>
                Open <a href="https://www.reddit.com/prefs/apps" target="_blank" rel="noopener">reddit.com/prefs/apps</a> and click <b className="text-ink">create another app</b>.
              </li>
              <li>
                Pick type <b className="text-ink">web app</b>, any name.
              </li>
              <li>
                Redirect URI exactly: <CopyCode text={rdCallback} />
              </li>
              <li>
                Create it, then copy the <b className="text-ink">Client ID</b> (under the app name) and the <b className="text-ink">secret</b> here.
              </li>
            </ol>
          </div>
          <FieldRow label="Client ID" size="lg">
            <input className="code" defaultValue={settings.reddit?.clientId || ''} placeholder="Client ID (under the app name)" onChange={(e) => (rd.current.clientId = e.target.value)} />
          </FieldRow>
          <FieldRow label="Secret" hint="Stored on this PC only." size="lg">
            <input className="code" type="password" autoComplete="off" placeholder={saved(secrets.redditClientSecret, 'Secret')} onChange={(e) => (rd.current.secret = e.target.value)} />
          </FieldRow>
          <FieldRow label="Your Reddit username" hint="Reddit asks apps to say who runs them." size="lg">
            <input defaultValue={settings.reddit?.username || ''} placeholder="Your Reddit username" onChange={(e) => (rd.current.username = e.target.value)} />
          </FieldRow>
          <RowActions>
            <Button size="small" onClick={() => void saveReddit()}>Save</Button>
          </RowActions>
        </Section>
      </Sections>
    </div>
  );
}

const CopyCode = ({ text }: { text: string }) => (
  <>
    <code className="break-all text-ink">{text}</code>{' '}
    <Button variant="ghost" size="tiny" className="ml-1 align-middle" onClick={() => copy(text)}>Copy</Button>
  </>
);

async function disconnect(who: string, path: string, reload: () => Promise<unknown>): Promise<void> {
  if (await confirmBox(`Disconnect ${who}?`, { ok: 'Disconnect', danger: true })) await attempt(() => DEL(path)).then(reload);
}

/** Publish right away, without the Outbox. Turning it on asks first. */
function AutoPost({ initial, title, ask, save }: { initial: boolean; title: string; ask: string; save: (on: boolean) => Promise<unknown> }) {
  const [on, setOn] = useState(initial);
  const change = async (v: boolean) => {
    if (v && !(await confirmBox(ask, { ok: 'Turn on', danger: true }))) return;
    setOn(v);
    // not saved: the switch goes back, so it shows what the account really does
    const saved = await attempt(async () => (await save(v), true), v ? 'Auto-post on' : 'Auto-post off');
    if (!saved) setOn(!v);
  };
  return (
    <span title={title}>
      <Switch checked={on} onChange={(v) => void change(v)}>
        <span className="hint">Auto-post</span>
      </Switch>
    </span>
  );
}

function XAccount({ a, reload }: { a: Accounts['x'][number]; reload: () => Promise<unknown> }) {
  const [posts, setPosts] = useState<XPost[] | 'loading' | null>(null);
  const recent = async () => {
    setPosts('loading');
    setPosts((await attempt(() => GET<XPost[]>(`/accounts/x/${a.id}/posts`))) || null);
  };
  let shown: ReactNode = null;
  if (posts === 'loading') shown = <p className="hint">Loading…</p>;
  else if (posts)
    shown = posts.map((p) => (
      <div key={p.id} className="list-row">
        <div className="min-w-0 flex-1 text-[13.5px]">
          {p.text}
          <div className="hint">{`♥ ${p.metrics?.like_count ?? 0} · ↻ ${p.metrics?.retweet_count ?? 0} · 💬 ${p.metrics?.reply_count ?? 0} · ${ago(Date.parse(p.createdAt))}`}</div>
        </div>
        <ButtonLink variant="ghost" size="tiny" href={p.url} target="_blank" rel="noopener">Open</ButtonLink>
      </div>
    ));
  return (
    <div className="conn-account px-5 py-4">
      <div className="flex flex-wrap items-center gap-4">
        {a.avatar ? <img className="size-9 rounded-full border border-line-2" src={a.avatar} width={36} height={36} alt="" /> : <div className="avatar size-9 rounded-full">𝕏</div>}
        <div className="min-w-0 flex-1">
          <div className="title">{`@${a.username}`}</div>
          <div className="hint">{`${a.name} · connected ${ago(a.connectedAt)}`}</div>
        </div>
        <AutoPost initial={a.autopost} title="Publish agent posts right away, without the Outbox" ask={`Let agents publish to @${a.username} without asking you? Posts will go out immediately.`} save={(v) => POST(`/accounts/x/${a.id}`, { autopost: v })} />
      </div>
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <Button variant="ghost" size="tiny" onClick={() => void recent()}>Recent posts</Button>
        <ButtonLink variant="ghost" size="tiny" href={serverUrl('/oauth/x/start')}>Reconnect</ButtonLink>
        <Button variant="danger" size="tiny" onClick={() => void disconnect(`@${a.username}`, `/accounts/x/${a.id}`, reload)}>Disconnect</Button>
      </div>
      <div aria-live="polite">{shown}</div>
    </div>
  );
}

export const title = () => 'Connections';
export const { render, unmount } = reactPage(() => <ConnectionsTab />);
