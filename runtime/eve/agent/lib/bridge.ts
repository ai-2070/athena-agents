import { z } from 'zod';
import type { DynamicModelContext } from 'eve';
import type { EveRuntimeConfiguration } from '../../../../shared/types.ts';
import { usage } from 'eve/events';

const configSchema = z.object({
  runId: z.string().min(1),
  model: z.string().min(1),
  baseUrl: z.url(),
  apiKey: z.string(),
  headers: z.record(z.string(), z.string()).default({}),
  instructions: z.string(),
  contextWindow: z.number().int().positive(),
  provider: z.string().min(1),
  effort: z.enum(['', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']),
  temperature: z.number().min(0).max(2).optional(),
  cacheKey: z.string().min(1),
  maxModelSteps: z.number().int().positive(),
  costLimitUsd: z.number().nonnegative(),
  costBaseline: z.number().nonnegative(),
  spentUsd: z.number().nonnegative().optional(),
  capabilities: z.object({ tools: z.boolean().optional(), vision: z.boolean().optional(), multipleImages: z.boolean().optional() }).optional(),
  price: z.object({ in: z.number().nonnegative(), out: z.number().nonnegative(), cached: z.number().nonnegative().optional() }).nullable().optional(),
  tools: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.json()) })),
});

export async function bridgeCall(binding: string, operation: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
  const origin = process.env.ATHENA_EVE_BRIDGE_URL;
  const secret = process.env.ATHENA_EVE_BRIDGE_TOKEN;
  if (!origin || !secret) throw new Error('The Athena tool bridge is not configured.');
  const url = new URL(operation, origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== new URL(origin).origin) throw new Error('The Athena tool bridge must be local.');
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
    body: JSON.stringify({ binding, ...(body === undefined ? {} : { input: body }) }),
    redirect: 'error',
    signal: signal || AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`The Athena tool bridge refused the request (${response.status}).`);
  return response.json();
}

export function bindingOf(ctx: DynamicModelContext): string {
  const binding = ctx.session.auth.current?.attributes?.binding;
  if (typeof binding !== 'string' || !binding) throw new Error('This session has no Athena binding.');
  return binding;
}

export async function configuration(ctx: DynamicModelContext): Promise<EveRuntimeConfiguration> {
  const nativeCost = usage(ctx.view).byKind.model?.costUsd || 0;
  return configSchema.parse(await bridgeCall(bindingOf(ctx), '/configuration', { sessionId: ctx.session.id, nativeCost }));
}
