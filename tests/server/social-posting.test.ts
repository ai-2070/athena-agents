// Posting to X and Reddit, with X and Reddit faked: auto-post never sends a reply on its own, X's weighted
// length limit, alt text on images, Reddit flair, and reading a subreddit's rules.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dataPath, readJSON, writeJSON } from '../../server/util.ts';
import * as social from '../../server/social.ts';
import * as reddit from '../../server/reddit.ts';
import { allTools, toolDefs } from '../../server/tools.ts';
import { buildSystemPrompt } from '../../server/engines/index.ts';
import { newAgent } from '../../server/library.ts';
import type { AccountsFile } from '../../server/social.ts';

interface Call {
  method: string;
  url: string;
  body: unknown;
}
let calls: Call[];
const later = Date.now() + 86_400_000;
const stored = () => readJSON<AccountsFile>(dataPath('accounts.json'))!;

function accounts({ xAuto = false, redditAuto = false, withReddit = true } = {}) {
  const a: AccountsFile = {
    x: {
      x1: {
        id: 'x1',
        username: 'ada',
        name: 'Ada',
        autopost: xAuto,
        accessToken: 'xt',
        expiresAt: later,
        connectedAt: 1,
      },
    },
    ...(withReddit
      ? {
          reddit: {
            r1: {
              id: 'r1',
              username: 'ada_r',
              autopost: redditAuto,
              accessToken: 'rt',
              refreshToken: 'rr',
              expiresAt: later,
              connectedAt: 1,
            },
          },
        }
      : {}),
  };
  writeJSON(dataPath('accounts.json'), a);
}

const json = (v: unknown) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const method = init.method || 'GET';
    const raw = init.body;
    const body =
      raw instanceof URLSearchParams
        ? Object.fromEntries(raw)
        : typeof raw === 'string'
          ? JSON.parse(raw)
          : raw instanceof FormData
            ? 'form'
            : null;
    calls.push({ method, url, body });
    if (url === 'https://api.x.com/2/media/upload')
      return json({ data: { id: String(100 + calls.filter((c) => c.url.endsWith('/media/upload')).length) } });
    if (url === 'https://api.x.com/2/media/metadata') return json({ data: { id: (body as { id: string }).id } });
    if (url === 'https://api.x.com/2/tweets') return json({ data: { id: '900' } });
    if (url === 'https://oauth.reddit.com/api/submit')
      return json({
        json: { errors: [], data: { name: 't3_new', url: 'https://www.reddit.com/r/test/comments/new/' } },
      });
    if (url.endsWith('/r/test/about/rules') || url.endsWith('/r/test/about/rules.json'))
      return json({
        rules: [
          { kind: 'link', short_name: 'No spam', description: 'Self-promotion once a week at most.' },
          { kind: 'all', short_name: 'Be kind', description: '' },
        ],
      });
    if (url.endsWith('/r/test/about') || url.endsWith('/r/test/about.json'))
      return json({
        kind: 't5',
        data: {
          display_name: 'test',
          title: 'Testing',
          public_description: 'A place to test.',
          description: '## Sidebar\nFlair every post.',
          submit_text: 'Use a flair.',
          subscribers: 42,
          over18: false,
          submission_type: 'self',
        },
      });
    return new Response('not faked', { status: 404 });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('X posts with auto-post on', () => {
  it('publishes a post at once but keeps a reply waiting for you', async () => {
    accounts({ xAuto: true });
    const post = await social.draftPost({ platform: 'x', text: 'Hello', agentName: 'Writer' });
    expect(post.status).toBe('posted');
    expect(calls.filter((c) => c.url.endsWith('/tweets'))).toHaveLength(1);

    calls = [];
    const reply = await social.draftPost({ platform: 'x', text: 'Thanks!', replyTo: '123', agentName: 'Writer' });
    expect(reply.status).toBe('pending');
    expect(reply.autoPosted).toBeUndefined();
    expect(calls).toHaveLength(0);

    // once you approve it, it goes out as a reply
    const sent = await social.approvePost(reply.id);
    expect(sent.status).toBe('posted');
    expect(calls.find((c) => c.url.endsWith('/tweets'))!.body).toEqual({
      text: 'Thanks!',
      reply: { in_reply_to_tweet_id: '123' },
    });
  });

  it('keeps everything waiting when auto-post is off', async () => {
    accounts();
    expect((await social.draftPost({ platform: 'x', text: 'Hello' })).status).toBe('pending');
    expect(calls).toHaveLength(0);
  });
});

describe("X's length limit", () => {
  it('counts as X does, not by code points', async () => {
    accounts();
    // 141 Chinese letters are 141 code points but 282 to X
    await expect(social.draftPost({ platform: 'x', text: '中'.repeat(141) })).rejects.toThrow(
      /282 characters as X counts them/,
    );
    // a long link is 23
    const ok = await social.draftPost({
      platform: 'x',
      text: `${'a'.repeat(250)} https://example.com/${'p'.repeat(100)}`,
    });
    expect(ok.status).toBe('pending');
  });

  it('checks again when you approve an edited post', async () => {
    accounts();
    const p = await social.draftPost({ platform: 'x', text: 'Short' });
    const r = await social.approvePost(p.id, { parts: ['👋'.repeat(141)] });
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/282 characters/);
    expect(calls).toHaveLength(0);
  });
});

describe('alt text on X images', () => {
  // .native, like the server: it expands Windows short names (RUNNER~1)
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.homedir(), 'alt-')));
  const img = (name: string) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.alloc(10));
    return p;
  };

  it('is stored with the draft and added to each uploaded image before the post', async () => {
    accounts();
    const a = img('a.png');
    const b = img('b.png');
    const p = await social.draftPost({
      platform: 'x',
      text: 'Look',
      images: [a, b],
      imageAlt: ['A red cube on a table', ''],
      imageRoots: [dir],
    });
    expect(p.imageAlt).toEqual({ [a]: 'A red cube on a table' });
    const r = await social.approvePost(p.id);
    expect(r.status).toBe('posted');
    const meta = calls.filter((c) => c.url.endsWith('/media/metadata'));
    expect(meta).toHaveLength(1);
    expect(meta[0].body).toEqual({
      id: expect.stringMatching(/^\d+$/),
      metadata: { alt_text: { text: 'A red cube on a table' } },
    });
    // metadata comes before the post that uses the image
    expect(calls.findIndex((c) => c.url.endsWith('/media/metadata'))).toBeLessThan(
      calls.findIndex((c) => c.url.endsWith('/tweets')),
    );
    expect(
      (calls.find((c) => c.url.endsWith('/tweets'))!.body as { media: { media_ids: string[] } }).media.media_ids,
    ).toHaveLength(2);
  });

  it('refuses alt text over 1,000 characters', async () => {
    accounts();
    await expect(
      social.draftPost({
        platform: 'x',
        text: 'Look',
        images: [img('c.png')],
        imageAlt: ['x'.repeat(1001)],
        imageRoots: [dir],
      }),
    ).rejects.toThrow(/at most 1000/);
  });
});

describe('Reddit flair', () => {
  it('is stored with the draft and sent when it is posted', async () => {
    accounts();
    const p = await social.draftPost({
      platform: 'reddit',
      subreddit: 'test',
      title: 'Hi',
      text: 'Body',
      flairId: 'abc-123',
      flairText: 'Discussion',
      note: 'For the launch',
    });
    expect(p.reddit).toMatchObject({ flairId: 'abc-123', flairText: 'Discussion' });
    expect(p.note).toBe('For the launch');
    const r = await social.approvePost(p.id);
    expect(r.status).toBe('posted');
    expect(calls.find((c) => c.url.endsWith('/api/submit'))!.body).toMatchObject({
      sr: 'test',
      kind: 'self',
      flair_id: 'abc-123',
      flair_text: 'Discussion',
    });
  });

  it('sends no flair fields when there is none', async () => {
    accounts();
    const p = await social.draftPost({ platform: 'reddit', subreddit: 'test', title: 'Hi', text: 'Body' });
    await social.approvePost(p.id);
    const body = calls.find((c) => c.url.endsWith('/api/submit'))!.body as Record<string, string>;
    expect(body).not.toHaveProperty('flair_id');
    expect(body).not.toHaveProperty('flair_text');
  });

  it('refuses flair longer than Reddit allows', async () => {
    accounts();
    await expect(
      social.draftPost({ platform: 'reddit', subreddit: 'test', title: 'Hi', text: 'B', flairText: 'x'.repeat(65) }),
    ).rejects.toThrow(/64/);
    await expect(
      social.draftPost({ platform: 'reddit', subreddit: 'test', title: 'Hi', text: 'B', flairId: 'x'.repeat(37) }),
    ).rejects.toThrow(/36/);
  });
});

describe("a subreddit's rules", () => {
  it('come from /about/rules and /about, signed in', async () => {
    accounts();
    const r = await reddit.subredditRules('r/test');
    expect(calls.map((c) => c.url).sort()).toEqual([
      'https://oauth.reddit.com/r/test/about',
      'https://oauth.reddit.com/r/test/about/rules',
    ]);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(r).toMatchObject({
      subreddit: 'test',
      subscribers: 42,
      allows: 'self',
      summary: 'A place to test.',
      submitText: 'Use a flair.',
      sidebar: '## Sidebar\nFlair every post.',
    });
    expect(r.rules).toEqual([
      { name: 'No spam', text: 'Self-promotion once a week at most.', appliesTo: 'posts' },
      { name: 'Be kind', text: '', appliesTo: 'posts and comments' },
    ]);
  });

  it("work through Reddit's public JSON without an account", async () => {
    accounts({ withReddit: false });
    const r = await reddit.subredditRules('test');
    expect(calls.map((c) => c.url).sort()).toEqual([
      'https://www.reddit.com/r/test/about.json',
      'https://www.reddit.com/r/test/about/rules.json',
    ]);
    expect(r.rules).toHaveLength(2);
  });

  it('need a real subreddit name', async () => {
    await expect(reddit.subredditRules('no spaces here')).rejects.toThrow(/Which subreddit/);
  });
});

describe('the social tools', () => {
  const poster = { id: 'p', name: 'Poster', toolGroups: ['social'] };
  const def = (name: string) => toolDefs(poster).find((t) => t.name === name)!;
  const props = (name: string) => Object.keys(def(name).parameters.properties || {});

  it('declare note and flair on reddit_draft_post, and alt text on x_draft_post', () => {
    expect(props('reddit_draft_post')).toEqual(expect.arrayContaining(['note', 'flair_id', 'flair_text']));
    expect(props('x_draft_post')).toContain('image_alt');
    expect(def('x_draft_post').description).toMatch(/reply .*always waits/i);
    expect(def('x_draft_post').description).toMatch(/mentioned or quoted/);
    expect(def('x_draft_post').description).toMatch(/quote posts aren't possible/);
  });

  it('include a read-only reddit_rules among the social tools', () => {
    expect(allTools().find((t) => t.name === 'reddit_rules')).toMatchObject({ group: 'social', risk: 'none' });
  });

  it('tell an agent with the X tools that auto-post skips the Outbox, but replies and DMs never do', () => {
    const prompt = buildSystemPrompt(newAgent({ name: 'Social', toolGroups: ['social'] }));
    expect(prompt).toContain('unless that account has auto-post on');
    expect(prompt).toContain('replies and DMs always wait');
  });
});

describe('the Outbox, one decision at a time', () => {
  const tweets = () => calls.filter((c) => c.url.endsWith('/tweets'));

  it('never posts a draft you rejected, whatever an older tab still shows', async () => {
    accounts();
    const p = await social.draftPost({ platform: 'x', text: 'Not this one' });
    social.rejectPost(p.id, 'no');
    await expect(social.approvePost(p.id)).rejects.toThrow(/rejected/);
    expect(tweets()).toHaveLength(0);
  });

  it('refuses to approve a post with nothing left in it', async () => {
    accounts();
    const p = await social.draftPost({ platform: 'x', text: 'Something' });
    await expect(social.approvePost(p.id, { parts: ['  ', ''] })).rejects.toThrow(/nothing to post/);
    expect(tweets()).toHaveLength(0);
    expect(social.listPosts().find((x) => x.id === p.id)?.status).toBe('pending');
  });

  it('posts the link you edited on a Reddit link post', async () => {
    accounts();
    const p = await social.draftPost({
      platform: 'reddit',
      subreddit: 'test',
      title: 'Look',
      link: 'https://old.example/a',
    });
    const r = await social.approvePost(p.id, { parts: ['https://new.example/b'] });
    expect(r.status).toBe('posted');
    expect(calls.find((c) => c.url.endsWith('/api/submit'))!.body).toMatchObject({
      kind: 'link',
      url: 'https://new.example/b',
    });
    const q = await social.draftPost({
      platform: 'reddit',
      subreddit: 'test',
      title: 'Look',
      link: 'https://old.example/a',
    });
    expect(() => social.editPost(q.id, { parts: ['not a link'] })).toThrow(/web address/);
  });

  it("can't be changed, rejected or removed while it is being posted", async () => {
    accounts();
    const p = await social.draftPost({ platform: 'x', text: 'Slow one' });
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === 'https://api.x.com/2/tweets') await gate;
      return real(url, init);
    });
    const posting = social.approvePost(p.id);
    await vi.waitFor(() => expect(social.listPosts().find((x) => x.id === p.id)?.status).toBe('posting'));
    expect(() => social.editPost(p.id, { parts: ['Changed'] })).toThrow(/being sent/);
    expect(() => social.rejectPost(p.id)).toThrow(/being sent/);
    expect(() => social.removePost(p.id)).toThrow(/being sent/);
    release();
    expect((await posting).status).toBe('posted');
    expect(social.listPosts().find((x) => x.id === p.id)?.parts).toEqual(['Slow one']);
  });

  it('a draft being sent back to its team is not posted meanwhile, nor sent back twice', async () => {
    accounts();
    const p = await social.draftPost({
      platform: 'x',
      text: 'Rework me',
      agentName: 'Writer',
    });
    const { outbox } = await import('../../server/store.ts');
    outbox.save({ ...outbox.get(p.id)!, teamId: 't1', teamName: 'Crew' });
    let release = () => {};
    const told: string[] = [];
    const send = (_team: string, text: string) => (told.push(text), new Promise<void>((r) => (release = r)));
    const returning = social.returnPost(p.id, 'Shorter please', send);
    await vi.waitFor(() => expect(told).toHaveLength(1));
    await expect(social.approvePost(p.id)).rejects.toThrow(/already being published|being sent/);
    await expect(social.returnPost(p.id, 'Again', send)).rejects.toThrow(/being sent/);
    release();
    expect((await returning).status).toBe('returned');
    expect(told).toHaveLength(1);
    expect(tweets()).toHaveLength(0);
  });

  it('keeps the posted part of a thread as it was posted when the rest is edited', async () => {
    accounts();
    const p = await social.draftPost({ platform: 'x', text: 'A' });
    const { outbox } = await import('../../server/store.ts');
    outbox.save({ ...outbox.get(p.id)!, parts: ['A', 'B', 'C'], postIds: ['1'], status: 'failed' });
    const edited = social.editPost(p.id, { parts: ['A changed', 'B2'] });
    expect(edited.parts).toEqual(['A', 'B2']);
  });

  it('a post left "posting" when the dashboard stopped is shown as failed, saying how far it got', async () => {
    accounts();
    const p = await social.draftPost({ platform: 'x', text: 'A' });
    const { outbox } = await import('../../server/store.ts');
    outbox.save({ ...outbox.get(p.id)!, parts: ['A', 'B'], postIds: ['1'], status: 'posting' });
    const shown = social.listPosts().find((x) => x.id === p.id)!;
    expect(shown.status).toBe('failed');
    expect(shown.error).toMatch(/1 of 2 parts are on X/);
    // approving again goes on after the part that is posted
    expect((await social.approvePost(p.id)).status).toBe('posted');
    expect(tweets()).toHaveLength(1);
  });
});

describe('refreshing a sign-in', () => {
  const expire = (platform: 'x' | 'reddit', id: string) => {
    const a = stored();
    const acc = (a[platform] as Record<string, { expiresAt: number }>)[id]!;
    acc.expiresAt = Date.now() - 1000;
    writeJSON(dataPath('accounts.json'), a);
  };

  it("refuses Reddit's error answer instead of saving no token", async () => {
    accounts();
    expire('reddit', 'r1');
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) =>
      url === 'https://www.reddit.com/api/v1/access_token' ? json({ error: 'invalid_grant' }) : real(url, init),
    );
    const p = await social.draftPost({ platform: 'reddit', subreddit: 'test', title: 'Hi', text: 'Body' });
    const r = await social.approvePost(p.id);
    expect(r.status).toBe('failed');
    expect(r.error).toMatch(/invalid_grant/);
    expect(stored().reddit!.r1!.accessToken).toBe('rt');
  });

  it('keeps a new X sign-in made while an older refresh was still going', async () => {
    accounts();
    const a = stored();
    a.x!.x1!.refreshToken = 'old-refresh';
    a.x!.x1!.expiresAt = Date.now() - 1000;
    writeJSON(dataPath('accounts.json'), a);
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (url === 'https://api.x.com/2/oauth2/token') {
        await gate;
        return json({ access_token: 'from-old-refresh', refresh_token: 'old-next', expires_in: 7200 });
      }
      return real(url, init);
    });
    const p = await social.draftPost({ platform: 'x', text: 'Hello' });
    const posting = social.approvePost(p.id);
    await new Promise((r) => setTimeout(r, 20));
    // you sign in again meanwhile
    const now = stored();
    Object.assign(now.x!.x1!, { accessToken: 'new-sign-in', refreshToken: 'new-refresh', expiresAt: later });
    writeJSON(dataPath('accounts.json'), now);
    release();
    await posting;
    expect(stored().x!.x1).toMatchObject({ accessToken: 'new-sign-in', refreshToken: 'new-refresh' });
  });
});
