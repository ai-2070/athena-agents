// Chat gateways (shared/api/gateways.ts). server/gateways/ refuses what it can't do in plain words; those are 400s.
import { implement } from '@orpc/server';
import { gateways as contract } from '../../shared/api/gateways.ts';
import { agents, listProjects, withProject, workflows } from '../store.ts';
import { getInstance, removeInstance, saveInstance, setEnabled, setTokens } from '../gateways/store.ts';
import { gateways } from '../gateways/supervisor.ts';
import { refuse, refusing } from './refuse.ts';

const os = implement(contract);
const ok = { ok: true as const };

export const gatewaysRouter = os.router({
  list: os.list.handler(() => gateways.listing()),
  targets: os.targets.handler(({ input }) => {
    const project = listProjects().find((p) => p.id === input.projectId) || refuse('That project is gone.', 404);
    return withProject(project, () => ({
      agents: agents.list().map((a) => ({ id: a.id, name: a.name })),
      teams: workflows.list().map((t) => ({ id: t.id, name: t.name })),
    }));
  }),
  save: os.save.handler(({ input: { id, ...change } }) => refusing(() => saveInstance(change, id))),
  tokens: os.tokens.handler(({ input: { id, ...tokens } }) => refusing(() => (setTokens(id, tokens), ok))),
  enable: os.enable.handler(({ input }) => refusing(() => setEnabled(input.id, input.enabled))),
  reconnect: os.reconnect.handler(({ input }) => refusing(() => (gateways.reconnect(input.id), ok))),
  remove: os.remove.handler(({ input }) => refusing(() => (removeInstance(input.id), ok))),
  allow: os.allow.handler(({ input }) =>
    refusing(() => {
      const instance = getInstance(input.id);
      const list = input.kind === 'user' ? instance.users : instance.channels;
      const saved = saveInstance(
        { ...instance, [input.kind === 'user' ? 'users' : 'channels']: [...list, input.value] },
        instance.id,
      );
      gateways.forgetRefused(instance.id, input.kind, input.value);
      return saved;
    }),
  ),
  messages: os.messages.handler(({ input }) => refusing(() => gateways.messages(input.id))),
  retry: os.retry.handler(({ input }) => refusing(() => (gateways.retry(input.id, input.messageId), ok))),
  dismiss: os.dismiss.handler(({ input }) => refusing(() => (gateways.dismiss(input.id, input.messageId), ok))),
});
