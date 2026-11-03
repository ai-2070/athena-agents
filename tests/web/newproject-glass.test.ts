// The New project dialog is frosted glass: its backdrop carries .glass, which drops the backdrop's own blur so the
// dialog's blur is the one that shows the page behind it. Other dialogs stay solid.
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { modal, state } from '../../web/core.ts';
import { openNewProject } from '../../web/projects.tsx';
import type { AppState } from '../../shared/types.ts';

beforeEach(() => {
  document.body.innerHTML = '<div id="toasts"></div><div id="modal-root"></div>';
  state.data = { agents: [], toolGroups: [], engines: {}, secrets: {}, runs: [], approvals: [], projects: [] } as unknown as AppState;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ root: '/home/me/Athena Agents' }), { status: 200 })),
  );
});
afterEach(() => {
  document.querySelectorAll('.modal-back').forEach((el) => el.remove());
  vi.unstubAllGlobals();
  state.data = null;
});

it('marks the New project dialog as glass, and no other dialog', async () => {
  const other = modal({ title: 'Something else', body: 'plain' });
  expect(other.el.classList.contains('glass')).toBe(false);
  other.close();

  await openNewProject();
  const back = [...document.querySelectorAll<HTMLElement>('.modal-back')].find((el) => el.textContent?.includes('New project'));
  expect(back?.classList.contains('glass')).toBe(true);
  expect(back?.querySelector('.modal')).not.toBeNull();
});
