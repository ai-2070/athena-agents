// Settings, keys and accounts (server/api/settings.ts): the settings and a change to them, the API keys (only
// whether each is set ever comes back), testing a key, and the X and Reddit accounts.
import { oc, type } from '@orpc/contract';
import { z } from 'zod';
import { AUTONOMY, EFFORT, ENGINES } from './agents.ts';
import type {
  Accounts,
  OpenRouterKeyInfo,
  SecretKey,
  SecretStatus,
  Settings,
  VeniceAccountInfo,
  XPost,
} from '../types.ts';

const text = (field: string) => z.string({ error: `${field} must be text.` });
const list = (field: string) => z.array(z.string(), { error: `${field} must be a list.` });
const count = (field: string) => z.number({ error: `${field} must be a number.` });
const yesNo = (field: string) => z.boolean({ error: `${field} must be on or off.` });
const engine = z.enum(ENGINES, {
  error: 'Choose an engine: claude-code, eve, hermes, codex, pi, omp, openclaw or opencode.',
});

/** A change to the settings: every field and every part of one can be left out (the rest stays as saved). */
const settingsPatch = z
  .object({
    defaults: z
      .object({
        engine,
        claudeModel: text('defaults.claudeModel'),
        openrouterModel: text('defaults.openrouterModel'),
        veniceModel: text('defaults.veniceModel'),
        hermesProfile: text('defaults.hermesProfile'),
        autonomy: z.enum(AUTONOMY, { error: 'Choose how freely agents work: ask, auto or full.' }),
      })
      .partial(),
    providers: z
      .object({
        lmstudio: z.object({ baseUrl: text('The LM Studio address') }).partial(),
        ollama: z.object({ baseUrl: text('The Ollama address') }).partial(),
        custom: z.object({ baseUrl: text('The server address'), label: text('Its name') }).partial(),
      })
      .partial(),
    comfyui: z.object({ url: text('The ComfyUI address'), workflowDirs: list('The workflow folders') }).partial(),
    /** where a program is, when it can't be found (programs.ts reads paths[program]) */
    paths: z.record(z.string(), text("A program's place")),
    allowedFolders: list('The folders agents may use'),
    x: z.object({ clientId: text('The X client ID') }).partial(),
    reddit: z.object({ clientId: text('The Reddit client ID'), username: text('The Reddit username') }).partial(),
    brain: z
      .object({
        provider: z.enum(['claude', 'openrouter', 'venice', 'hermes', 'codex', 'opencode'], {
          error: 'The Brain thinks with claude, openrouter, venice, hermes, codex or opencode.',
        }),
        model: text("The Brain's model"),
        effort: z.enum(EFFORT).catch(''),
      })
      .partial(),
    brainApproves: yesNo('brainApproves'),
    brainSkills: list('brainSkills'),
    brainAnyGitHub: yesNo('brainAnyGitHub'),
    brainFollowsUp: yesNo('brainFollowsUp'),
    look: z
      .object({
        theme: z.enum(['system', 'light', 'dark'], { error: 'The colour scheme is system, light or dark.' }),
        scale: count('The page size'),
        accent: text('The accent'),
        motion: z.enum(['full', 'reduced'], { error: 'Motion is full or reduced.' }),
        chatFont: text('The chat font'),
        station: z.enum(['smooth', 'balanced', 'saver'], { error: 'The map works smooth, balanced or saver.' }),
        sidebar: z.enum(['status', 'limits'], { error: 'The sidebar shows "status" or "limits".' }),
        stationLook: z.enum(['classic', 'world'], { error: 'The Station looks classic or world.' }),
        worldQuality: z.enum(['low', 'medium', 'high'], { error: 'The world draws low, medium or high.' }),
      })
      .partial(),
    telegram: z.object({ chatId: text('The Telegram chat') }).partial(),
    maxToolSteps: count('maxToolSteps'),
    costLimitUsdPerRun: count('costLimitUsdPerRun'),
    contextWindowTokens: count('contextWindowTokens'),
    toolResultChars: count('toolResultChars'),
    favoriteModels: z.array(z.object({ engine, model: z.string(), provider: z.string().optional() }), {
      error: 'favoriteModels must be a list of models.',
    }),
  })
  .partial();
/** A change to the settings, as the page sends it. */
export type SettingsChange = z.input<typeof settingsPatch>;

// (a Record, so a new key can't be left out)
const KEYS = {
  openrouterKey: 'openrouterKey',
  veniceKey: 'veniceKey',
  anthropicKey: 'anthropicKey',
  customKey: 'customKey',
  xClientSecret: 'xClientSecret',
  telegramBotToken: 'telegramBotToken',
  discordWebhook: 'discordWebhook',
  redditClientSecret: 'redditClientSecret',
} as const satisfies Record<SecretKey, SecretKey>;
const autopost = z.object({
  id: z.string(),
  autopost: z.boolean({ error: 'autopost must be true or false.' }).optional(),
});

export const settings = {
  get: oc.route({ method: 'GET', path: '/settings' }).output(type<{ settings: Settings; secrets: SecretStatus }>()),
  save: oc.route({ method: 'PUT', path: '/settings' }).input(settingsPatch).output(type<Settings>()),
  /** Saves an API key (empty: removes it). Only whether each key is set comes back. */
  setKey: oc
    .route({ method: 'POST', path: '/secrets' })
    .input(
      z.object({
        key: z.enum(KEYS, { error: 'Unknown key' }),
        value: z.string({ error: 'A key is text.' }).optional(),
      }),
    )
    .output(type<SecretStatus>()),
  /** Asks OpenRouter or Venice whether the saved key works, and what it has left. */
  testOpenrouter: oc.route({ method: 'POST', path: '/settings/test-openrouter' }).output(type<OpenRouterKeyInfo>()),
  testVenice: oc.route({ method: 'POST', path: '/settings/test-venice' }).output(type<VeniceAccountInfo>()),
};

export const accounts = {
  list: oc.route({ method: 'GET', path: '/accounts' }).output(type<Accounts>()),
  /** autopost: its agents' posts go out without the Outbox. */
  setX: oc.route({ method: 'POST', path: '/accounts/x/{id}' }).input(autopost).output(type<Accounts>()),
  removeX: oc
    .route({ method: 'DELETE', path: '/accounts/x/{id}' })
    .input(z.object({ id: z.string() }))
    .output(type<Accounts>()),
  xPosts: oc
    .route({ method: 'GET', path: '/accounts/x/{id}/posts' })
    .input(z.object({ id: z.string() }))
    .output(type<XPost[]>()),
  setReddit: oc.route({ method: 'POST', path: '/accounts/reddit/{id}' }).input(autopost).output(type<Accounts>()),
  removeReddit: oc
    .route({ method: 'DELETE', path: '/accounts/reddit/{id}' })
    .input(z.object({ id: z.string() }))
    .output(type<Accounts>()),
};
