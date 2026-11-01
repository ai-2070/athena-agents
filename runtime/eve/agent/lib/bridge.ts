import { z } from 'zod';
import type { DynamicModelContext } from 'eve';

const configSchema = z.object({
  model: z.string().min(1),
  baseUrl: z.url(),
  apiKey: z.string(),
  instructions: z.string(),
  contextWindow: z.number().int().positive(),
  tools: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.json()) })),
});

export async function bridgeCall(binding: string, operation: string, body?: unknown): Promise<unknown> {
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
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`The Athena tool bridge refused the request (${response.status}).`);
  return response.json();
}

export function bindingOf(ctx: DynamicModelContext): string {
  const binding = ctx.session.auth.current?.attributes?.binding;
  if (typeof binding !== 'string' || !binding) throw new Error('This session has no Athena binding.');
  return binding;
}

export async function configuration(ctx: DynamicModelContext) {
  return configSchema.parse(await bridgeCall(bindingOf(ctx), '/configuration'));
}
