// Social accounts. X uses OAuth 2.0 with your own X developer app (PKCE, tokens stay in ./data).
// Every post an agent writes lands in the Outbox and waits for you, unless you turn on auto-post for that account.
import crypto from 'node:crypto';
import { dataPath, readJSON, writeJSON, fetchJSON, uid } from './util.js';
import { getSettings, getSecrets, outbox, emit, log } from './store.js';
import * as reddit from './reddit.js';

const ACCOUNTS_FILE = dataPath('accounts.json');
const X_API = 'https://api.x.com/2';
// dm.read/dm.write let agents draft DMs (accounts connected before DMs existed need a reconnect).
const X_SCOPES = 'tweet.read tweet.write users.read like.write dm.read dm.write offline.access';

const loadAccounts = () => readJSON(ACCOUNTS_FILE, { x: {} });
const saveAccounts = (a) => writeJSON(ACCOUNTS_FILE, a);

export function listAccounts() {
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
const pendingAuth = new Map();

export function xAuthStart(baseUrl) {
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
  const h = { 'content-type': 'application/x-www-form-urlencoded' };
  if (secret) h.authorization = `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`;
  return h;
}

export async function xAuthCallback({ code, state, error }) {
  if (error) throw new Error(`X said: ${error}`);
  const p = pendingAuth.get(state);
  if (!p) throw new Error('This sign-in link expired. Start again from Connections.');
  pendingAuth.delete(state);
  const { clientId } = getSettings().x;
  const tok = await fetchJSON('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: tokenHeaders(),
    body: new URLSearchParams({ code, grant_type: 'authorization_code', client_id: clientId, redirect_uri: p.redirectUri, code_verifier: p.verifier }),
  });
  const me = await fetchJSON(`${X_API}/users/me?user.fields=profile_image_url,name,username`, { headers: { authorization: `Bearer ${tok.access_token}` } });
  const a = loadAccounts();
  a.x ||= {};
  const prev = a.x[me.data.id] || {};
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
const refreshing = new Map();
async function xToken(accountId) {
  const a = loadAccounts();
  const acc = a.x?.[accountId];
  if (!acc) throw new Error('That X account is not connected.');
  if (acc.expiresAt - Date.now() > 60_000) return acc.accessToken;
  if (refreshing.has(accountId)) return refreshing.get(accountId);
  const job = (async () => {
    if (!acc.refreshToken) throw new Error(`@${acc.username} needs to be reconnected (no refresh token).`);
    const tok = await fetchJSON('https://api.x.com/2/oauth2/token', {
      method: 'POST',
      headers: tokenHeaders(),
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: acc.refreshToken, client_id: getSettings().x.clientId }),
    }).catch((e) => {
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

export function resolveXAccount(handle) {
  const accs = Object.values(loadAccounts().x || {});
  if (!accs.length) throw new Error('No X account is connected yet. Connect one in Connections.');
  if (!handle) return accs[0];
  const h = String(handle).replace(/^@/, '').toLowerCase();
  const acc = accs.find((x) => x.username.toLowerCase() === h || x.id === handle);
  if (!acc) throw new Error(`@${h} is not connected. Connected: ${accs.map((x) => '@' + x.username).join(', ')}`);
  return acc;
}

async function xCall(accountId, method, pathname, body) {
  const token = await xToken(accountId);
  return fetchJSON(`${X_API}${pathname}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}

// Post one tweet or a thread (each part replies to the one before).
// Already-posted parts (doneIds) are skipped, so a retry continues a half-posted thread.
async function xPublish(accountId, parts, replyTo, doneIds = [], onPart = () => {}) {
  const acc = loadAccounts().x[accountId];
  if (!acc) throw new Error('That X account is no longer connected.');
  const ids = [...doneIds];
  let parent = ids.at(-1) || replyTo || null;
  for (const text of parts.slice(ids.length)) {
    const res = await xCall(accountId, 'POST', '/tweets', { text, ...(parent ? { reply: { in_reply_to_tweet_id: parent } } : {}) });
    ids.push(res.data.id);
    parent = res.data.id;
    onPart(ids);
  }
  return { ids, url: `https://x.com/${acc.username}/status/${ids[0]}` };
}

async function xSendDm(accountId, handle, text) {
  const user = await xCall(accountId, 'GET', `/users/by/username/${encodeURIComponent(handle)}`).catch((e) => {
    throw new Error(`Couldn't find @${handle} on X (${e.message}).`);
  });
  const r = await xCall(accountId, 'POST', `/dm_conversations/with/${user.data.id}/messages`, { text }).catch((e) => {
    if (e.status === 403) throw new Error(`X refused the DM (${e.message}). Reconnect your account in Connections so it may send DMs, and check that @${handle} accepts messages from you.`);
    throw e;
  });
  return { id: r.data?.dm_event_id || r.data?.id };
}

export async function xRecentPosts(handle, limit = 10) {
  const acc = resolveXAccount(handle);
  const r = await xCall(acc.id, 'GET', `/users/${acc.id}/tweets?max_results=${Math.min(Math.max(limit, 5), 100)}&tweet.fields=created_at,public_metrics`);
  return (r.data || []).map((t) => ({ id: t.id, text: t.text, createdAt: t.created_at, metrics: t.public_metrics, url: `https://x.com/${acc.username}/status/${t.id}` }));
}

export async function xMentions(handle, limit = 10) {
  const acc = resolveXAccount(handle);
  const r = await xCall(acc.id, 'GET', `/users/${acc.id}/mentions?max_results=${Math.min(Math.max(limit, 5), 100)}&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username`);
  const users = new Map((r.includes?.users || []).map((u) => [u.id, u.username]));
  return (r.data || []).map((t) => ({ id: t.id, text: t.text, from: users.get(t.author_id), createdAt: t.created_at, url: `https://x.com/i/status/${t.id}` }));
}

export function setAutopost(accountId, on) {
  const a = loadAccounts();
  if (!a.x?.[accountId]) throw new Error('Unknown account');
  a.x[accountId].autopost = !!on;
  saveAccounts(a);
  emit('accounts');
}

export function disconnectX(accountId) {
  const a = loadAccounts();
  const acc = a.x?.[accountId];
  delete a.x?.[accountId];
  saveAccounts(a);
  if (acc) log('social', `Disconnected @${acc.username}`);
  emit('accounts');
}

// ---------- Outbox ----------
export async function draftPost({ platform = 'x', account, text, thread = null, replyTo = null, to = null, agentId = null, agentName = '', note = '', subreddit = '', title = '', link = '', parent = '' }) {
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
  let accountId = null;
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
  const acc = platform === 'x' ? loadAccounts().x[accountId] : null;
  if (acc?.autopost) {
    const done = await approvePost(item.id);
    return { ...done, autoPosted: true };
  }
  return item;
}

const publishing = new Set();

export async function approvePost(id, edits = null) {
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
      const r = await xPublish(item.accountId, item.parts, item.replyTo, item.postIds || [], (ids) => {
        item.postIds = [...ids];
        outbox.save(item);
      });
      Object.assign(item, { status: 'posted', url: r.url, postIds: r.ids, postedAt: Date.now(), error: null });
    } else if (item.platform === 'x_dm') {
      const r = await xSendDm(item.accountId, item.to, item.parts.join('\n\n'));
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
    Object.assign(item, { status: 'failed', error: e.message + part });
    log('error', `Post to ${item.accountLabel} failed: ${e.message}`);
  } finally {
    publishing.delete(id);
  }
  return outbox.save(item);
}

export function rejectPost(id, reason = '') {
  const item = outbox.get(id);
  if (!item) throw new Error('No such post.');
  Object.assign(item, { status: 'rejected', reason });
  return outbox.save(item);
}

// ---------- Telegram & Discord ----------
export async function sendTelegram(text, chatId) {
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

export async function sendDiscord(text) {
  const hook = getSecrets().discordWebhook;
  if (!hook) throw new Error('Discord is not set up: add a webhook URL in Connections.');
  const res = await fetch(hook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: String(text).slice(0, 1990) }) });
  if (!res.ok) throw new Error(`Discord said ${res.status}`);
  return 'Sent to Discord.';
}
