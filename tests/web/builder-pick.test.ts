// The team builder's "Add an agent" list: search, click to add, and it leaves the list once on the team.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { state } from '../../web/core.ts';
import { openBranchBuilder } from '../../web/builder.ts';
import type { AppState } from '../../shared/types.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '<div id="toasts"></div><div id="modal-root"></div>';
  state.data = {
    agents: [
      { id: 'a1', name: 'Scout', emoji: '🔭', specialty: 'Finds things' },
      { id: 'a2', name: 'Writer', emoji: '✍️', specialty: 'Posts' },
    ],
    toolGroups: [],
    engines: {},
    secrets: {},
    runs: [],
    approvals: [],
  } as unknown as AppState;
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ servers: {} })));
});
afterEach(() => vi.unstubAllGlobals());

const rows = () => [...document.querySelectorAll<HTMLButtonElement>('.modal button[title^="Add "]')];

describe('the team builder', () => {
  it('lists your agents with their badges, filters them, and adds one on a click', async () => {
    await openBranchBuilder();
    await tick();
    expect(rows().map((b) => b.querySelector('b, .truncate')!.textContent)).toEqual(['Scout', 'Writer']);
    expect(rows()[0].querySelector('.avatar')).not.toBeNull();
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search your agents"]')!;
    search.value = 'wri';
    search.dispatchEvent(new Event('input'));
    expect(rows()).toHaveLength(1);
    rows()[0].click();
    // on the team now: shown as a member, gone from the list, counted
    expect(document.querySelector('.modal')!.textContent).toContain('Writer');
    search.value = '';
    search.dispatchEvent(new Event('input'));
    expect(rows().map((b) => b.title)).toEqual(['Add Scout to the team']);
  });

  it('is mono like the other editors, and shows a box for each part', async () => {
    const m = await openBranchBuilder();
    expect(m.el.classList.contains('mono-fields')).toBe(true);
    expect([...m.el.querySelectorAll('section')].map((s) => s.firstElementChild!.textContent?.trim())).toEqual(['Basics', 'Files', 'Members0', 'Access']);
  });
});
