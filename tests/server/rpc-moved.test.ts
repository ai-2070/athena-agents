// Once an area has moved to oRPC (shared/api/), server/index.ts can't gain a route in it: a new JSON route goes in
// the area's contract. What stays there sends a file or a stream, not JSON.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The addresses of the areas that have moved. */
const MOVED = [
  '/api/brain', '/api/task-board', '/api/projects', '/api/agents', '/api/teams/', '/api/workflows', '/api/workflow-',
  '/api/questions', '/api/approvals', '/api/tasks', '/api/routines', '/api/routine-runs', '/api/runs',
  '/api/skills', '/api/versions', '/api/presets', '/api/library',
  '/api/settings', '/api/secrets', '/api/accounts', '/api/state', '/api/activity', '/api/headbar', '/api/usage-limits',
  '/api/overview', '/api/tools', '/api/tool-stats', '/api/models', '/api/providers', '/api/about',
  '/api/mcp', '/api/hermes/', '/api/pi/', '/api/openclaw/', '/api/codex/', '/api/programs', '/api/comfyui',
];
/** The old routes those areas keep. */
const KEEP = [
  'GET /api/projects/:id/logo',
  'GET /api/projects/:id/background',
  'GET /api/projects/:id/model',
  'GET /api/task-board-file/:projectId/:id',
  'POST /api/agents/:id/chats/:cid/stream',
  'GET /api/agents/:id/chats/:cid/stream',
  'GET /api/workflows/:id/mark',
  'POST /api/brain/stream',
];
const METHOD: Record<string, string> = { get: 'GET', post: 'POST', put: 'PUT', del: 'DELETE', postFile: 'POST' };

describe('areas moved to oRPC', () => {
  it('keep only their file and stream routes in server/index.ts', () => {
    const source = fs.readFileSync(new URL('../../server/index.ts', import.meta.url), 'utf8');
    const routes = [...source.matchAll(/^\s*(get|post|put|del|postFile)(?:<[^\n]*?>)?\('(\/api\/[^']*)'/gm)].map((m) => `${METHOD[m[1]]} ${m[2]}`);
    expect(routes.length).toBeGreaterThan(50);
    const inMoved = routes.filter((r) => MOVED.some((prefix) => r.split(' ')[1].startsWith(prefix)));
    expect(inMoved.sort()).toEqual([...KEEP].sort());
  });
});
