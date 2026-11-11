// The hosted Worker runs in a local workerd process. No real Meta account or Cloudflare deployment.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { GatewayWhatsAppRelayStatus } from '../shared/types.ts';

const suppliedRoot = process.env.ATHENA_WHATSAPP_RELAY_PROOF_ROOT;
if (!suppliedRoot) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'athena-whatsapp-relay-'));
  const home = path.join(root, 'home');
  const data = path.join(root, 'data');
  const application = path.join(root, 'app');
  for (const directory of [home, data, application]) fs.mkdirSync(directory);
  const bundle = path.join(application, 'worker.mjs');
  const clientBundle = path.join(application, 'client.mjs');
  const env = {
    ...process.env,
    ATHENA_WHATSAPP_RELAY_PROOF_ROOT: root,
    HOME: home,
    USERPROFILE: home,
    DASH_DATA: data,
  };
  try {
    const build = spawnSync(
      'bun',
      [path.resolve(import.meta.dirname, 'build-whatsapp-relay.ts'), '--outfile', bundle],
      { env, stdio: 'pipe', timeout: 20000 },
    );
    assert.equal(build.status, 0, 'WhatsApp relay build failed');
    const entry = path.join(root, 'client-entry.ts');
    fs.writeFileSync(
      entry,
      [
        'server/gateways/whatsapp-relay.ts',
        'server/gateways/inbox.ts',
        'server/gateways/state.ts',
        'server/gateways/instances.ts',
        'server/store.ts',
      ]
        .map((module) => `export * from ${JSON.stringify(path.resolve(import.meta.dirname, '..', module))};`)
        .join('\n'),
    );
    const clientBuild = spawnSync('bun', ['build', entry, '--target=node', '--outfile', clientBundle], {
      env,
      stdio: 'pipe',
      timeout: 20000,
    });
    assert.equal(clientBuild.status, 0, 'WhatsApp local intake build failed');
    fs.chmodSync(bundle, 0o444);
    fs.chmodSync(clientBundle, 0o444);
    fs.chmodSync(application, 0o555);
    // Miniflare's host uses Node; the Worker itself is runtime-independent and fully bundled.
    const runtime = process.versions.bun ? 'node' : process.execPath;
    for (const mode of ['write', 'intake', 'read']) {
      const child = spawnSync(runtime, [fileURLToPath(import.meta.url), mode], {
        cwd: application,
        env,
        stdio: 'inherit',
        timeout: 20000,
      });
      assert.equal(child.status, 0, `WhatsApp relay ${mode} process failed`);
    }
    console.log(
      'gateways: WhatsApp relay signed intake, process restart, commit-before-ack, replay, lease and revocation pass',
    );
    console.log('gateways: WhatsApp bundled local intake holds work across a lost ACK reply and process restart');
    console.log('gateways: WhatsApp verified identity mappings survive restart and signed rotations hold old work');
    console.log('gateways: WhatsApp authenticated consumer restores its pinned relay and exact ACK across processes');
  } finally {
    fs.chmodSync(application, 0o755);
    for (const file of [bundle, clientBundle]) if (fs.existsSync(file)) fs.chmodSync(file, 0o644);
    fs.rmSync(root, { recursive: true, force: true });
  }
} else {
  assert.match(path.basename(suppliedRoot), /^athena-whatsapp-relay-[a-zA-Z0-9]+$/);
  assert.equal(fs.realpathSync(path.dirname(suppliedRoot)), fs.realpathSync(os.tmpdir()));
  assert.equal(process.env.HOME, path.join(suppliedRoot, 'home'));
  assert.equal(process.env.USERPROFILE, process.env.HOME);
  assert.equal(os.homedir(), process.env.HOME);
  assert.equal(process.env.DASH_DATA, path.join(suppliedRoot, 'data'));
  await proof(suppliedRoot, process.argv[2]);
}

async function proof(root: string, mode: string | undefined): Promise<void> {
  assert.ok(mode === 'write' || mode === 'intake' || mode === 'read');
  const { Miniflare, Log, LogLevel } = await import('miniflare');
  const business = '100000000000001';
  const phone = '200000000000001';
  const appSecret = 'FAKE_META_APPLICATION_SECRET';
  const admin = 'a'.repeat(64);
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: business,
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: phone },
              messages: [
                {
                  id: 'wamid.proof',
                  from: '436641234567',
                  from_user_id: 'AT.PROOF',
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: 'Relay proof' },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const mf = new Miniflare({
    modules: true,
    modulesRoot: path.join(root, 'app'),
    rootPath: root,
    scriptPath: path.join(root, 'app', 'worker.mjs'),
    compatibilityDate: '2026-07-30',
    durableObjects: { QUEUE: { className: 'WhatsAppRelayQueue', useSQLite: true } },
    durableObjectsPersist: path.join(root, 'data', 'queue'),
    log: new Log(LogLevel.NONE),
    bindings: {
      BUSINESS_ACCOUNT_ID: business,
      PHONE_NUMBER_ID: phone,
      META_APP_SECRET: appSecret,
      META_VERIFY_TOKEN: 'FAKE_META_VERIFY_TOKEN',
      RELAY_ADMIN_KEY: admin,
    },
  });
  const call = (route: string, body?: unknown, token?: string, lease?: string) =>
    mf.dispatchFetch(`https://relay.test${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(lease ? { 'x-relay-lease': lease } : {}),
      },
    });
  const webhook = (body = raw) =>
    mf.dispatchFetch('https://relay.test/webhooks/meta', {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': 'sha256=' + crypto.createHmac('sha256', appSecret).update(body).digest('hex'),
      },
    });
  const clientFile = path.join(root, 'data', 'client.json');
  try {
    if (mode === 'write') {
      const pairing = await call('/admin/pairing', {}, admin);
      assert.equal(pairing.status, 200);
      const { code } = (await pairing.json()) as { code: string };
      const pairedResponse = await call('/v1/pair', { code });
      assert.equal(pairedResponse.status, 200);
      const paired = (await pairedResponse.json()) as GatewayWhatsAppRelayStatus & { token: string };
      assert.equal((await webhook()).status, 200);
      fs.writeFileSync(clientFile, JSON.stringify(paired), { mode: 0o600 });
    } else {
      const client = JSON.parse(fs.readFileSync(clientFile, 'utf8')) as GatewayWhatsAppRelayStatus & { token: string };
      type Application = typeof import('../server/gateways/whatsapp-relay.ts') &
        typeof import('../server/gateways/inbox.ts') &
        typeof import('../server/gateways/state.ts') &
        typeof import('../server/gateways/instances.ts') &
        typeof import('../server/store.ts');
      const app = (await import(pathToFileURL(path.join(root, 'app', 'client.mjs')).href)) as Application;
      const instanceFile = path.join(root, 'data', 'instance.json');
      const instance =
        mode === 'intake'
          ? app.saveGatewayInstance({
              name: 'WhatsApp local proof',
              platform: 'whatsapp',
              accountId: phone,
              projectId: app.listProjects()[0].id,
              target: { kind: 'brain' },
              senderPolicy: { platform: 'whatsapp', allowedPhones: ['+436641234567'] },
              scope: { directMessages: true, conversationIds: [], guildIds: [] },
              fileLimits: { perFileBytes: 1024, perMessageBytes: 2048, filesPerMessage: 2, dailyBytes: 4096 },
              enabled: true,
            })
          : app.getGatewayInstance(JSON.parse(fs.readFileSync(instanceFile, 'utf8')) as string);
      const state = new app.GatewayStateAdapter(instance.id);
      await state.connect();
      let consumer: InstanceType<Application['WhatsAppRelayConsumer']> | undefined;
      try {
        const inbox = new app.GatewayInbox(state);
        if (mode === 'intake') {
          fs.writeFileSync(instanceFile, JSON.stringify(instance.id));
          inbox.bindWhatsAppRelayConnection(
            {
              origin: 'https://relay.test',
              installationId: client.installationId,
              businessAccountId: business,
              phoneNumberId: phone,
              epoch: client.epoch,
            },
            client.cursor,
          );
        }
        consumer = new app.WhatsAppRelayConsumer({
          inbox,
          token: client.token,
          appSecret,
          request: async (url, init) => {
            assert.equal(new URL(url).origin, 'https://relay.test');
            assert.equal(init.redirect, 'error');
            const response = await mf.dispatchFetch(url, {
              method: init.method,
              body: typeof init.body === 'string' ? init.body : undefined,
              headers: Object.fromEntries(new Headers(init.headers)),
              signal: init.signal,
            });
            if (url.endsWith('/v1/ack')) {
              assert.equal(inbox.whatsAppRelayState()!.receipt!.confirmed, false);
              assert.equal(inbox.claimNext(), null);
              if (mode === 'intake') throw new Error('Lost ACK response after the remote commit');
            }
            return new Response(await response.arrayBuffer(), {
              status: response.status,
              headers: Object.fromEntries(response.headers),
            });
          },
        });
        if (mode === 'intake') {
          await assert.rejects(consumer.poll(), /could not connect/);
          assert.equal(inbox.list().length, 1);
          assert.equal(inbox.whatsAppRelayState()!.receipt!.confirmed, false);
          assert.equal(inbox.claimNext(), null);
        } else {
          assert.equal(inbox.whatsAppRelayState()!.receipt!.confirmed, false);
          assert.equal(await consumer.poll(), 0);
          assert.equal(inbox.whatsAppRelayState()!.cursor, 1);
          assert.equal(inbox.claimNext()!.input.text, 'Relay proof');
          assert.equal(inbox.claimNext(), null);
          const ingest = async (field: string, value: Record<string, unknown>, after: number) => {
            const payload = JSON.stringify({
              object: 'whatsapp_business_account',
              entry: [
                {
                  id: business,
                  changes: [
                    {
                      field,
                      value: {
                        messaging_product: 'whatsapp',
                        metadata: { phone_number_id: phone },
                        ...value,
                      },
                    },
                  ],
                },
              ],
            });
            assert.equal((await webhook(payload)).status, 200);
            assert.equal(inbox.whatsAppRelayState()!.cursor, after);
            assert.equal(await consumer!.poll(), 1);
          };
          await ingest(
            'messages',
            {
              messages: [
                {
                  id: 'wamid.hidden',
                  from_user_id: 'AT.PROOF',
                  timestamp: '1700000001',
                  type: 'text',
                  text: { body: 'Phone hidden' },
                },
              ],
            },
            1,
          );
          assert.equal(inbox.list()[1].input.actor.id, '+436641234567');
          assert.equal(inbox.list()[1].bindingId, inbox.list()[0].bindingId);
          await ingest(
            'user_id_update',
            { user_id_update: [{ timestamp: '1700000010', user_id: { previous: 'AT.PROOF', current: 'AT.NEW' } }] },
            2,
          );
          assert.ok(inbox.list().every((event) => event.status === 'needs-review'));
          assert.equal(inbox.claimNext(), null);
          assert.equal(inbox.whatsAppRelayState()!.identities!.users.find((user) => user.id === 'AT.NEW')!.phone, null);
          assert.equal((await webhook()).status, 200);
          assert.equal(await consumer.poll(), 0);
          assert.equal((await call('/admin/revoke', { acknowledgeDrop: true }, admin)).status, 200);
          assert.equal((await call('/v1/status', undefined, client.token)).status, 401);
        }
      } finally {
        await consumer?.stop();
        await state.disconnect();
      }
    }
  } finally {
    await mf.dispose();
  }
}
