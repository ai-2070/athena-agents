// Settings, keys and accounts (shared/api/settings.ts). A key itself never goes back to the page.
import { implement } from '@orpc/server';
import { accounts as accountsContract, settings as settingsContract } from '../../shared/api/settings.ts';
import * as store from '../store.ts';
import * as social from '../social.ts';
import * as reddit from '../reddit.ts';
import { readVeniceAccount } from '../venice.ts';
import { refuse } from './refuse.ts';
import type { OpenRouterKeyInfo } from '../../shared/types.ts';

const s = implement(settingsContract);
const a = implement(accountsContract);

export const settingsRouter = s.router({
  get: s.get.handler(() => ({ settings: store.getSettings(), secrets: store.secretStatus() })),
  save: s.save.handler(({ input }) => store.saveSettings(input)),
  setKey: s.setKey.handler(({ input }) => {
    store.setSecret(input.key, (input.value || '').trim());
    return store.secretStatus();
  }),
  testOpenrouter: s.testOpenrouter.handler(async (): Promise<OpenRouterKeyInfo> => {
    const key = store.getSecrets().openrouterKey;
    if (!key) return refuse('No OpenRouter key saved.');
    const r = await fetch('https://openrouter.ai/api/v1/key', { headers: { authorization: `Bearer ${key}` } });
    const j = (await r.json().catch(() => ({}))) as { error?: { message?: string }; data?: OpenRouterKeyInfo } & OpenRouterKeyInfo;
    if (!r.ok) return refuse(j.error?.message || `OpenRouter said ${r.status}`);
    return j.data || j;
  }),
  testVenice: s.testVenice.handler(async () => {
    if (!store.getSecrets().veniceKey) return refuse('No Venice key saved.');
    // Not refusing(): a Venice error carries Venice's own status (a 401 there is the key, not this request).
    try {
      return await readVeniceAccount(true);
    } catch (error) {
      return refuse(error instanceof Error ? error.message : 'Could not test the Venice key.');
    }
  }),
});

export const accountsRouter = a.router({
  list: a.list.handler(() => social.listAccounts()),
  setX: a.setX.handler(({ input }) => {
    if (input.autopost !== undefined) social.setAutopost(input.id, input.autopost);
    return social.listAccounts();
  }),
  removeX: a.removeX.handler(({ input }) => (social.disconnectX(input.id), social.listAccounts())),
  xPosts: a.xPosts.handler(({ input }) => social.xRecentPosts(input.id, 10)),
  setReddit: a.setReddit.handler(({ input }) => {
    if (input.autopost !== undefined) reddit.setRedditAutopost(input.id, input.autopost);
    return social.listAccounts();
  }),
  removeReddit: a.removeReddit.handler(({ input }) => (reddit.disconnectReddit(input.id), social.listAccounts())),
});
