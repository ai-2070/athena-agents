// "Always allow" for MCP tools: a grant names one tool of one server, and keeps naming it when tools move or
// servers are renamed (BH-043, BH-044).
import { describe, expect, it } from 'vitest';
import * as mcp from '../../server/mcp.ts';
import { newAgent } from '../../server/library.ts';
import { agents } from '../../server/store.ts';
import { gate } from '../../server/tools.ts';
import type { ApprovalDecision } from '../../shared/types.ts';

describe('MCP grants', () => {
  it('renames only the grants of the server renamed, not those of a server whose name starts like it', () => {
    const names = ['a', 'a__b', 'c__b'];
    expect(mcp.renamedGrant('a__b__send', 'a', 'c', 'eve', names)).toBe('a__b__send');
    expect(mcp.renamedGrant('mcp__a__b__send', 'a', 'c', 'claude-code', names)).toBe('mcp__a__b__send');
    expect(mcp.renamedGrant('mcp__a__b__send', 'a', null, 'claude-code', names)).toBe('mcp__a__b__send');
    expect(mcp.renamedGrant('a__read', 'a', 'c', 'eve', names)).toBe('c__read');
    expect(mcp.renamedGrant('mcp__a__read', 'a', 'c', 'claude-code', names)).toBe('mcp__c__read');
    expect(mcp.renamedGrant('mcp__a', 'a', 'c', 'claude-code', names)).toBe('mcp__c');
    expect(mcp.renamedGrant(mcp.mcpGrant('a', 'b__send'), 'a', 'c', 'eve', names)).toBe('mcp:c:b__send');
    expect(mcp.renamedGrant(mcp.mcpGrant('a__b', 'send'), 'a', 'c', 'eve', names)).toBe('mcp:a__b:send');
    expect(mcp.renamedGrant(mcp.mcpGrant('a', 'x'), 'a', null, 'eve', names)).toBe('');
  });

  it('keeps grants of other servers when one is renamed on every agent', () => {
    for (const n of ['a', 'a__b', 'c__b'])
      mcp.saveServer(n, { type: 'http', url: `https://${n.replace(/_/g, 'x')}.example/mcp` });
    const agent = agents.save({
      ...newAgent({ name: 'Mailer', engine: 'eve' }),
      alwaysAllow: [mcp.mcpGrant('a__b', 'send'), 'a__b__send', mcp.mcpGrant('a', 'read')],
    });
    mcp.renameServer('a', 'c');
    expect(agents.get(agent.id)?.alwaysAllow).toEqual([mcp.mcpGrant('a__b', 'send'), 'a__b__send', 'mcp:c:read']);
  });

  it('remembers Always allow by server and tool, not by the name the model sees', async () => {
    const agent = newAgent({ name: 'Sender', engine: 'eve' });
    let asked = 0;
    const yes = async (): Promise<ApprovalDecision> => (asked++, { approved: true, always: true, message: '' });
    const ctx = (tool: string) => ({ mcpServer: 'mail', grantName: mcp.mcpGrant('mail', tool), approvalDecision: yes });
    expect(await gate(agent, 'mail__send_2', 'high', {}, ctx('send_bulk'))).toBeNull();
    expect(agents.get(agent.id)?.alwaysAllow).toEqual(['mcp:mail:send_bulk']);
    // the same model-facing name now points at another tool: it asks again
    expect(await gate(agent, 'mail__send_2', 'high', {}, ctx('delete_all'))).toBeNull();
    expect(asked).toBe(2);
    // and the granted tool, under whatever name, doesn't
    expect(await gate(agent, 'mail__send_3', 'high', {}, ctx('send_bulk'))).toBeNull();
    expect(asked).toBe(2);
  });
});
