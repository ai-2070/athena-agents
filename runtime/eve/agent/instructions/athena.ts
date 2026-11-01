import { defineDynamic, defineInstructions } from 'eve/instructions';
import { configuration } from '../lib/bridge.ts';

export default defineDynamic(async (ctx) => defineInstructions({ role: 'system', content: (await configuration(ctx)).instructions }));
