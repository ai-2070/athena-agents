import { describe, expect, it } from 'vitest';
import type { AppState } from '../../shared/types.ts';
import { engineConfigured } from '../../web/engineavailability.ts';

const data = (value: unknown) => value as AppState;
describe('engine setup visibility', () => {
  it('requires a saved key for API services', () => {
    const configured = data({ secrets: { openrouterKey: { set: true }, veniceKey: { set: false } } });
    expect(engineConfigured('openai', configured)).toBe(true);
    expect(engineConfigured('openrouter', configured)).toBe(true);
    expect(engineConfigured('venice', configured)).toBe(false);
    expect(engineConfigured('venice', data({ secrets: { veniceKey: { set: true } } }))).toBe(true);
  });
  it('checks installation and known CLI sign-in status', () => {
    const configured = data({ engines: { 'claude-code': { installed: true, loggedIn: false }, codex: { installed: true, loggedIn: false }, hermes: { installed: true }, pi: { installed: false } }, secrets: {} });
    expect(engineConfigured('claude', configured)).toBe(false);
    expect(engineConfigured('codex', configured)).toBe(false);
    expect(engineConfigured('hermes', configured)).toBe(true);
    expect(engineConfigured('pi', configured)).toBe(false);
    expect(engineConfigured('claude', data({ ...configured, secrets: { anthropicKey: { set: true } } }))).toBe(true);
  });
  it('requires local installation rather than a saved agent choice', () => {
    const configured = data({ agents: [{ engine: 'openai', provider: 'lmstudio' }] });
    expect(engineConfigured('lmstudio', configured)).toBe(false);
    expect(engineConfigured('lmstudio', configured, new Set(['lmstudio']))).toBe(true);
    expect(engineConfigured('codex', null)).toBe(false);
  });
});
