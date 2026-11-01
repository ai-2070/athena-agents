import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startEveHost } from '../../server/eve/host.ts';
import { dataPath, ensureDir } from '../../server/util.ts';

describe('the private Eve process', () => {
  it('starts under its own data directory and exits when its owner closes stdin', async () => {
    const fixture = dataPath('eve-host-fixture');
    ensureDir(fixture);
    const entry = path.join(fixture, 'host.cjs');
    fs.writeFileSync(entry, "const http = require('node:http'); process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); http.createServer((req,res) => { res.setHeader('content-type','application/json'); res.end(JSON.stringify({ok:true,status:'ready',workflowId:'fixture'})); }).listen(Number(process.env.PORT), process.env.HOST);");
    const options = { executable: process.execPath, entry, directory: dataPath('runtime', 'eve', 'host-proof'), templates: ensureDir(path.join(fixture, 'templates')), bridgeUrl: 'http://127.0.0.1:1', bridgeToken: 'fixture' };
    const host = await startEveHost(options);
    expect((await fetch(host.url + '/eve/v1/health')).ok).toBe(true);
    expect(host.token.length).toBe(64);
    await expect(startEveHost(options)).rejects.toThrow('already has an owner');
    await host.close();
    await expect(fetch(host.url + '/eve/v1/health')).rejects.toThrow();
    await expect(startEveHost({ ...options, directory: path.dirname(dataPath()) })).rejects.toThrow('data folder');
  });
});
