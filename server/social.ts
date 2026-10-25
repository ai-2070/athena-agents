// Social accounts. X uses OAuth 2.0 with your own X developer app (PKCE, tokens stay in ./data).
// Every post an agent writes lands in the Outbox and waits for you, unless you turn on auto-post for that account.
import crypto from 'node:crypto';
import { dataPath, readJSON, writeJSON, fetchJSON, uid } from './util.ts';
import { getSettings, getSecrets, outbox as outboxStore, emit, log } from './store.ts';
import * as reddit from './reddit.ts';
import type { FetchError } from './util.ts';
import type { Collection } from './store.ts';
import type { Accounts, OutboxPost, XAccount } from '../shared/types.ts';
import type { StoredRedditAccount } from './reddit.ts';

/** A connected X account as accounts.json stores it (tokens never leave the server). */
export type StoredXAccount = Omit<XAccount, 'autopost'> & {
  autopost?: boolean;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
};

/** data/accounts.json: X and Reddit accounts by id. */
export interface AccountsFile {
  x: Record<string, StoredXAccount>;
  reddit?: Record<string, StoredRedditAccount>;
}

/** The query an OAuth provider sends back to /oauth/.../callback. */
export interface OAuthQuery {
  code?: string;
  state?: string;
  error?: string;
}

/**
 * An Outbox item as this file writes it. Wider than the shared OutboxPost: accountId/agentId can be null,
 * and it keeps how far publishing got.
 */
export interface OutboxItem {
  id: string;
  platform: OutboxPost['platform'];
  accountId?: string | null;
  accountLabel?: string;
  parts: string[];
  status: OutboxPost['status'] | 'posting';
  agentId?: string | null;
  agentName?: string;
  note?: string;
  url?: string;
  to?: string;
  replyTo?: string | null;
  reddit?: OutboxPost['reddit'];
  postIds?: string[];
  postedAt?: number;
  error?: string | null;
  reason?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface DraftInput {
  platform?: string;
  account?: string;
  text?: string;
  thread?: string[] | null;
  replyTo?: string | null;
  to?: string | null;
  agentId?: string | null;
  agentName?: string;
  note?: string;
  subreddit?: string;
  title?: string;
  link?: string;
  parent?: string;
}

/** What you changed when approving: the parts (X) and the title (Reddit). */
export interface ApproveEdits {
  parts?: string[];
  title?: string | null;
}

// ---------- X API answers (only the fields used here) ----------
interface XToken {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}
interface XUser {
  id: string;
  username: string;
  name: string;
  profile_image_url?: string;
}
interface XTweet {
  id: string;
  text: string;
  created_at?: string;
  author_id: string;
  public_metrics?: Record<string, number>;
}
interface XTweetList {
  data?: XTweet[];
  includes?: { users?: { id: string; username: string }[] };
}

// The shared OutboxPost type has no room for null ids or publishing progress (see OutboxItem).
const outbox = outboxStore as unknown as Collection<OutboxItem>;

const ACCOUNTS_FILE = dataPath('accounts.json');
const X_API = 'https://api.x.com/2';
// dm.read/dm.write let agents draft DMs (accounts connected before DMs existed need a reconnect).
const X_SCOPES = 'tweet.read tweet.write users.read like.write dm.read dm.write offline.access';

const loadAccounts = () => readJSON<AccountsFile>(ACCOUNTS_FILE, { x: {} });
const saveAccounts = (a: AccountsFile) => writeJSON(ACCOUNTS_FILE, a);

export function listAccounts(): Accounts {
  const a = loadAccounts();
  const s = getSettings();
  const sec = getSecrets();
  return {
    x: Object.values(a.x || {}).map(({ id, username, name, autopost, connectedAt, avatar }) => ({ id, username, name, autopost: !!autopost, connectedAt, avatar })),
    xAppConfigured: !!s.x.clientId,
    telegram: { configured: !!(sec.telegramBotToken && s.telegram.chatId) },
    discord: { configured: !!sec.discordWebhook },
    reddit: reddit.redditAccounts(),
    redditAppConfigured: reddit.redditAppConfigured(),
  };
}

// ---------- X OAuth ----------
const pendingAuth = new Map<string, { verifier: string; redirectUri: string; at: number }>();

export function xAuthStart(baseUrl: string): string {
  const { clientId } = getSettings().x;
  if (!clientId) throw new Error('Add your X app Client ID in Connections first.');
  const state = crypto.randomBytes(16).toString('hex');
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = `${baseUrl}/oauth/x/callback`;
  pendingAuth.set(state, { verifier, redirectUri, at: Date.now() });
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: X_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `https://x.com/i/oauth2/authorize?${q}`;
}

function tokenHeaders() {
  const { clientId } = getSettings().x;
  const secret = getSecrets().xClientSecret;
  const h: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (secret) h.authorization = `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
  return h;
}

export async function xAuthCallback({ code, state, error }: OAuthQuery): Promise<StoredXAccount> {
  if (error) throw new Error(`X said: ${error}`);
  const p = pendingAuth.get(String(state));
  if (!p) throw new Error('This sign-in link expired. Start again from Connections.');
  pendingAuth.delete(String(state));
  const { clientId } = getSettings().x;
  const tok = await fetchJSON<XToken>('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: tokenHeaders(),
    body: new URLSearchParams({ code: String(code), grant_type: 'authorization_code', client_id: clientId, redirect_uri: p.redirectUri, code_verifier: p.verifier }),
  });
  const me = await fetchJSON<{ data: XUser }>(`${X_API}/users/me?user.fields=profile_image_url,name,username`, { headers: { authorization: `Bearer ${tok.access_token}` } });
  const a = loadAccounts();
  a.x ||= {};
  const prev: Partial<StoredXAccount> = a.x[me.data.id] || {};
  a.x[me.data.id] = {
    ...prev,
    id: me.data.id,
    username: me.data.username,
    name: me.data.name,
    avatar: me.data.profile_image_url,
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: Date.now() + (tok.expires_in || 7200) * 1000,
    connectedAt: prev.connectedAt || Date.now(),
  };
  saveAccounts(a);
  log('social', `Connected X account @${me.data.username}`);
  emit('accounts');
  return a.x[me.data.id];
}

// X refresh tokens are single-use, so refreshes are serialized per account.
const refreshing = new Map<string, Promise<string>>();
async function xToken(accountId: string): Promise<string> {
  const a = loadAccounts();
  const acc = a.x?.[accountId];
  if (!acc) throw new Error('That X account is not connected.');
  if (acc.expiresAt - Date.now() > 60_000) return acc.accessToken;
  if (refreshing.has(accountId)) return refreshing.get(accountId)!;
  const job = (async () => {
    if (!acc.refreshToken) throw new Error(`@${acc.username} needs to be reconnected (no refresh token).`);
    const tok = await fetchJSON<XToken>('https://api.x.com/2/oauth2/token', {
      method: 'POST',
      headers: tokenHeaders(),
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: acc.refreshToken, client_id: getSettings().x.clientId }),
    }).catch((e: FetchError) => {
      throw new Error(`Couldn't refresh @${acc.username}'s sign-in (${e.message}). Reconnect it in Connections.`);
    });
    const fresh = loadAccounts();
    Object.assign(fresh.x[accountId], {
      accessToken: tok.access_token,
      refreshToken: tok.refresh_token || acc.refreshToken,
      expiresAt: Date.now() + (tok.expires_in || 7200) * 1000,
    });
    saveAccounts(fresh);
    return tok.access_token;
  })();
  refreshing.set(accountId, job);
  try {
    return await job;
  } finally {
    refreshing.delete(accountId);
  }
}

export function resolveXAccount(handle?: string): StoredXAccount {
  const accs = Object.values(loadAccounts().x || {});
  if (!accs.length) throw new Error('No X account is connected yet. Connect one in Connections.');
  if (!handle) return accs[0];
  const h = String(handle).replace(/^@/, '').toLowerCase();
  const acc = accs.find((x) => x.username.toLowerCase() === h || x.id === handle);
  if (!acc) throw new Error(`@${h} is not connected. Connected: ${accs.map((x) => '@' + x.username).join(', ')}`);
  return acc;
}

async function xCall<T>(accountId: string, method: string, pathname: string, body?: unknown): Promise<T> {
  const token = await xToken(accountId);
  return fetchJSON<T>(`${X_API}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Post one tweet or a thread (each part replies to the one before).
// Already-posted parts (doneIds) are skipped, so a retry continues a half-posted thread.
async function xPublish(accountId: string, parts: string[], replyTo: string | null | undefined, doneIds: string[] = [], onPart: (ids: string[]) => void = () => {}) {
  const acc = loadAccounts().x[accountId];
  if (!acc) throw new Error('That X account is no longer connected.');
  const ids = [...doneIds];
  let parent = ids.at(-1) || replyTo || null;
  for (const text of parts.slice(ids.length)) {
    const res = await xCall<{ data: { id: string } }>(accountId, 'POST', '/tweets', { text, ...(parent ? { reply: { in_reply_to_tweet_id: parent } } : {}) });
    ids.push(res.data.id);
    parent = res.data.id;
    onPart(ids);
  }
  return { ids, url: `https://x.com/${acc.username}/status/${ids[0]}` };
}

async function xSendDm(accountId: string, handle: string, text: string) {
  const user = await xCall<{ data: { id: string } }>(accountId, 'GET', `/users/by/username/${encodeURIComponent(handle)}`).catch((e: FetchError) => {
    throw new Error(`Couldn't find @${handle} on X (${e.message}).`);
  });
  const r = await xCall<{ data?: { dm_event_id?: string; id?: string } }>(accountId, 'POST', `/dm_conversations/with/${user.data.id}/messages`, { text }).catch((e: FetchError) => {
    if (e.status === 403) throw new Error(`X refused the DM (${e.message}). Reconnect your account in Connections so it may send DMs, and check that @${handle} accepts messages from you.`);
    throw e;
  });
  return { id: r.data?.dm_event_id || r.data?.id };
}

export async function xRecentPosts(handle?: string, limit = 10) {
  const acc = resolveXAccount(handle);
  const r = await xCall<XTweetList>(acc.id, 'GET', `/users/${acc.id}/tweets?max_results=${Math.min(Math.max(limit, 5), 100)}&tweet.fields=created_at,public_metrics`);
  return (r.data || []).map((t) => ({ id: t.id, text: t.text, createdAt: t.created_at, metrics: t.public_metrics, url: `https://x.com/${acc.username}/status/${t.id}` }));
}

export async function xMentions(handle?: string, limit = 10) {
  const acc = resolveXAccount(handle);
  const r = await xCall<XTweetList>(acc.id, 'GET', `/users/${acc.id}/mentions?max_results=${Math.min(Math.max(limit, 5), 100)}&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username`);
  const users = new Map((r.includes?.users || []).map((u) => [u.id, u.username]));
  return (r.data || []).map((t) => ({ id: t.id, text: t.text, from: users.get(t.author_id), createdAt: t.created_at, url: `https://x.com/i/status/${t.id}` }));
}

export function setAutopost(accountId: string, on: unknown) {
  const a = loadAccounts();
  if (!a.x?.[accountId]) throw new Error('Unknown account');
  a.x[accountId].autopost = !!on;
  saveAccounts(a);
  emit('accounts');
}

export function disconnectX(accountId: string) {
  const a = loadAccounts();
  const acc = a.x?.[accountId];
  delete a.x?.[accountId];
  saveAccounts(a);
  if (acc) log('social', `Disconnected @${acc.username}`);
  emit('accounts');
}

// ---------- Outbox ----------
export async function draftPost({ platform = 'x', account, text, thread = null, replyTo = null, to = null, agentId = null, agentName = '', note = '', subreddit = '', title = '', link = '', parent = '' }: DraftInput): Promise<OutboxItem & { autoPosted?: boolean }> {
  // Reddit: a post (subreddit + title + text or link) or a comment (parent = post/comment id or URL)
  if (platform === 'reddit') {
    const acc = reddit.resolveRedditAccount(account);
    const isComment = !!parent;
    const body = String(text || '').trim();
    let parentId = String(parent || '');
    const sr = String(subreddit || '').replace(/^\/?r\//, '');
    if (isComment) {
      const m = /comments\/(\w+)(?:\/[^/]*\/(\w+))?/.exec(parentId);
      if (m) parentId = m[2] ? `t1_${m[2]}` : `t3_${m[1]}`;
      if (!/^t[13]_\w+$/.test(parentId)) throw new Error('Reply to what? Give the post or comment URL, or its id like t3_abc123.');
      if (!body) throw new Error('The comment is empty.');
    } else {
      if (!/^\w{2,21}$/.test(sr)) throw new Error('Which subreddit? For example LocalLLaMA.');
      if (!String(title).trim()) throw new Error('A Reddit post needs a title.');
      if (!body && !link) throw new Error('Add the post text or a link.');
    }
    const label = isComment ? `u/${acc.username} · comment` : `u/${acc.username} → r/${sr}`;
    const item = outbox.save({ id: uid('p'), platform: 'reddit', accountId: acc.id, accountLabel: label, parts: [body || link], reddit: { kind: isComment ? 'comment' : 'post', subreddit: sr, title: String(title).trim().slice(0, 300), link: link || '', parent: parentId }, agentId, agentName, note, status: 'pending' });
    log('social', `${agentName || 'You'} drafted a Reddit ${isComment ? 'comment' : 'post'} (${label})`, { agentId });
    if (acc.autopost) return { ...(await approvePost(item.id)), autoPosted: true };
    return item;
  }
  const parts = (thread && thread.length ? thread : [text]).map((t) => String(t || '').trim()).filter(Boolean);
  if (!parts.length) throw new Error('The post is empty.');
  let accountId: string | null = null;
  let accountLabel = platform;
  if (platform === 'x_dm') {
    const handle = String(to || '').replace(/^@/, '').trim();
    if (!/^\w{1,15}$/.test(handle)) throw new Error('Who is the DM for? Give their X handle.');
    const body = parts.join('\n\n');
    if (body.length > 10000) throw new Error('DMs can be at most 10,000 characters.');
    const acc = resolveXAccount(account);
    const item = outbox.save({ id: uid('p'), platform, accountId: acc.id, accountLabel: `@${acc.username} → DM @${handle}`, to: handle, parts: [body], agentId, agentName, note, status: 'pending' });
    log('social', `${agentName || 'You'} drafted a DM to @${handle}`, { agentId });
    return item; // DMs always wait for you, even with auto-post on
  }
  if (platform === 'x') {
    const tooLong = parts.find((p) => [...p].length > 280);
    if (tooLong) throw new Error(`A post is ${[...tooLong].length} characters; X allows 280. Shorten it or split it into a thread.`);
    const acc = resolveXAccount(account);
    accountId = acc.id;
    accountLabel = `@${acc.username}`;
  }
  const item = outbox.save({ id: uid('p'), platform, accountId, accountLabel, parts, replyTo, agentId, agentName, note, status: 'pending' });
  log('social', `${agentName || 'You'} drafted a ${platform} post for ${accountLabel}`, { agentId });
  const acc = platform === 'x' ? loadAccounts().x[String(accountId)] : null;
  if (acc?.autopost) {
    const done = await approvePost(item.id);
    return { ...done, autoPosted: true };
  }
  return item;
}

const publishing = new Set<string>();

export async function approvePost(id: string, edits: ApproveEdits | null = null): Promise<OutboxItem> {
  const item = outbox.get(id);
  if (!item) throw new Error('No such post.');
  if (item.status === 'posted') return item;
  if (publishing.has(id)) throw new Error('This post is already being published.');
  publishing.add(id);
  const posted = item.postIds?.length || 0;
  // Parts already on X can't be edited any more.
  if (edits?.parts) item.parts = [...item.parts.slice(0, posted), ...edits.parts.slice(posted).map((p) => String(p).trim()).filter(Boolean)];
  item.status = 'posting';
  outbox.save(item);
  try {
    if (item.platform === 'x') {
      const r = await xPublish(String(item.accountId), item.parts, item.replyTo, item.postIds || [], (ids) => {
        item.postIds = [...ids];
        outbox.save(item);
      });
      Object.assign(item, { status: 'posted', url: r.url, postIds: r.ids, postedAt: Date.now(), error: null });
    } else if (item.platform === 'x_dm') {
      const r = await xSendDm(String(item.accountId), String(item.to), item.parts.join('\n\n'));
      Object.assign(item, { status: 'posted', postIds: [r.id], postedAt: Date.now(), error: null, url: 'https://x.com/messages' });
    } else if (item.platform === 'reddit') {
      if (edits?.title != null && item.reddit) item.reddit.title = String(edits.title).trim();
      const r = await reddit.publish(item);
      Object.assign(item, { status: 'posted', url: r.url, postIds: [r.id], postedAt: Date.now(), error: null });
    } else if (item.platform === 'telegram') {
      await sendTelegram(item.parts.join('\n\n'));
      Object.assign(item, { status: 'posted', postedAt: Date.now(), error: null });
    } else if (item.platform === 'discord') {
      await sendDiscord(item.parts.join('\n\n'));
      Object.assign(item, { status: 'posted', postedAt: Date.now(), error: null });
    } else throw new Error(`Posting to ${item.platform} isn't supported yet.`);
    log('social', `Posted to ${item.accountLabel}${item.url ? `: ${item.url}` : ''}`, { agentId: item.agentId });
  } catch (e) {
    const part = item.postIds?.length ? ` (${item.postIds.length} of ${item.parts.length} parts are already posted; approving again continues from there)` : '';
    Object.assign(item, { status: 'failed', error: (e as Error).message + part });
    log('error', `Post to ${item.accountLabel} failed: ${(e as Error).message}`);
  } finally {
    publishing.delete(id);
  }
  return outbox.save(item);
}

export function rejectPost(id: string, reason = '') {
  const item = outbox.get(id);
  if (!item) throw new Error('No such post.');
  Object.assign(item, { status: 'rejected', reason });
  return outbox.save(item);
}

// ---------- Telegram & Discord ----------
export async function sendTelegram(text: string, chatId?: string): Promise<string> {
  const token = getSecrets().telegramBotToken;
  const chat = chatId || getSettings().telegram.chatId;
  if (!token || !chat) throw new Error('Telegram is not set up: add a bot token and chat ID in Connections.');
  await fetchJSON(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text: String(text).slice(0, 4000), disable_web_page_preview: true }),
  });
  return 'Sent on Telegram.';
}

export async function sendDiscord(text: string): Promise<string> {
  const hook = getSecrets().discordWebhook;
  if (!hook) throw new Error('Discord is not set up: add a webhook URL in Connections.');
  const res = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: String(text).slice(0, 1990) }) });
  if (!res.ok) throw new Error(`Discord said ${res.status}`);
  return 'Sent to Discord.';
}
