// Connections: X accounts, Telegram, Discord, and the Outbox where posts wait for you.
import { h, mount, clear, state, GET, POST, PUT, DEL, attempt, field, toggle, toast, copy, ago, confirmBox, refreshSoon, onState } from '../core.ts';
import type { Accounts, OutboxPost, SecretStatus, ServerEvent, Settings } from '../../shared/types.ts';

/** One entry of GET /api/accounts/x/:id/posts. */
interface XPost {
  id: string;
  text: string;
  createdAt: string;
  metrics?: { like_count?: number; retweet_count?: number; reply_count?: number };
  url: string;
}

let root: HTMLElement | undefined;
let tab = 'accounts';
let off: (() => void) | undefined;

export const title = () => 'Connections';

export async function render(el: HTMLElement): Promise<void> {
  root = el;
  const q = new URLSearchParams(location.hash.split('?')[1] || '');
  if ((['accounts', 'outbox'] as (string | null)[]).includes(q.get('sub'))) tab = q.get('sub')!;
  await draw();
}

export function unmount(): void {
  off?.();
}

export function onEvent(ev: ServerEvent): void {
  if (ev.type === 'outbox' && tab === 'outbox') draw();
  if (ev.type === 'accounts' && tab === 'accounts') draw();
}

async function draw() {
  const body = h('div');
  const pending = state.data?.outboxPending || 0;
  mount(
    root!,
    h(
      'div.tabs',
      h(`button${tab === 'accounts' ? '.on' : ''}`, { onclick: () => ((tab = 'accounts'), draw()) }, 'Accounts'),
      h(`button${tab === 'outbox' ? '.on' : ''}`, { onclick: () => ((tab = 'outbox'), draw()) }, 'Outbox ', pending ? h('span.badge.hot', String(pending)) : null),
    ),
    body,
  );
  if (tab === 'outbox') await drawOutbox(body);
  else await drawAccounts(body);
}

async function drawAccounts(body: HTMLElement) {
  const [{ settings, secrets }, accounts] = await Promise.all([GET<{ settings: Settings; secrets: SecretStatus }>('/settings'), GET<Accounts>('/accounts')]);
  const callback = `http://${location.host}/oauth/x/callback`;
  const clientId = h('input.code', { value: settings.x.clientId, placeholder: 'Client ID from your X app' });
  const clientSecret = h('input', { type: 'password', placeholder: secrets.xClientSecret.set ? `saved (${secrets.xClientSecret.hint})` : 'Client Secret (only for confidential apps)' });
  const saveX = async () => {
    await attempt(async () => {
      await PUT('/settings', { x: { clientId: clientId.value.trim() } });
      if (clientSecret.value.trim()) await POST('/secrets', { key: 'xClientSecret', value: clientSecret.value.trim() });
    }, 'X app saved');
    draw();
  };

  const rdCallback = `http://${location.host}/oauth/reddit/callback`;
  const rdId = h('input.code', { value: settings.reddit?.clientId || '', placeholder: 'Client ID (under the app name)' });
  const rdSecret = h('input', { type: 'password', placeholder: secrets.redditClientSecret?.set ? `saved (${secrets.redditClientSecret.hint})` : 'Secret' });
  const rdUser = h('input', { value: settings.reddit?.username || '', placeholder: 'Your Reddit username (Reddit asks apps to say who runs them)' });
  const saveReddit = async () => {
    await attempt(async () => {
      await PUT('/settings', { reddit: { clientId: rdId.value.trim(), username: rdUser.value.trim().replace(/^\/?u\//, '') } });
      if (rdSecret.value.trim()) await POST('/secrets', { key: 'redditClientSecret', value: rdSecret.value.trim() });
    }, 'Reddit app saved');
    draw();
  };
  const tgToken = h('input', { type: 'password', placeholder: secrets.telegramBotToken.set ? `saved (${secrets.telegramBotToken.hint})` : 'Bot token from @BotFather' });
  const tgChat = h('input.code', { value: settings.telegram.chatId, placeholder: 'Your chat ID (message @userinfobot to get it)' });
  const dcHook = h('input', { type: 'password', placeholder: secrets.discordWebhook.set ? `saved (${secrets.discordWebhook.hint})` : 'https://discord.com/api/webhooks/…' });

  mount(
    body,
    h(
      'div.two-col',
      h(
        'div.col.gap-lg',
        h(
          'div.panel',
          h('div.panel-head', h('h2', '𝕏 X accounts'), h('div.actions', accounts.xAppConfigured ? h('a.btn.small', { href: '/oauth/x/start' }, '+ Connect an account') : null)),
          accounts.x.length
            ? h(
                'div.list',
                accounts.x.map((a) => {
                  const posts = h('div');
                  return h(
                    'div',
                    { style: { borderBottom: '1px solid var(--line)', padding: '10px 0' } },
                    h(
                      'div.row',
                      a.avatar ? h('img', { src: a.avatar, width: 36, height: 36, style: { border: '1px solid var(--line-2)' } }) : h('div.avatar', '𝕏'),
                      h('div.grow', h('div.title', `@${a.username}`), h('div.hint', `${a.name} · connected ${ago(a.connectedAt)}`)),
                      h('label.row', { title: 'Publish agent posts right away, without the Outbox' }, h('span.hint', 'Auto-post'), toggle(a.autopost, async (v) => {
                        if (v && !(await confirmBox(`Let agents publish to @${a.username} without asking you? Posts will go out immediately.`, { ok: 'Turn on', danger: true }))) return draw();
                        attempt(() => POST(`/accounts/x/${a.id}`, { autopost: v }), v ? 'Auto-post on' : 'Auto-post off');
                      })),
                    ),
                    h(
                      'div.row.mt',
                      h('button.btn.tiny.ghost', { onclick: async () => {
                        mount(posts, h('p.hint', 'Loading…'));
                        const list = await attempt(() => GET<XPost[]>(`/accounts/x/${a.id}/posts`));
                        mount(posts, list ? list.map((p) => h('div.list-item', h('div.grow', { style: { fontSize: '13.5px' } }, p.text, h('div.hint', `♥ ${p.metrics?.like_count ?? 0} · ↻ ${p.metrics?.retweet_count ?? 0} · 💬 ${p.metrics?.reply_count ?? 0} · ${ago(Date.parse(p.createdAt))}`)), h('a.btn.tiny.ghost', { href: p.url, target: '_blank' }, 'Open'))) : []);
                      } }, 'Recent posts'),
                      h('a.btn.tiny.ghost', { href: '/oauth/x/start' }, 'Reconnect'),
                      h('button.btn.tiny.danger', { onclick: async () => (await confirmBox(`Disconnect @${a.username}?`, { ok: 'Disconnect', danger: true })) && attempt(() => DEL(`/accounts/x/${a.id}`)).then(draw) }, 'Disconnect'),
                    ),
                    posts,
                  );
                }),
              )
            : h('p.hint', accounts.xAppConfigured ? 'No account connected yet. Click Connect, sign in to X, and approve.' : 'First set up your X app on the right (one time).'),
          h('p.hint.mt', 'Agents with the Social tools draft posts into the Outbox; you approve each one. X bills API use per request on your developer account.'),
        ),
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Reddit accounts'), h('div.actions', accounts.redditAppConfigured ? h('a.btn.small', { href: '/oauth/reddit/start' }, '+ Connect an account') : null)),
          (accounts.reddit || []).length
            ? h(
                'div.list',
                accounts.reddit.map((a) =>
                  h(
                    'div.list-item',
                    a.icon ? h('img', { src: a.icon, width: 32, height: 32, style: { borderRadius: '50%' } }) : h('div.avatar', 'r/'),
                    h('div.grow', h('div.title', `u/${a.username}`), h('div.hint', `connected ${ago(a.connectedAt)}`)),
                    h('label.row', { title: 'Publish agent posts and comments right away, without the Outbox' }, h('span.hint', 'Auto-post'), toggle(a.autopost, async (v) => {
                      if (v && !(await confirmBox(`Let agents post to Reddit as u/${a.username} without asking you?`, { ok: 'Turn on', danger: true }))) return draw();
                      attempt(() => POST(`/accounts/reddit/${a.id}`, { autopost: v }), v ? 'Auto-post on' : 'Auto-post off');
                    })),
                    h('button.btn.tiny.danger', { onclick: async () => (await confirmBox(`Disconnect u/${a.username}?`, { ok: 'Disconnect', danger: true })) && attempt(() => DEL(`/accounts/reddit/${a.id}`)).then(draw) }, 'Disconnect'),
                  ),
                ),
              )
            : h('p.hint', accounts.redditAppConfigured ? 'No account connected yet. Click Connect, sign in to Reddit and allow access.' : 'First set up your Reddit app on the right (one time).'),
          h('p.hint.mt', 'Agents read subreddits and search freely. Posts and comments they write wait in the Outbox for you.'),
        ),
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Telegram')),
          h('p.hint', 'Agents and workflows can message you, e.g. when a long task is done.'),
          h('div.grid-2.mt', field('Bot token', tgToken), field('Chat ID', tgChat)),
          h('div.row.mt', h('button.btn.small', { onclick: async () => {
            await attempt(async () => {
              if (tgToken.value.trim()) await POST('/secrets', { key: 'telegramBotToken', value: tgToken.value.trim() });
              await PUT('/settings', { telegram: { chatId: tgChat.value.trim() } });
            }, 'Saved');
            draw();
          } }, 'Save'), h('button.btn.ghost.small', { onclick: () => attempt(() => POST<{ message: string }>('/social/test', { platform: 'telegram' }), (r) => r.message) }, 'Send test')),
        ),
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Discord')),
          field('Channel webhook URL', dcHook, 'Channel settings > Integrations > Webhooks > New webhook > Copy URL.'),
          h('div.row.mt', h('button.btn.small', { onclick: async () => {
            if (dcHook.value.trim()) await attempt(() => POST('/secrets', { key: 'discordWebhook', value: dcHook.value.trim() }), 'Saved');
            draw();
          } }, 'Save'), h('button.btn.ghost.small', { onclick: () => attempt(() => POST<{ message: string }>('/social/test', { platform: 'discord' }), (r) => r.message) }, 'Send test')),
        ),
        h('div.panel', h('div.panel-head', h('h2', 'Everything else')), h('p.hint', 'Claude Code agents can also use the connectors on your Claude account (Gmail, Calendar, Drive, Notion, Higgsfield) once each is signed in there. For other services (Slack, LinkedIn, YouTube…) add their MCP server under MCP servers.')),
      ),
      h(
        'div.col.gap-lg',
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Your X app (one-time setup)'), accounts.xAppConfigured ? h('span.pill.ok', 'ready') : h('span.pill.warn', 'not set')),
          h(
            'ol',
            { style: { paddingLeft: '18px', margin: '0 0 14px', color: 'var(--dim)', fontSize: '14px' } },
            h('li', 'Open ', h('a', { href: 'https://developer.x.com/en/portal/dashboard', target: '_blank' }, 'developer.x.com'), ' and create a Project and App (or use an existing one).'),
            h('li', 'In the app, open User authentication settings: permissions ', h('b', 'Read and write'), ', type ', h('b', 'Web App / Native App'), '.'),
            h('li', 'Add this Callback URL exactly: ', h('code', callback), ' ', h('button.btn.tiny.ghost', { onclick: () => copy(callback) }, 'Copy')),
            h('li', 'Website URL can be anything (e.g. your site). Save, then copy the OAuth 2.0 ', h('b', 'Client ID'), ' here.'),
          ),
          h('div.col', field('Client ID', clientId), field('Client Secret', clientSecret, 'Only if X shows one (confidential client). Stored on this PC only.')),
          h('div.row.mt', h('button.btn.small', { onclick: saveX }, 'Save')),
          h('p.hint.mt', `Open the dashboard at the same address you registered (${location.host}). localhost and 127.0.0.1 count as different addresses for X.`),
        ),
        h(
          'div.panel',
          h('div.panel-head', h('h2', 'Your Reddit app (one-time setup)'), accounts.redditAppConfigured ? h('span.pill.ok', 'ready') : h('span.pill.warn', 'not set')),
          h(
            'ol',
            { style: { paddingLeft: '18px', margin: '0 0 14px', color: 'var(--dim)', fontSize: '14px' } },
            h('li', 'Open ', h('a', { href: 'https://www.reddit.com/prefs/apps', target: '_blank' }, 'reddit.com/prefs/apps'), ' and click ', h('b', 'create another app'), '.'),
            h('li', 'Pick type ', h('b', 'web app'), ', any name.'),
            h('li', 'Redirect URI exactly: ', h('code', rdCallback), ' ', h('button.btn.tiny.ghost', { onclick: () => copy(rdCallback) }, 'Copy')),
            h('li', 'Create it, then copy the ', h('b', 'Client ID'), ' (under the app name) and the ', h('b', 'secret'), ' here.'),
          ),
          h('div.col', field('Client ID', rdId), field('Secret', rdSecret, 'Stored on this PC only.'), field('Your Reddit username', rdUser)),
          h('div.row.mt', h('button.btn.small', { onclick: saveReddit }, 'Save')),
        ),
      ),
    ),
  );
}

async function drawOutbox(body: HTMLElement) {
  const list = await GET<OutboxPost[]>('/outbox');
  const pending = list.filter((p) => ['pending', 'failed', 'posting'].includes(p.status));
  const done = list.filter((p) => p.status === 'posted' || p.status === 'rejected');
  const accounts = state.data!.accounts.x;
  const compose = h('textarea', { rows: 3, placeholder: accounts.length ? 'Write a post yourself…' : 'Connect an X account first' });
  let composeAcc = accounts[0]?.username || '';
  mount(
    body,
    accounts.length
      ? h(
          'div.panel',
          h('div.panel-head', h('h2', 'New post')),
          compose,
          h(
            'div.row.mt',
            h('select', { onchange: (e) => (composeAcc = e.target.value) }, accounts.map((a) => h('option', { value: a.username }, `@${a.username}`))),
            h('span.hint.grow', ''),
            h('button.btn.ghost.small', { onclick: async () => {
              const r = await attempt(() => POST('/outbox', { platform: 'x', account: composeAcc, text: compose.value }), 'Added to the Outbox');
              if (r) draw();
            } }, 'Save to Outbox'),
          ),
        )
      : null,
    h('h2.section.mt-lg', `Waiting for you (${pending.length})`),
    pending.length ? h('div.col', pending.map(postCard)) : h('div.empty.box', 'No posts waiting. Agents with the Social tools put their drafts here.'),
    done.length ? [h('h2.section.mt-lg', 'History'), h('div.col', done.slice(0, 40).map(postCard))] : null,
  );
}

function postCard(p: OutboxPost) {
  const editors = p.parts.map((t) => {
    const ta = h('textarea', { rows: Math.min(6, Math.ceil(t.length / 70) + 1), value: t });
    const count = h('span.hint.mono', `${[...t].length}/280`);
    ta.addEventListener('input', () => {
      const n = [...ta.value].length;
      count.textContent = `${n}/280`;
      count.classList.toggle('red', n > 280);
    });
    return { ta, count };
  });
  const editable = p.status === 'pending' || p.status === 'failed';
  const titleIn = p.platform === 'reddit' && p.reddit?.kind === 'post' ? h('input', { value: p.reddit.title || '', placeholder: 'Title' }) : null;
  if (titleIn) titleIn.disabled = !editable;
  const status = ({ pending: h('span.pill.warn', 'waiting'), failed: h('span.pill.bad', 'failed'), posting: h('span.pill.info', 'posting…'), posted: h('span.pill.ok', 'posted'), rejected: h('span.pill', 'rejected') } as Record<string, HTMLSpanElement | undefined>)[p.status];
  return h(
    'div.panel',
    h('div.row', status, h('b', p.accountLabel), h('span.hint', `by ${p.agentName || 'you'} · ${ago(p.createdAt)}`), p.parts.length > 1 ? h('span.pill.info', `thread of ${p.parts.length}`) : null, p.url ? h('a.btn.tiny.ghost', { href: p.url, target: '_blank', style: { marginLeft: 'auto' } }, p.platform === 'reddit' ? 'View on Reddit' : p.platform === 'x_dm' ? 'Open messages' : 'View on X') : null),
    p.platform === 'reddit' ? h('div.hint.mt', p.reddit?.kind === 'comment' ? `Comment replying to ${p.reddit.parent}` : `Post in r/${p.reddit?.subreddit}${p.reddit?.link ? ` · link: ${p.reddit.link}` : ''}`) : null,
    titleIn ? h('div.mt', titleIn) : null,
    p.note ? h('p.hint.mt', p.note) : null,
    p.error ? h('p.red.mt', p.error as string) : null,
    editable ? h('div.col.mt', editors.map((e, i) => h('div', e.ta, h('div.row.between', h('span.hint', p.parts.length > 1 ? `Part ${i + 1}` : ''), e.count)))) : h('div.col.mt', p.parts.map((t) => h('div', { style: { whiteSpace: 'pre-wrap' } }, t))),
    editable
      ? h(
          'div.row.mt',
          h('button.btn.small', { onclick: async (e) => {
            (e.target as HTMLButtonElement).disabled = true;
            const r = await attempt(() => POST<OutboxPost>(`/outbox/${p.id}/approve`, { parts: editors.map((x) => x.ta.value), ...(titleIn ? { title: titleIn.value } : {}) }));
            if (r?.status === 'posted') toast('Posted ✓');
            else if (r?.status === 'failed') toast(r.error as string, 'error', 8000);
            draw();
            refreshSoon(0);
          } }, p.platform === 'x' ? 'Approve & post' : 'Approve & send'),
          h('button.btn.ghost.small', { onclick: () => attempt(() => PUT(`/outbox/${p.id}`, { parts: editors.map((x) => x.ta.value), ...(titleIn ? { title: titleIn.value } : {}) }), 'Saved') }, 'Save edits'),
          h('button.btn.danger.small', { onclick: () => attempt(() => POST(`/outbox/${p.id}/reject`, {})).then(() => (draw(), refreshSoon(0))) }, 'Reject'),
        )
      : h('div.row.mt', h('button.btn.tiny.ghost', { onclick: () => attempt(() => DEL(`/outbox/${p.id}`)).then(draw) }, 'Remove')),
  );
}
