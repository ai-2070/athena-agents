// Social accounts. X uses OAuth 2.0 with your own X developer app (PKCE, tokens stay in ./data).
// Every post an agent writes lands in the Outbox and waits for you, unless you turn on auto-post for that account.
// Replies and DMs always wait for you: X's automation rules don't allow AI replies sent without your OK.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataPath, readJSON, writeJSON, fetchJSON, uid } from './util.ts';
import { viewable, kindOf } from './files.ts';
import { teamOf } from './artifacts.ts';
import {
  getSettings,
  getSecrets,
  getGatewaySecrets,
  outbox as outboxStore,
  emit,
  log,
  activeProject,
  withProject,
} from './store.ts';
import { listGatewayInstances } from './gateways/instances.ts';
import {
  approveGatewayPost,
  assertGatewayDraftMutable,
  checkGatewayDraft,
  gatewayDraftRevision,
  gatewayPost,
  gatewayTextParts,
  prepareGatewayPost,
  projectGatewayPost,
} from './gateways/outbox-posts.ts';
import type { GatewayOutboxReadCache } from './gateways/outbox-posts.ts';
export { prepareGatewayPost } from './gateways/outbox-posts.ts';
import * as reddit from './reddit.ts';
import { xLength, X_MAX_LENGTH } from '../shared/xtext.ts';
import type { FetchError } from './util.ts';
import type { Collection } from './store.ts';
import type { Accounts, GatewayOutboxApproval, OutboxPost, XAccount, XPost } from '../shared/types.ts';
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
export interface OutboxItem extends OutboxPost {
  id: string;
  platform: OutboxPost['platform'];
  accountId?: string | null;
  accountLabel?: string;
  parts: string[];
  images?: string[];
  imageAlt?: Record<string, string>;
  status: OutboxPost['status'] | 'posting';
  agentId?: string | null;
  agentName?: string;
  teamId?: string | null;
  teamName?: string;
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
  /** Image files to attach to the first part (X only, up to 4, 5 MB each). */
  images?: string[] | null;
  /** Alt text for each image, in the same order (X only, up to 1,000 characters each). */
  imageAlt?: (string | null | undefined)[] | null;
  /** The folders those images may come from: an agent's own readable folders (default: every folder the page may show). */
  imageRoots?: string[];
  replyTo?: string | null;
  to?: string | null;
  agentId?: string | null;
  /** The chat the agent is working in, to find its team. */
  chatId?: string | null;
  agentName?: string;
  note?: string;
  subreddit?: string;
  title?: string;
  link?: string;
  parent?: string;
  gateway?: OutboxPost['gateway'];
  /** Reddit post: the subreddit's flair template id (up to 36 characters) and/or the flair text (up to 64). */
  flairId?: string;
  flairText?: string;
}

/** What you changed when approving: the parts (X) and the title (Reddit). */
export interface ApproveEdits {
  parts?: string[];
  /** The images still wanted (a subset of what the draft has: images can be taken off, not added). */
  images?: string[];
  title?: string | null;
  gatewayApproval?: GatewayOutboxApproval;
  draftRevision?: string;
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
const X_SCOPES = 'tweet.read tweet.write users.read like.write dm.read dm.write media.write offline.access';

const loadAccounts = () => readJSON<AccountsFile>(ACCOUNTS_FILE, { x: {} });
const saveAccounts = (a: AccountsFile) => writeJSON(ACCOUNTS_FILE, a);

export function listAccounts(): Accounts {
  const a = loadAccounts();
  const s = getSettings();
  const gateways = listGatewayInstances().filter(
    (instance) => instance.projectId === activeProject().id && Boolean(getGatewaySecrets(instance.id).botToken),
  );
  return {
    x: Object.values(a.x || {}).map(({ id, username, name, autopost, connectedAt, avatar }) => ({
      id,
      username,
      name,
      autopost: !!autopost,
      connectedAt,
      avatar,
    })),
    xAppConfigured: !!s.x.clientId,
    telegram: { configured: gateways.some((instance) => instance.platform === 'telegram') },
    discord: { configured: gateways.some((instance) => instance.platform === 'discord') },
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
    body: new URLSearchParams({
      code: String(code),
      grant_type: 'authorization_code',
      client_id: clientId,
      redirect_uri: p.redirectUri,
      code_verifier: p.verifier,
    }),
  });
  const me = await fetchJSON<{ data: XUser }>(`${X_API}/users/me?user.fields=profile_image_url,name,username`, {
    headers: { authorization: `Bearer ${tok.access_token}` },
  });
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
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: acc.refreshToken,
        client_id: getSettings().x.clientId,
      }),
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

// Upload one image for a tweet. Needs the media.write permission: accounts connected before it was added must be reconnected.
// The alt text, if any, is added to the uploaded image (POST /2/media/metadata) before the post is made.
async function xUploadImage(accountId: string, file: string, alt = ''): Promise<string> {
  const token = await xToken(accountId);
  const type =
    (
      { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' } as Record<
        string,
        string
      >
    )[path.extname(file).toLowerCase()] || 'image/png';
  const form = new FormData();
  form.append('media', new Blob([fs.readFileSync(file)], { type }), path.basename(file));
  form.append('media_category', 'tweet_image');
  try {
    const r = await fetchJSON<{ data?: { id?: string }; media_id_string?: string }>(`${X_API}/media/upload`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form,
      timeout: 60000,
    });
    const id = r.data?.id || r.media_id_string;
    if (!id) throw new Error('X did not return a media id');
    if (alt)
      await fetchJSON(`${X_API}/media/metadata`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ id, metadata: { alt_text: { text: alt } } }),
      });
    return id;
  } catch (e) {
    const err = e as FetchError;
    const scope =
      err.status === 401 || err.status === 403
        ? ' If this account was connected before images were supported, reconnect it in Connections so X can grant the media permission.'
        : '';
    throw new Error(`Uploading ${path.basename(file)} to X failed: ${err.message}.${scope}`);
  }
}

// Post one tweet or a thread (each part replies to the one before).
// Already-posted parts (doneIds) are skipped, so a retry continues a half-posted thread.
async function xPublish(
  accountId: string,
  parts: string[],
  replyTo: string | null | undefined,
  doneIds: string[] = [],
  images: string[] = [],
  onPart: (ids: string[]) => void = () => {},
  imageAlt: Record<string, string> = {},
) {
  const acc = loadAccounts().x[accountId];
  if (!acc) throw new Error('That X account is no longer connected.');
  const ids = [...doneIds];
  let parent = ids.at(-1) || replyTo || null;
  for (const text of parts.slice(ids.length)) {
    // the images go on the first tweet of the post
    const media =
      !ids.length && images.length
        ? { media: { media_ids: await Promise.all(images.map((p) => xUploadImage(accountId, p, imageAlt[p]))) } }
        : {};
    const res = await xCall<{ data: { id: string } }>(accountId, 'POST', '/tweets', {
      text,
      ...media,
      ...(parent ? { reply: { in_reply_to_tweet_id: parent } } : {}),
    });
    ids.push(res.data.id);
    parent = res.data.id;
    onPart(ids);
  }
  return { ids, url: `https://x.com/${acc.username}/status/${ids[0]}` };
}

async function xSendDm(accountId: string, handle: string, text: string) {
  const user = await xCall<{ data: { id: string } }>(
    accountId,
    'GET',
    `/users/by/username/${encodeURIComponent(handle)}`,
  ).catch((e: FetchError) => {
    throw new Error(`Couldn't find @${handle} on X (${e.message}).`);
  });
  const r = await xCall<{ data?: { dm_event_id?: string; id?: string } }>(
    accountId,
    'POST',
    `/dm_conversations/with/${user.data.id}/messages`,
    { text },
  ).catch((e: FetchError) => {
    if (e.status === 403)
      throw new Error(
        `X refused the DM (${e.message}). Reconnect your account in Connections so it may send DMs, and check that @${handle} accepts messages from you.`,
      );
    throw e;
  });
  return { id: r.data?.dm_event_id || r.data?.id };
}

export async function xRecentPosts(handle?: string, limit = 10): Promise<XPost[]> {
  const acc = resolveXAccount(handle);
  const r = await xCall<XTweetList>(
    acc.id,
    'GET',
    `/users/${acc.id}/tweets?max_results=${Math.min(Math.max(limit, 5), 100)}&tweet.fields=created_at,public_metrics`,
  );
  return (r.data || []).map((t) => ({
    id: t.id,
    text: t.text,
    createdAt: t.created_at,
    metrics: t.public_metrics,
    url: `https://x.com/${acc.username}/status/${t.id}`,
  }));
}

export async function xMentions(handle?: string, limit = 10) {
  const acc = resolveXAccount(handle);
  const r = await xCall<XTweetList>(
    acc.id,
    'GET',
    `/users/${acc.id}/mentions?max_results=${Math.min(Math.max(limit, 5), 100)}&tweet.fields=created_at,author_id&expansions=author_id&user.fields=username`,
  );
  const users = new Map((r.includes?.users || []).map((u) => [u.id, u.username]));
  return (r.data || []).map((t) => ({
    id: t.id,
    text: t.text,
    from: users.get(t.author_id),
    createdAt: t.created_at,
    url: `https://x.com/i/status/${t.id}`,
  }));
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
/** The real paths of the images an agent or you attached, or an error saying what is wrong with them. */
const X_IMAGE_MAX = 5 * 1024 * 1024;
export function checkImages(platform: string, images: unknown, roots?: string[]): string[] {
  const list = (Array.isArray(images) ? images : []).filter((p): p is string => typeof p === 'string' && !!p.trim());
  if (!list.length) return [];
  if (platform !== 'x') throw new Error('Images can only go with X posts for now.');
  if (list.length > 4) throw new Error('X allows at most 4 images on a post.');
  return list.map((raw) => {
    const real = viewable(raw, roots);
    if (!real) throw new Error(`${raw} is not a file in this project's folders, so it can't be attached.`);
    if (kindOf(real) !== 'image' || /\.gif$/i.test(real))
      throw new Error(`${path.basename(real)} is not a PNG, JPEG or WebP image.`);
    const size = fs.statSync(real).size;
    if (size > X_IMAGE_MAX)
      throw new Error(`${path.basename(real)} is ${(size / 1048576).toFixed(1)} MB; X allows images up to 5 MB.`);
    return real;
  });
}

const X_ALT_MAX = 1000;
/** Alt text by real image path (real: what checkImages gave for images): the nth alt goes with the nth image. */
function pairImageAlt(images: unknown, alts: unknown, real: string[]): Record<string, string> {
  const raw = Array.isArray(images) ? images : [];
  const altList = Array.isArray(alts) ? alts : [];
  // the same images checkImages kept, in the same order
  const keep = raw.map((p, i) => [p, altList[i]] as const).filter(([p]) => typeof p === 'string' && !!p.trim());
  const out: Record<string, string> = {};
  keep.forEach(([, a], i) => {
    const text = typeof a === 'string' ? a.trim() : '';
    if (!text) return;
    if ([...text].length > X_ALT_MAX) throw new Error(`Alt text can be at most ${X_ALT_MAX} characters on X.`);
    out[real[i]] = text;
  });
  return out;
}

/** The first part that is over X's limit, with its length as X counts it. */
export function xTooLong(parts: string[]): { part: string; length: number } | null {
  for (const part of parts) {
    const length = xLength(part);
    if (length > X_MAX_LENGTH) return { part, length };
  }
  return null;
}

export async function draftPost({
  platform = 'x',
  account,
  text,
  thread = null,
  images = null,
  imageAlt = null,
  imageRoots,
  replyTo = null,
  to = null,
  agentId = null,
  chatId = null,
  agentName = '',
  note = '',
  subreddit = '',
  title = '',
  link = '',
  parent = '',
  flairId = '',
  flairText = '',
  gateway,
}: DraftInput): Promise<OutboxItem & { autoPosted?: boolean }> {
  const team = agentId ? teamOf(agentId, chatId) : null;
  const teamFields = team ? { teamId: team.id, teamName: team.name } : {};
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
      if (!/^t[13]_\w+$/.test(parentId))
        throw new Error('Reply to what? Give the post or comment URL, or its id like t3_abc123.');
      if (!body) throw new Error('The comment is empty.');
    } else {
      if (!/^\w{2,21}$/.test(sr)) throw new Error('Which subreddit? For example LocalLLaMA.');
      if (!String(title).trim()) throw new Error('A Reddit post needs a title.');
      if (!body && !link) throw new Error('Add the post text or a link.');
    }
    const fid = isComment ? '' : String(flairId || '').trim();
    const ftext = isComment ? '' : String(flairText || '').trim();
    if (fid.length > 36)
      throw new Error("A flair id is at most 36 characters (Reddit gives it with the subreddit's flairs).");
    if (ftext.length > 64) throw new Error('Flair text can be at most 64 characters.');
    const label = isComment ? `u/${acc.username} · comment` : `u/${acc.username} → r/${sr}`;
    const item = outbox.save({
      id: uid('p'),
      platform: 'reddit',
      accountId: acc.id,
      accountLabel: label,
      parts: [body || link],
      reddit: {
        kind: isComment ? 'comment' : 'post',
        subreddit: sr,
        title: String(title).trim().slice(0, 300),
        link: link || '',
        parent: parentId,
        ...(fid ? { flairId: fid } : {}),
        ...(ftext ? { flairText: ftext } : {}),
      },
      agentId,
      agentName,
      ...teamFields,
      note,
      status: 'pending',
    });
    log('social', `${agentName || 'You'} drafted a Reddit ${isComment ? 'comment' : 'post'} (${label})`, { agentId });
    if (acc.autopost) return { ...(await approvePost(item.id)), autoPosted: true };
    return item;
  }
  const parts = (thread && thread.length ? thread : [text]).map((t) => String(t || '').trim()).filter(Boolean);
  if (!parts.length) throw new Error('The post is empty.');
  const imagePaths = checkImages(platform, images, imageRoots);
  if (gatewayPost({ platform })) {
    const item: OutboxItem = {
      id: uid('p'),
      platform,
      parts: gatewayTextParts(platform, parts),
      agentId,
      agentName,
      ...teamFields,
      note,
      status: 'pending',
    };
    if (!gateway) return projectGatewayPost(outbox.save(item));
    const checked = checkGatewayDraft(item, gateway, item.parts);
    return projectGatewayPost(
      outbox.save({ ...item, gateway: checked.selected, accountLabel: checked.preview.recipient.instanceName }),
    );
  }
  const alts = imagePaths.length && imageAlt?.length ? pairImageAlt(images, imageAlt, imagePaths) : {};
  let accountId: string | null = null;
  let accountLabel = platform;
  if (platform === 'x_dm') {
    const handle = String(to || '')
      .replace(/^@/, '')
      .trim();
    if (!/^\w{1,15}$/.test(handle)) throw new Error('Who is the DM for? Give their X handle.');
    const body = parts.join('\n\n');
    if (body.length > 10000) throw new Error('DMs can be at most 10,000 characters.');
    const acc = resolveXAccount(account);
    const item = outbox.save({
      id: uid('p'),
      platform,
      accountId: acc.id,
      accountLabel: `@${acc.username} → DM @${handle}`,
      to: handle,
      parts: [body],
      agentId,
      agentName,
      ...teamFields,
      note,
      status: 'pending',
    });
    log('social', `${agentName || 'You'} drafted a DM to @${handle}`, { agentId });
    return item; // DMs always wait for you, even with auto-post on
  }
  if (platform === 'x') {
    const tooLong = xTooLong(parts);
    if (tooLong)
      throw new Error(
        `A post is ${tooLong.length} characters as X counts them (emoji and most non-Latin letters count 2, a link 23); X allows ${X_MAX_LENGTH}. Shorten it or split it into a thread.`,
      );
    const acc = resolveXAccount(account);
    accountId = acc.id;
    accountLabel = `@${acc.username}`;
  }
  const item = outbox.save({
    id: uid('p'),
    platform,
    accountId,
    accountLabel,
    parts,
    ...(imagePaths.length ? { images: imagePaths } : {}),
    ...(Object.keys(alts).length ? { imageAlt: alts } : {}),
    replyTo,
    agentId,
    agentName,
    ...teamFields,
    note,
    status: 'pending',
  });
  log('social', `${agentName || 'You'} drafted a ${platform} post for ${accountLabel}`, { agentId });
  const acc = platform === 'x' ? loadAccounts().x[String(accountId)] : null;
  // a reply always waits for you, even with auto-post on (X allows AI replies only with your OK)
  if (acc?.autopost && !replyTo) {
    const done = await approvePost(item.id);
    return { ...done, autoPosted: true };
  }
  return item;
}

// posts being published or sent back, by project and id: nothing else changes them meanwhile
const publishing = new Set<string>();
const postKey = (id: string, projectId = activeProject().id) => `${projectId}\n${id}`;

/** A post that is being published or sent back can't be changed, sent back, removed or approved again until then. */
function assertNotBusy(item: OutboxItem): void {
  if (publishing.has(postKey(item.id))) throw new Error('This post is being sent right now. Wait until it is done.');
}

/** "Posting" with nothing sending it: the dashboard stopped while it posted. It is a failed post now, saying how far
 *  it got (an X thread goes on after the parts it has a receipt for; others may have gone out without one). */
function settleInterrupted(item: OutboxItem): OutboxItem {
  if (item.status !== 'posting' || publishing.has(postKey(item.id))) return item;
  const done = item.postIds?.length || 0;
  const where =
    item.platform === 'x'
      ? ` ${done} of ${item.parts.length} parts are on X; approving again continues from there.`
      : ` It may have been posted: check ${item.accountLabel || item.platform} before approving again.`;
  return outbox.save(
    Object.assign(item, { status: 'failed', error: `The dashboard stopped while this was posting.${where}` }),
  );
}

/** Parts edited after some of a thread went out: those stay as they were posted, the edit changes only the rest. */
function editedParts(item: OutboxItem, parts: unknown[]): string[] {
  const posted = item.postIds?.length || 0;
  return [
    ...item.parts.slice(0, posted),
    ...parts
      .slice(posted)
      .map((p) => String(p).trim())
      .filter(Boolean),
  ];
}

/** A Reddit link post's text is its link: an edit of it changes the link that is posted. */
function syncRedditLink(item: OutboxItem): void {
  if (item.platform !== 'reddit' || item.reddit?.kind !== 'post' || !item.reddit.link) return;
  const url = item.parts.join('\n').trim();
  if (!/^https?:\/\/\S+$/i.test(url)) throw new Error('A link post is one web address (https://…).');
  item.reddit.link = url;
}

// Publishing takes a while: the post is saved in the project it is in, whichever project is open by then.
export function approvePost(id: string, edits: ApproveEdits | null = null): Promise<OutboxItem> {
  const project = activeProject();
  return withProject(project, () => approveIn(postKey(id, project.id), id, edits));
}

async function approveIn(key: string, id: string, edits: ApproveEdits | null): Promise<OutboxItem> {
  const found = outbox.get(id);
  if (!found) throw new Error('No such post.');
  if (gatewayPost(found)) return approveGatewayPost(found, edits);
  if (publishing.has(key)) throw new Error('This post is already being published.');
  const item = settleInterrupted(found);
  if (item.status === 'posted') return item;
  // (one you rejected or sent back stays that way, whatever an older tab still shows)
  if (item.status !== 'pending' && item.status !== 'failed')
    throw new Error(`This post was ${item.status === 'returned' ? 'sent back' : item.status}, so it isn't posted.`);
  const posted = item.postIds?.length || 0;
  // Parts already on X can't be edited any more.
  const parts = edits?.parts ? editedParts(item, edits.parts) : item.parts;
  if ((item.platform === 'x' || item.platform === 'x_dm') && !parts.some((p) => p.trim()))
    throw new Error('There is nothing to post: write something first.');
  publishing.add(key);
  if (edits?.images && item.images) item.images = item.images.filter((p) => edits.images!.includes(p));
  item.parts = parts;
  try {
    if (edits?.parts) syncRedditLink(item);
  } catch (e) {
    publishing.delete(key);
    throw e;
  }
  item.status = 'posting';
  outbox.save(item);
  try {
    if (item.platform === 'x') {
      const tooLong = xTooLong(item.parts.slice(posted));
      if (tooLong)
        throw new Error(
          `A part is ${tooLong.length} characters as X counts them; X allows ${X_MAX_LENGTH}. Shorten it first.`,
        );
      const r = await xPublish(
        String(item.accountId),
        item.parts,
        item.replyTo,
        item.postIds || [],
        item.images || [],
        (ids) => {
          item.postIds = [...ids];
          outbox.save(item);
        },
        item.imageAlt || {},
      );
      Object.assign(item, { status: 'posted', url: r.url, postIds: r.ids, postedAt: Date.now(), error: null });
    } else if (item.platform === 'x_dm') {
      const r = await xSendDm(String(item.accountId), String(item.to), item.parts.join('\n\n'));
      Object.assign(item, {
        status: 'posted',
        postIds: [r.id],
        postedAt: Date.now(),
        error: null,
        url: 'https://x.com/messages',
      });
    } else if (item.platform === 'reddit') {
      if (edits?.title != null && item.reddit) item.reddit.title = String(edits.title).trim();
      const r = await reddit.publish(item);
      Object.assign(item, { status: 'posted', url: r.url, postIds: [r.id], postedAt: Date.now(), error: null });
    } else throw new Error(`Posting to ${item.platform} isn't supported yet.`);
    log('social', `Posted to ${item.accountLabel}${item.url ? `: ${item.url}` : ''}`, { agentId: item.agentId });
  } catch (e) {
    const part = item.postIds?.length
      ? ` (${item.postIds.length} of ${item.parts.length} parts are already posted; approving again continues from there)`
      : '';
    Object.assign(item, { status: 'failed', error: (e as Error).message + part });
    log('error', `Post to ${item.accountLabel} failed: ${(e as Error).message}`);
  } finally {
    publishing.delete(key);
  }
  return outbox.save(item);
}

/**
 * Send a draft back to the team that wrote it, with your feedback: it goes into their chat as a message to its author,
 * and the draft leaves the Outbox as "sent back" (the author saves a new one once it is revised).
 */
export function returnPost(
  id: string,
  feedback: string,
  send: (teamId: string, text: string) => Promise<unknown>,
): Promise<OutboxItem> {
  return withProject(activeProject(), () => returnIn(id, feedback, send));
}

async function returnIn(
  id: string,
  feedback: string,
  send: (teamId: string, text: string) => Promise<unknown>,
): Promise<OutboxItem> {
  const found = outbox.get(id);
  if (!found) throw new Error('No such post.');
  assertGatewayDraftMutable(found);
  assertNotBusy(found);
  const item = settleInterrupted(found);
  if (item.status !== 'pending' && item.status !== 'failed')
    throw new Error('Only a post that is waiting can be sent back.');
  const note = String(feedback || '').trim();
  if (!note) throw new Error('Say what should change first.');
  // (claimed while the team is told: it can't be approved, changed or sent back twice meanwhile)
  const key = postKey(item.id);
  publishing.add(key);
  try {
    return await sendBack(item, note, send);
  } finally {
    publishing.delete(key);
  }
}

async function sendBack(
  item: OutboxItem,
  note: string,
  send: (teamId: string, text: string) => Promise<unknown>,
): Promise<OutboxItem> {
  const team = item.teamId
    ? { id: item.teamId, name: item.teamName || 'the team' }
    : item.agentId
      ? teamOf(item.agentId)
      : null;
  if (!team) throw new Error("This draft isn't linked to a team, so there is nowhere to send it back to.");
  const quoted = item.parts
    .map((t) =>
      t
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n'),
    )
    .join('\n>\n');
  const images = item.images?.length ? `\nImages with it: ${item.images.map((p) => path.basename(p)).join(', ')}` : '';
  const who = item.agentName ? `@${item.agentName}` : 'Team';
  const text = `${who}: I'm sending your ${item.platform} draft for ${item.accountLabel || item.platform} back for changes (Outbox id ${item.id}). It is out of the Outbox now.\n\nYour draft:\n${quoted}${images}\n\nMy feedback: ${note}\n\nPlease talk it through with me if something is unclear, and save a revised draft when it is ready.`;
  await send(team.id, text);
  Object.assign(item, { status: 'returned', reason: note, teamId: team.id, teamName: team.name });
  log('social', `${item.accountLabel || item.platform} draft sent back to ${team.name}`, { agentId: item.agentId });
  return outbox.save(item);
}

export function rejectPost(id: string, reason = '') {
  const found = outbox.get(id);
  if (!found) throw new Error('No such post.');
  assertGatewayDraftMutable(found);
  assertNotBusy(found);
  const item = settleInterrupted(found);
  if (item.status === 'posted') throw new Error('This post is already posted.');
  Object.assign(item, { status: 'rejected', reason });
  return outbox.save(item);
}

export function listPosts(): OutboxItem[] {
  const cache: GatewayOutboxReadCache = new Map();
  return outbox
    .list()
    .map((item) => projectGatewayPost(gatewayPost(item) ? item : settleInterrupted(item), cache))
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

export function editPost(
  id: string,
  body: {
    parts?: string[];
    images?: string[];
    title?: string;
    gateway?: OutboxPost['gateway'];
    draftRevision?: string;
  },
): OutboxItem {
  const item = outbox.get(id);
  if (!item) throw new Error('No such post.');
  assertGatewayDraftMutable(item);
  if (gatewayPost(item)) {
    prepareGatewayPost(id, {
      gateway: body.gateway ?? item.gateway,
      parts: body.parts ?? item.parts,
      draftRevision: body.draftRevision,
    });
    return projectGatewayPost(outbox.get(id)!);
  }
  assertNotBusy(item);
  if (item.status === 'posted') throw new Error('This post is already posted.');
  // (what is already posted of a thread stays as it was posted)
  if (body.parts) {
    item.parts = editedParts(item, body.parts);
    syncRedditLink(item);
  }
  if (body.images && item.images) item.images = item.images.filter((p) => body.images!.includes(p));
  if (body.title != null && item.reddit) item.reddit.title = String(body.title).trim();
  return outbox.save(item);
}

export function removePost(id: string): void {
  const item = outbox.get(id);
  if (item) {
    assertGatewayDraftMutable(item);
    assertNotBusy(item);
  }
  outbox.remove(id);
}

// These high-risk helpers are called only after the tool's normal approval, with a named recipient.
function sendGateway(
  platform: 'telegram' | 'discord',
  text: string,
  gateway?: OutboxPost['gateway'],
  author: Pick<DraftInput, 'agentId' | 'agentName' | 'chatId'> = {},
  signal?: AbortSignal,
): Promise<string> {
  return withProject(activeProject(), async () => {
    if (!gateway)
      throw new Error(
        'Choose an explicit gateway instance and known conversation. Set up fresh credentials in Settings › Gateways; old global tokens and webhooks are no longer used.',
      );
    signal?.throwIfAborted();
    const item = await draftPost({ platform, text, gateway, ...author });
    signal?.throwIfAborted();
    const preview = prepareGatewayPost(item.id, {
      gateway,
      parts: item.parts,
      draftRevision: gatewayDraftRevision(outbox.get(item.id)!),
    });
    await approvePost(item.id, { gatewayApproval: preview.approval, draftRevision: preview.draftRevision });
    return `Approved and queued on ${platform === 'telegram' ? 'Telegram' : 'Discord'} (Outbox id ${item.id}). Check the Outbox for each part’s delivery result.`;
  });
}
export const sendTelegram = (
  text: string,
  gateway?: OutboxPost['gateway'],
  author?: Pick<DraftInput, 'agentId' | 'agentName' | 'chatId'>,
  signal?: AbortSignal,
) => sendGateway('telegram', text, gateway, author, signal);
export const sendDiscord = (
  text: string,
  gateway?: OutboxPost['gateway'],
  author?: Pick<DraftInput, 'agentId' | 'agentName' | 'chatId'>,
  signal?: AbortSignal,
) => sendGateway('discord', text, gateway, author, signal);
