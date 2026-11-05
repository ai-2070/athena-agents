// Every JSON route is an oRPC contract (shared/api/), so server/index.ts can't gain one: a new JSON route goes in its
// area's contract. What stays there sends or takes a file or a stream, or is the MCP bridge's internal route.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';

/** The routes server/index.ts keeps, and why. */
const KEEP = [
  // files: a project's pictures and model, a task's file, a team's picture, any file the page may show
  'GET /api/projects/:id/logo',
  'GET /api/projects/:id/background',
  'GET /api/projects/:id/model',
  'GET /api/task-board-file/:projectId/:id',
  'GET /api/workflows/:id/mark',
  'GET /api/file',
  // a backup file as the body
  'POST /api/backups/restore',
  // streams for the AI SDK: an agent's run, the Brain's answer
  'POST /api/agents/:id/chats/:cid/stream',
  'GET /api/agents/:id/chats/:cid/stream',
  'POST /api/brain/stream',
  // the MCP bridge (its own token, x-dash-internal)
  'GET /api/internal/tools',
  'POST /api/internal/tools/call',
];
const METHOD: Record<string, string> = { get: 'GET', post: 'POST', put: 'PUT', del: 'DELETE', postFile: 'POST' };

describe('the routes left in server/index.ts', () => {
  it('are only the file, stream and internal ones', () => {
    const source = fs.readFileSync(new URL('../../server/index.ts', import.meta.url), 'utf8');
    const routes = [...source.matchAll(/^\s*(get|post|put|del|postFile)(?:<[^\n]*?>)?\('(\/[^']*)'/gm)].map((m) => `${METHOD[m[1]]} ${m[2]}`);
    expect(routes.sort()).toEqual([...KEEP].sort());
  });
});
